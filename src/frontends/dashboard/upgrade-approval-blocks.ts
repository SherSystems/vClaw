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

import type { UpgradePlan, UpgradeRun } from "../../orchestrator/types.js";

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
          confirm: {
            title: { type: "plain_text", text: "Confirm approval" },
            text: {
              type: "mrkdwn",
              text: `Approve upgrade of *${escapeMrkdwn(clusterShort)}* to \`${escapeMrkdwn(plan.targetVersion)}\` across ${plan.hostResourceIds.length} host(s)?`,
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
