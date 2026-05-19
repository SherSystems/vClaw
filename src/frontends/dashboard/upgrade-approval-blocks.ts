// ============================================================
// RHODES — Slack Block-Kit builders for UpgradePlan approvals
//
// When the orchestrator creates a new UpgradePlan (v0.7 cluster
// upgrades), we post a card to #rhodes-approvals asking an operator
// to Approve or Reject before the runner walks the per-host FSM.
//
// These builders are pure functions (no I/O, no LLM, no network) so
// the interactivity handler, the notifications provider, and the
// dashboard SSE stream can all share the same Block-Kit shapes.
//
// Visual style matches the v0.5.0 outbound conventions:
//   - `:gear:` for the header card (upgrade kicking off)
//   - `:white_check_mark:` for the approved confirmation
//   - `:no_entry:` for the rejected confirmation
//   - mrkdwn fields with `*Label*\nvalue` layout
//   - snake_case action_ids, value carries the planId verbatim
//     (no JSON wrapper — Slack fills in the user from the payload)
//
// Notes on cluster id rendering: Graph Resource.ids look like
// `proxmox:proxmox_cluster:prod`. We surface the last colon-segment
// (`prod`) in the header for at-a-glance recognition, and keep the
// full id as a smaller follow-up line so operators can grep dashboard
// logs against it.
// ============================================================

import type {
  HostUpgradeState,
  UpgradeEvent,
  UpgradePhase,
  UpgradePlan,
  UpgradeRun,
} from "../../orchestrator/types.js";

// ── Action contract ─────────────────────────────────────────

/**
 * action_id strings the interactivity handler matches on. Kept as a
 * frozen object so the handler can `switch` against
 * `UPGRADE_ACTION_IDS.APPROVE` instead of magic strings.
 */
export const UPGRADE_ACTION_IDS = {
  APPROVE: "upgrade_approve",
  REJECT: "upgrade_reject",
} as const;

export type UpgradeActionId =
  (typeof UPGRADE_ACTION_IDS)[keyof typeof UPGRADE_ACTION_IDS];

// ── Public API ──────────────────────────────────────────────

export interface UpgradeApprovalBlocksOptions {
  /** If provided, a context block with `View plan: <url>/?plan=<id>` is appended. */
  dashboardBaseUrl?: string;
}

export interface UpgradeApprovedBlocksOptions {
  /** Who approved (operator email or Slack user id). */
  approver: string;
  /** Optional dashboard URL — same shape as the approval card. */
  dashboardBaseUrl?: string;
}

export interface UpgradeRejectedBlocksOptions {
  /** Who rejected (operator email or Slack user id). */
  rejector: string;
  /** Optional human-readable reason. */
  reason?: string;
}

/**
 * Build the Block-Kit card posted to #rhodes-approvals when a new
 * UpgradePlan is created and is waiting on operator approval.
 *
 * Block layout:
 *   - header (`:gear: Upgrade plan ready for approval — <cluster>`)
 *   - section (cluster id full, source→target, hosts count, mode, plan id, created by)
 *   - divider
 *   - section (host list, capped at 10 with `+N more` overflow)
 *   - actions (Approve primary / Reject danger — value = planId)
 *   - context (dashboard link — only if dashboardBaseUrl provided)
 */
