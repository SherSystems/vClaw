// ============================================================
// RHODES — Slack inbound routes (shim → RHODES)
//
// Three endpoints that receive normalized Slack callbacks from the
// Fly.io shim service. The shim has already verified the Slack
// request signature, so these endpoints trust the request shape
// and treat its origin (`slack:<user_id>`) as a system actor for
// audit purposes. Operator role is NOT enforced here — that's the
// shim's responsibility upstream.
//
//   POST /api/integrations/slack/command   — slash command
//   POST /api/integrations/slack/interact  — button click
//   POST /api/integrations/slack/events    — event envelope
//
// All three respond within Slack's 3-second window. Anything that
// can't return immediately (e.g. the agent's planning phase) is
// fire-and-forget; the agent posts results back to Slack later via
// the SlackProvider on the outbound side.
//
// Sibling concerns NOT handled here (deliberate):
//   - request signature verification (shim does it)
//   - Slack user → RHODES user mapping (separate commit on the auth
//     store; we just stamp `slack:<user_id>` for audit until then)
//   - outbound replies / post-decision message updates (slack
//     provider, called by the agent flow)
// ============================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AuditLog } from "../../governance/audit.js";
import type { AuditEntry } from "../../types.js";

// ── Public surface ────────────────────────────────────────────

/**
 * Wiring point for the slack inbound routes. The dashboard server
 * supplies live references so handlers can read healthz / approvals
 * state and fire the agent command without depending on the full
 * DashboardServer class shape.
 */
export interface SlackRoutesContext {
  /** Audit sink for every inbound call. */
  audit?: AuditLog;
  /** Returns RHODES healthz summary (same payload as /api/healthz). */
  getHealthz: () => Record<string, unknown>;
  /** List incidents currently open. Same shape as IncidentManager.getOpen(). */
  getOpenIncidents: () => Array<{ id: string; severity: string; description: string; detected_at: string }>;
  /** List pending approvals. Same shape as ApprovalGate.getPendingApprovals(). */
  getPendingApprovals: () => Array<{
    plan_id: string;
    step_id?: string;
    action: string;
    tier: string;
    requested_at: string;
    reasoning: string;
  }>;
  /** Fire a free-form agent command. Returns a promise so the caller can
   *  fire-and-forget or await depending on the 3s budget. */
  runAgentCommand: (
    command: string,
    meta: { source: "slack"; slack_user_id?: string; slack_channel?: string; slack_thread_ts?: string },
  ) => Promise<unknown>;
  /** Submit an approval/rejection decision against the gate. Matches
   *  `ApprovalGate.submitApiDecision` semantics. */
  submitApprovalDecision: (
    planId: string,
    decision: "approve" | "reject",
    operator: string,
    stepId?: string,
  ) => { ok: boolean };
  /** Optional bot user id for self-loop detection (event.user === botUserId). */
  getBotUserId?: () => string | undefined;
}

/** The handlers exposed by `createSlackRouter`. */
export interface SlackRouterHandlers {
  handleSlackCommand: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleSlackInteract: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleSlackEvents: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

// ── Router factory ────────────────────────────────────────────

export function createSlackRouter(ctx: SlackRoutesContext): SlackRouterHandlers {
  return {
    handleSlackCommand: (req, res) => handleSlackCommand(req, res, ctx),
    handleSlackInteract: (req, res) => handleSlackInteract(req, res, ctx),
    handleSlackEvents: (req, res) => handleSlackEvents(req, res, ctx),
  };
}

// ── Handler 1: slash command ──────────────────────────────────

export async function handleSlackCommand(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SlackRoutesContext,
): Promise<void> {
  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    sendJson(res, { error: "invalid_body" }, 400);
    return;
  }

  const text = (form.get("text") ?? "").trim();
  const userId = form.get("user_id") ?? "";
  const channelId = form.get("channel_id") ?? "";
  const userName = form.get("user_name") ?? "";

  const subcommand = parseSubcommand(text);
  recordAudit(ctx, {
    action: "slack.command",
    params: {
      slack_user_id: userId,
      slack_user_name: userName,
      slack_channel_id: channelId,
      subcommand: subcommand.kind,
      text,
    },
  });

