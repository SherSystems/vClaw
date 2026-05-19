// ============================================================
// RHODES — Notifications: shared types
// ============================================================

/**
 * What kind of operational moment triggered this alert. Used so providers
 * can format/highlight the message consistently regardless of who sent it.
 */
export type AlertKind =
  | "event"
  | "plan_generated"
  | "approval_needed"
  | "execution_complete"
  | "execution_failed"
  | "health_check_failed"
  /** Engineering ticket opened — Block Kit message with ticket id,
   *  title, severity badge, labels and a "View ticket" link. The
   *  resulting Slack message ts is captured as `slack_thread_ts` on
   *  the Ticket so subsequent comments thread under it. */
  | "ticket_opened"
  /** Engineering ticket resolved — Block Kit message threaded under
   *  the original ticket-opened DM (via `slack_thread_ts` +
   *  `slack_channel` in context), carrying the LLM postmortem and
   *  the state-transition resolution string. */
  | "ticket_resolved"
  /** v0.7.2.3c — cluster upgrade plan ready for operator approval.
   *  Slack provider posts the pre-built Block-Kit blocks from
   *  `Alert.blocks` (with Approve/Reject buttons) instead of
   *  building from `body`. */
  | "upgrade_approval"
  /** v0.7.3.1 — per-host progress reply during an upgrade run. */
  | "upgrade_progress";

export interface Alert {
  /** Brief one-line subject; surfaces in Telegram preview. */
  title: string;
  /** Full alert body. Plain text or lightweight Markdown. */
  body: string;
  kind: AlertKind;
  /** When the underlying event fired (ISO 8601). Defaults to now. */
  timestamp?: string;
  /** Optional structured payload (host, vmid, plan_id, etc.). */
  context?: Record<string, unknown>;
  /** Optional deep link a human can click in the alert. */
  link?: string;
  /** Optional pre-built Slack Block-Kit blocks. When present, the
   *  Slack provider posts them verbatim instead of synthesizing
   *  from `body` + `kind`. Ignored by non-Slack providers (they
   *  fall back to `body`). v0.7.2.3c — used for the cluster-upgrade
   *  approval card so callers can construct the exact Block-Kit
   *  surface they need (buttons, confirmation dialogs, etc.). */
  blocks?: unknown[];
}

export interface NotificationDeliveryResult {
  /** Did the provider believe delivery succeeded? */
  delivered: boolean;
  /** Provider id (`none`, `supra`, `telegram_direct`). */
  provider: string;
  /** Whatever the upstream API returned (best-effort, may be partial). */
  response?: unknown;
  /** Error message if delivery failed; absent on success. */
  error?: string;
}

/**
 * Minimal contract every alert provider implements. Keep it tight so we
 * can stub it in tests without dragging a real fetch in.
 */
export interface AlertProvider {
  /** Stable id used for logs and the /healthz feed. */
  readonly id: string;
  send(alert: Alert): Promise<NotificationDeliveryResult>;
}