export function buildUpgradeApprovalBlocks(
  plan: UpgradePlan,
  opts: UpgradeApprovalBlocksOptions = {},
): unknown[] {
  const clusterShort = shortClusterName(plan.clusterResourceId);
  const headerText = truncate(
    `:gear: Upgrade plan ready for approval — ${clusterShort}`,
    150,
  );

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Cluster*\n${escapeMrkdwn(clusterShort)}\n\`${escapeMrkdwn(plan.clusterResourceId)}\``,
        },
        {
          type: "mrkdwn",
          text: `*Version*\n${escapeMrkdwn(plan.sourceVersion)} → ${escapeMrkdwn(plan.targetVersion)}`,
        },
        {
          type: "mrkdwn",
          text: `*Hosts*\n${plan.hostResourceIds.length}`,
        },
        {
          type: "mrkdwn",
          text: `*Evacuation*\n${escapeMrkdwn(plan.evacuationMode)}`,
        },
        {
          type: "mrkdwn",
          text: `*Plan id*\n\`${escapeMrkdwn(plan.id)}\``,
        },
        {
          type: "mrkdwn",
          text: `*Created by*\n${escapeMrkdwn(plan.createdBy)}`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Hosts (in order)*\n${formatHostList(plan.hostResourceIds)}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: false },
          action_id: UPGRADE_ACTION_IDS.APPROVE,
          value: plan.id,
          // Slack requires confirm.text to be plain_text — passing
          // mrkdwn here causes the confirm modal to render literal
          // asterisks AND silently drops the interactivity callback
          // when the user clicks the modal's Approve button. Caught
          // 2026-05-19 during the first end-to-end NUC demo.
          confirm: {
            title: { type: "plain_text", text: "Confirm approval" },
            text: {
              type: "plain_text",
              text: `Approve upgrade of ${clusterShort} to ${plan.targetVersion} across ${plan.hostResourceIds.length} host(s)?`,
            },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Reject", emoji: false },
          action_id: UPGRADE_ACTION_IDS.REJECT,
          value: plan.id,
        },
      ],
    },
  ];

  const ctx = buildDashboardContext(opts.dashboardBaseUrl, plan.id);
  if (ctx) blocks.push(ctx);

  return blocks;
}

/**
 * Thread reply posted when an UpgradePlan is approved and the runner
 * kicks off a new UpgradeRun. Short — operators already saw the full
 * card above; this is the "lights are on" confirmation.
 */
export function buildUpgradeApprovedBlocks(
  plan: UpgradePlan,
  run: UpgradeRun,
  opts: UpgradeApprovedBlocksOptions,
): unknown[] {
  const clusterShort = shortClusterName(plan.clusterResourceId);
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `:white_check_mark: *Approved* by ${escapeMrkdwn(opts.approver)} — upgrade of *${escapeMrkdwn(clusterShort)}* started.`,
          `_run_: \`${escapeMrkdwn(run.id)}\` · _plan_: \`${escapeMrkdwn(plan.id)}\``,
        ].join("\n"),
      },
    },
  ];

  const ctx = buildDashboardContext(opts.dashboardBaseUrl, plan.id);
  if (ctx) blocks.push(ctx);

  return blocks;
}

/**
 * Thread reply posted when an operator rejects an UpgradePlan. Short,
 * carries who + why so the audit log is grep-able from Slack alone.
 */
export function buildUpgradeRejectedBlocks(
  plan: UpgradePlan,
  opts: UpgradeRejectedBlocksOptions,
): unknown[] {
  const clusterShort = shortClusterName(plan.clusterResourceId);
  const reasonLine = opts.reason && opts.reason.trim().length > 0
    ? `\n_reason_: ${escapeMrkdwn(truncate(opts.reason, 500))}`
    : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `:no_entry: *Rejected* by ${escapeMrkdwn(opts.rejector)} — upgrade of *${escapeMrkdwn(clusterShort)}* will not run.`,
          `_plan_: \`${escapeMrkdwn(plan.id)}\`${reasonLine}`,
        ].join("\n"),
      },
    },
  ];
}

/**
 * v0.7.3.1 — Describe an FSM transition in one human-readable line for
 * posting to the approval card's Slack thread. Returns `null` when the
 * transition isn't operator-interesting (e.g., the FSM advanced a
 * sub-state for the same host that already had a thread reply this
 * step) — callers should skip the post in that case so we don't spam
 * the thread.
 *
 * The signal we care about:
 *   - preflight outcome (pass/fail)
 *   - per-host sub-state advancement (enter→evac→remediate→reboot→smoke→done)
 *   - host failure (with reason)
 *   - rollback outcome
 *   - terminal phase reached (completed / failed / aborted)
 *
 * Each message starts with an emoji prefix so operators can grep the
 * thread visually:
 *   :mag:          preflight
 *   :wrench:       host primitive step
 *   :white_check_mark: success / completion
 *   :x:            failure
 *   :leftwards_arrow_with_hook: rollback
 *   :tada:         all hosts done
 */