  switch (subcommand.kind) {
    case "help":
      sendBlockKit(res, buildHelpBlocks());
      return;

    case "status":
      sendBlockKit(res, buildStatusBlocks(ctx.getHealthz()));
      return;

    case "incidents":
      sendBlockKit(res, buildIncidentsBlocks(ctx.getOpenIncidents()));
      return;

    case "approvals":
      sendBlockKit(res, buildApprovalsBlocks(ctx.getPendingApprovals()));
      return;

    case "investigate": {
      const prompt = buildInvestigatePrompt(subcommand.target);
      // Fire-and-forget — the agent posts results back via the slack
      // provider on the outbound path. We have ~3s before Slack
      // times out, so we MUST respond before the agent finishes.
      void runAgentSafely(ctx, prompt, {
        source: "slack",
        slack_user_id: userId,
        slack_channel: channelId,
      });
      sendBlockKit(res, buildPlanningBlocks(`investigating VM \`${subcommand.target}\``));
      return;
    }

    case "freeform": {
      void runAgentSafely(ctx, subcommand.text, {
        source: "slack",
        slack_user_id: userId,
        slack_channel: channelId,
      });
      sendBlockKit(res, buildPlanningBlocks(subcommand.text));
      return;
    }
  }
}

// ── Handler 2: interactivity ──────────────────────────────────

export async function handleSlackInteract(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SlackRoutesContext,
): Promise<void> {
  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    sendJson(res, { error: "invalid_body" }, 400);
    return;
  }

  const rawPayload = form.get("payload");
  if (!rawPayload) {
    sendJson(res, { error: "missing_payload" }, 400);
    return;
  }

  let payload: SlackInteractivityPayload;
  try {
    payload = JSON.parse(rawPayload) as SlackInteractivityPayload;
  } catch {
    sendJson(res, { error: "invalid_payload_json" }, 400);
    return;
  }

  const action = payload.actions?.[0];
  const actionId = action?.action_id ?? "";
  const userId = payload.user?.id ?? "";

  recordAudit(ctx, {
    action: "slack.interact",
    params: {
      slack_user_id: userId,
      slack_team_id: payload.team?.id,
      action_id: actionId,
    },
  });

  if (actionId === "rhodes_approve" || actionId === "rhodes_reject") {
    const decision: "approve" | "reject" =
      actionId === "rhodes_approve" ? "approve" : "reject";

    let parsed: { plan_id?: string; step_id?: string } = {};
    try {
      parsed = JSON.parse(action?.value ?? "{}") as { plan_id?: string; step_id?: string };
    } catch {
      sendJson(res, { error: "invalid_action_value" }, 400);
      return;
    }
    const planId = parsed.plan_id?.trim();
    if (!planId) {
      sendJson(res, { error: "missing_plan_id" }, 400);
      return;
    }

    const operator = `slack:${userId || "unknown"}`;
    const outcome = ctx.submitApprovalDecision(
      planId,
      decision,
      operator,
      parsed.step_id && parsed.step_id.length > 0 ? parsed.step_id : undefined,
    );

    if (!outcome.ok) {
      sendBlockKit(res, buildEphemeralBlocks(
        `:warning: Couldn't find plan \`${planId}\` in the approval queue. It may have already resolved.`,
      ));
      return;
    }

    const verb = decision === "approve" ? "Approved" : "Rejected";
    sendBlockKit(res, buildEphemeralBlocks(
      `:white_check_mark: ${verb} plan \`${planId}\` as \`${operator}\`.`,
    ));
    return;
  }

  // URL buttons (rhodes_dashboard_link, etc.) — Slack opens these
  // natively in-browser; the callback to us is informational.
  sendJson(res, { ok: true }, 200);
}

// ── Handler 3: events ─────────────────────────────────────────