export function buildUpgradeProgressText(
  prev: UpgradeRun,
  next: UpgradeRun,
  event: UpgradeEvent,
  plan: UpgradePlan,
): string | null {
  // Phase transitions take priority — they're the loud moments.
  if (prev.phase !== next.phase) {
    return describePhaseTransition(prev.phase, next.phase, next, plan);
  }

  // Within the executing phase: per-host sub-state advances.
  if (event.kind === "host_step_succeeded") {
    return describeHostStepSucceeded(prev, next, plan);
  }

  if (event.kind === "host_step_failed") {
    return describeHostStepFailed(next, event.reason, plan);
  }

  // Other events without a phase change usually mean the FSM ignored
  // the event (already in terminal etc.) — nothing useful to post.
  return null;
}

function describePhaseTransition(
  prevPhase: UpgradePhase,
  nextPhase: UpgradePhase,
  next: UpgradeRun,
  plan: UpgradePlan,
): string | null {
  const cluster = shortClusterName(plan.clusterResourceId);
  switch (nextPhase) {
    case "preflight":
      return `:mag: Preflight starting for *${escapeMrkdwn(cluster)}* (${plan.hostResourceIds.length} hosts).`;
    case "executing": {
      // Came from preflight passing.
      if (prevPhase === "preflight" || prevPhase === "approved") {
        const first = plan.hostResourceIds[0];
        return `:white_check_mark: Preflight passed — starting host 1/${plan.hostResourceIds.length}: \`${escapeMrkdwn(first ?? "(none)")}\``;
      }
      return null;
    }
    case "rolling_back":
      return `:leftwards_arrow_with_hook: Rolling back — ${escapeMrkdwn(truncate(next.errorMessage ?? "(no reason)", 200))}`;
    case "completed":
      return `:tada: Upgrade complete — *${escapeMrkdwn(cluster)}* now on \`${escapeMrkdwn(plan.targetVersion)}\` (${plan.hostResourceIds.length}/${plan.hostResourceIds.length} hosts).`;
    case "failed": {
      const reason = next.errorMessage
        ? truncate(next.errorMessage, 400)
        : "(no reason recorded)";
      return `:x: Upgrade failed — ${escapeMrkdwn(reason)}`;
    }
    case "aborted":
      return `:no_entry: Upgrade aborted — ${escapeMrkdwn(truncate(next.errorMessage ?? "(no reason)", 200))}`;
    case "approved":
    case "pending":
      return null;
  }
}

function describeHostStepSucceeded(
  prev: UpgradeRun,
  next: UpgradeRun,
  plan: UpgradePlan,
): string | null {
  // Two interesting flavors:
  //  (a) sub-state advanced on the SAME host → progress for that host
  //  (b) host index advanced → previous host completed, next host begins
  const prevHost = prev.hosts[prev.currentHostIndex];
  const nextHost = next.hosts[next.currentHostIndex];
  if (!nextHost) return null;

  const total = plan.hostResourceIds.length;
  const oneIdx = next.currentHostIndex + 1;
  const hostShort = shortHostName(nextHost.hostResourceId);

  // (b) Host advanced (or first host moved into entering_maintenance after preflight)
  if (
    prev.currentHostIndex !== next.currentHostIndex &&
    prev.currentHostIndex >= 0 &&
    prevHost
  ) {
    const prevHostShort = shortHostName(prevHost.hostResourceId);
    return [
      `:white_check_mark: Host ${prev.currentHostIndex + 1}/${total} complete: \`${escapeMrkdwn(prevHostShort)}\``,
      `:wrench: Host ${oneIdx}/${total} starting: \`${escapeMrkdwn(hostShort)}\` — ${describeHostState(nextHost.state)}`,
    ].join("\n");
  }

  // (a) Same host, sub-state advanced
  return `:wrench: Host ${oneIdx}/${total} \`${escapeMrkdwn(hostShort)}\` — ${describeHostState(nextHost.state)}`;
}