export async function handleSlackEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SlackRoutesContext,
): Promise<void> {
  let body: SlackEventEnvelope;
  try {
    body = (await readJson(req)) as SlackEventEnvelope;
  } catch {
    sendJson(res, { error: "invalid_body" }, 400);
    return;
  }

  // Defensive — the shim already terminates url_verification, but
  // a misconfigured deployment could route it here. Slack requires
  // an immediate `{challenge}` echo.
  if (body.type === "url_verification") {
    sendJson(res, { challenge: body.challenge ?? "" }, 200);
    return;
  }

  const event = body.event;
  if (!event || typeof event !== "object") {
    sendJson(res, { ok: true }, 200);
    return;
  }

  // Self-loop guard: drop anything originating from the bot itself.
  // Historical Slack incidents have been caused by bots replying to
  // their own messages — refuse to participate.
  const botUserId = ctx.getBotUserId?.();
  if (event.bot_id || (botUserId && event.user === botUserId)) {
    recordAudit(ctx, {
      action: "slack.event.dropped_self",
      params: { event_type: event.type ?? "unknown" },
    });
    sendJson(res, { ok: true }, 200);
    return;
  }

  if (event.type === "app_mention") {
    const stripped = stripLeadingMention(event.text ?? "");
    if (stripped.length > 0) {
      void runAgentSafely(ctx, stripped, {
        source: "slack",
        slack_user_id: event.user,
        slack_channel: event.channel,
        slack_thread_ts: event.ts,
      });
    }
    recordAudit(ctx, {
      action: "slack.event.app_mention",
      params: {
        slack_user_id: event.user ?? "",
        slack_channel: event.channel ?? "",
        text: stripped,
      },
    });
    sendJson(res, { ok: true }, 200);
    return;
  }

  if (event.type === "message" && event.channel_type === "im") {
    const text = (event.text ?? "").trim();
    if (text.length > 0 && event.user) {
      void runAgentSafely(ctx, text, {
        source: "slack",
        slack_user_id: event.user,
        slack_channel: event.channel,
      });
    }
    recordAudit(ctx, {
      action: "slack.event.message_im",
      params: {
        slack_user_id: event.user ?? "",
        slack_channel: event.channel ?? "",
        text,
      },
    });
    sendJson(res, { ok: true }, 200);
    return;
  }

  // Anything else: log & drop.
  recordAudit(ctx, {
    action: "slack.event.dropped",
    params: { event_type: event.type ?? "unknown" },
  });
  sendJson(res, { ok: true }, 200);
}

// ── Subcommand parser ─────────────────────────────────────────

export type Subcommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "incidents" }
  | { kind: "approvals" }
  | { kind: "investigate"; target: string }
  | { kind: "freeform"; text: string };

export function parseSubcommand(text: string): Subcommand {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "help" };

  // First token (case-insensitive) decides the verb.
  const space = trimmed.search(/\s/);
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

  switch (head) {
    case "help":
    case "?":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "incidents":
      return { kind: "incidents" };
    case "approvals":
      return { kind: "approvals" };
    case "investigate":
      // `/rhodes investigate` with no target falls through to freeform
      // help — sending a Slack user back to the agent with the literal
      // word "investigate" isn't useful.
      if (rest.length === 0) return { kind: "help" };
      return { kind: "investigate", target: rest };
    default:
      return { kind: "freeform", text: trimmed };
  }
}

function buildInvestigatePrompt(target: string): string {
  return `Investigate VM ${target}: check current state, recent metrics, open incidents, and any recent alerts. Summarize health and suggest remediation if anything is wrong.`;
}

// ── Block Kit builders (exported for tests) ───────────────────

export function buildHelpBlocks(): unknown[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "RHODES — slash command reference", emoji: false },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "• `/rhodes status` — current version, mode, providers, open incidents",
          "• `/rhodes incidents` — list active incidents, click to remediate",
          "• `/rhodes approvals` — list pending plans, click to approve/reject",
          "• `/rhodes investigate <vmid>` — kick the agent to diagnose a VM",
          "• `/rhodes <any natural-language>` — talk to RHODES. plan returns asynchronously.",
        ].join("\n"),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Buttons in alerts require admin role (see `/api/auth/whoami`).",
        },
      ],
    },
  ];
}

export function buildStatusBlocks(healthz: Record<string, unknown>): unknown[] {
  const version = String(healthz.version ?? "unknown");
  const uptimeS = Number(healthz.uptime_s ?? 0);
  const openIncidents = Number(healthz.open_incidents ?? 0);
  const playbooks = Number(healthz.registered_playbooks ?? 0);
  const dryRun = Boolean(healthz.dry_run);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "RHODES — status", emoji: false },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Version*\n${escapeMrkdwn(version)}` },
        { type: "mrkdwn", text: `*Uptime*\n${formatUptime(uptimeS)}` },
        { type: "mrkdwn", text: `*Mode*\n${dryRun ? "shadow (dry-run)" : "live"}` },
        { type: "mrkdwn", text: `*Open incidents*\n${openIncidents}` },
        { type: "mrkdwn", text: `*Registered playbooks*\n${playbooks}` },
      ],
    },
  ];
}

export function buildIncidentsBlocks(
  incidents: Array<{ id: string; severity: string; description: string; detected_at: string }>,
): unknown[] {
  if (incidents.length === 0) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: ":white_check_mark: No active incidents." },
      },
    ];
  }

  const header: unknown = {
    type: "header",
    text: { type: "plain_text", text: `RHODES — ${incidents.length} active incident(s)`, emoji: false },
  };

  const items: unknown[] = [];
  for (const inc of incidents.slice(0, 20)) {
    items.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMrkdwn(inc.severity)}* — ${escapeMrkdwn(inc.description)}\n_id_: \`${escapeMrkdwn(inc.id)}\` · _detected_: ${escapeMrkdwn(inc.detected_at)}`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Remediate", emoji: false },
        action_id: "rhodes_remediate",
        value: JSON.stringify({ incident_id: inc.id }),
      },
    });
  }

  return [header, ...items];
}