function describeHostStepFailed(
  next: UpgradeRun,
  reason: string,
  plan: UpgradePlan,
): string {
  const host = next.hosts[next.currentHostIndex];
  const total = plan.hostResourceIds.length;
  const oneIdx = next.currentHostIndex + 1;
  const hostShort = host ? shortHostName(host.hostResourceId) : "(unknown)";
  return `:x: Host ${oneIdx}/${total} failed: \`${escapeMrkdwn(hostShort)}\` — ${escapeMrkdwn(truncate(reason, 400))}`;
}

function describeHostState(state: HostUpgradeState): string {
  switch (state) {
    case "pending":
      return "queued";
    case "entering_maintenance":
      return "entering maintenance";
    case "evacuating":
      return "evacuating workloads";
    case "remediating":
      return "remediating (applying upgrade)";
    case "awaiting_reboot":
      return "awaiting reboot";
    case "smoke_testing":
      return "smoke-testing";
    case "exiting_maintenance":
      return "exiting maintenance";
    case "completed":
      return "done";
    case "failed":
      return "failed";
  }
}

function shortHostName(hostResourceId: string): string {
  const segments = hostResourceId.split(":");
  const last = segments[segments.length - 1] || hostResourceId;
  return truncate(last, 40);
}

/**
 * Parse the `value` field carried back from an upgrade action button.
 * Today the value is just the planId verbatim (Slack fills in the user
 * from the payload itself), but this helper exists so callers don't
 * scatter `.trim()` checks across the interactivity handler — and so
 * we have a clean upgrade path if we ever wrap the value in JSON.
 *
 * Throws when the value is empty / whitespace / longer than 200 chars
 * (Slack's hard limit is 2000, but our plan ids are short UUIDs;
 * anything that long indicates a malformed payload).
 */
export function parseUpgradeActionValue(value: string): { planId: string } {
  if (typeof value !== "string") {
    throw new Error("parseUpgradeActionValue: value must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("parseUpgradeActionValue: value is empty");
  }
  if (trimmed.length > 200) {
    throw new Error(
      `parseUpgradeActionValue: value too long (${trimmed.length} chars, max 200)`,
    );
  }
  return { planId: trimmed };
}

// ── Internal helpers ────────────────────────────────────────

/**
 * Pull the last colon-segment of a Graph Resource id for at-a-glance
 * display. `proxmox:proxmox_cluster:prod` → `prod`. Names without a
 * colon are returned as-is. Names longer than 40 chars are truncated
 * with an ellipsis (matches the existing dashboard convention).
 */
function shortClusterName(clusterResourceId: string): string {
  const segments = clusterResourceId.split(":");
  const last = segments[segments.length - 1] || clusterResourceId;
  return truncate(last, 40);
}

/**
 * Render the host list — first 10 hosts on their own line, with a
 * trailing `+N more (total M)` if the plan has more.
 */
function formatHostList(hostIds: readonly string[]): string {
  if (hostIds.length === 0) return "_(no hosts)_";
  const head = hostIds.slice(0, 10);
  const lines = head.map((id) => `• \`${escapeMrkdwn(id)}\``);
  if (hostIds.length > head.length) {
    const more = hostIds.length - head.length;
    lines.push(`_+${more} more (total ${hostIds.length})_`);
  }
  return lines.join("\n");
}

/**
 * Build a context block linking to the dashboard plan page, or
 * undefined when no baseUrl is configured (so the caller can skip
 * pushing it).
 */
function buildDashboardContext(
  baseUrl: string | undefined,
  planId: string,
): unknown | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.replace(/\/+$/, "");
  const url = `${trimmed}/?plan=${encodeURIComponent(planId)}`;
  return {
    type: "context",
    elements: [
      { type: "mrkdwn", text: `View plan: <${url}|${escapeMrkdwn(planId)}>` },
    ],
  };
}

/**
 * Same Slack mrkdwn escape used elsewhere in dashboard/slack-routes.
 * Inlined (instead of imported) so this module stays a pure leaf with
 * zero downstream coupling on slack-routes.
 */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