export function buildApprovalsBlocks(
  approvals: Array<{
    plan_id: string;
    step_id?: string;
    action: string;
    tier: string;
    requested_at: string;
    reasoning: string;
  }>,
): unknown[] {
  if (approvals.length === 0) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: ":white_check_mark: No pending approvals." },
      },
    ];
  }

  const header: unknown = {
    type: "header",
    text: { type: "plain_text", text: `RHODES — ${approvals.length} pending approval(s)`, emoji: false },
  };

  const items: unknown[] = [];
  for (const a of approvals.slice(0, 10)) {
    const value = JSON.stringify({ plan_id: a.plan_id, step_id: a.step_id });
    items.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeMrkdwn(a.tier)}* · \`${escapeMrkdwn(a.action)}\`\n${escapeMrkdwn(truncate(a.reasoning, 500))}\n_plan_: \`${escapeMrkdwn(a.plan_id)}\`${a.step_id ? ` · _step_: \`${escapeMrkdwn(a.step_id)}\`` : ""}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Approve", emoji: false },
            action_id: "rhodes_approve",
            value,
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Reject", emoji: false },
            action_id: "rhodes_reject",
            value,
          },
        ],
      },
    );
  }

  return [header, ...items];
}

export function buildPlanningBlocks(goal: string): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:thinking_face: Planning — ${escapeMrkdwn(truncate(goal, 200))}\n_RHODES will post the plan back here when it lands._`,
      },
    },
  ];
}

export function buildEphemeralBlocks(text: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];
}

// ── Internal helpers ──────────────────────────────────────────

/** Slack messages returned to a slash command default to `ephemeral`
 *  (visible only to the invoking user) when `response_type` is set. */
function sendBlockKit(res: ServerResponse, blocks: unknown[]): void {
  const payload = {
    response_type: "ephemeral",
    blocks,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendJson(res: ServerResponse, body: unknown, status: number): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readRaw(req);
  return new URLSearchParams(raw);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on("end", () => {
      try {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Strip a leading Slack user mention like `<@U12345>` (with optional
 *  trailing whitespace) from the start of a message. */
export function stripLeadingMention(text: string): string {
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/i, "").trim();
}

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function formatUptime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "unknown";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const mins = Math.floor((s % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function recordAudit(
  ctx: SlackRoutesContext,
  partial: { action: string; params: Record<string, unknown> },
): void {
  if (!ctx.audit) return;
  const entry: AuditEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    action: partial.action,
    tier: "read",
    reasoning: "Slack-relayed callback",
    params: partial.params,
    result: "success",
    duration_ms: 0,
  };
  try {
    ctx.audit.log(entry);
  } catch (err) {
    console.error("[slack-routes] audit log failed:", err);
  }
}

/** Wrap runAgentCommand so a thrown error in the agent path can't crash
 *  the dispatcher Promise (fire-and-forget). */
function runAgentSafely(
  ctx: SlackRoutesContext,
  command: string,
  meta: { source: "slack"; slack_user_id?: string; slack_channel?: string; slack_thread_ts?: string },
): Promise<unknown> {
  return Promise.resolve()
    .then(() => ctx.runAgentCommand(command, meta))
    .catch((err) => {
      console.error("[slack-routes] runAgentCommand failed:", err);
      return undefined;
    });
}

// ── Slack payload shapes (minimal — only fields we read) ──────

interface SlackInteractivityPayload {
  type?: string;
  user?: { id?: string; username?: string };
  team?: { id?: string };
  actions?: Array<{
    action_id?: string;
    value?: string;
    type?: string;
  }>;
  response_url?: string;
  trigger_id?: string;
}

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: SlackInnerEvent;
  event_id?: string;
  event_time?: number;
}

interface SlackInnerEvent {
  type?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  bot_id?: string;
  subtype?: string;
}
