// ============================================================
// RHODES — Postmortem Generator
//
// When RHODES resolves an incident, the agent writes a short
// postmortem in its own voice. The operator edits / signs off
// before closing the ticket.
//
// Voice (from `project_rhodes_v0_4_4_first_save.md`): technical,
// calm, includes specific numbers (data%, durations, retry
// counts), names the root cause clearly, no marketing words.
// Example from the v0.4.4 esxi-01 save:
//
//   "Vmid 200 entered paused (io-error) at 02:11 UTC. Thin-pool
//    was at 92%. Pruned autosnap_2026-04-18 to drop to 76%.
//    qm resume returned in 1.3s. Root cause: snapshot growth
//    not bounded by retention rule older than v0.4.3."
//
// Output: a single 3-6 sentence paragraph. We assemble a
// structured prompt from the ticket title, label set, action
// timeline (timestamps + durations), and plan-ids — then call
// the LLM with `purpose: "plan"` so it inherits the
// `RHODES_LLM_PLAN_TIMEOUT_MS` budget. On timeout we surface a
// "regenerate from dashboard" comment rather than blocking the
// resolve path. The agent voice has to look hand-typed — no
// "executive summary" / "next steps" sections.
// ============================================================

import { callLLM, LlmTimeoutError } from "../agent/llm.js";
import type { AIConfig } from "../agent/llm.js";
import type { Incident, ActionRecord } from "./incidents.js";
import type { TicketRecord } from "./ticket-store.js";

export interface PostmortemContext {
  ticket: TicketRecord;
  incident: Incident;
  /** Optional plan-id → outcome summary (e.g. "completed 11/11 steps"). */
  planSummaries?: Array<{ plan_id: string; outcome: string }>;
}

export interface PostmortemGeneratorOptions {
  /** Override the default 60s plan timeout if you really need to. */
  timeoutMs?: number;
  /** Inject a custom LLM caller for tests. Must return raw text. */
  llm?: (system: string, user: string) => Promise<string>;
}

export interface PostmortemResult {
  /** Generated postmortem text, or `undefined` if the call timed out. */
  text?: string;
  /** Operator-facing note describing what happened. Populated on
   *  timeout/failure so the UI can render a comment. */
  note?: string;
  /** True if the LLM call timed out. The ticket gets a comment but
   *  resolution doesn't block. */
  timedOut: boolean;
}

/**
 * Build the user prompt body. Pure function — exported so the snapshot
 * test can lock the prompt assembly without going through an LLM.
 *
 * Structure intentionally matches the way RHODES "thinks" about an
 * incident on the dashboard: header / labels / timeline / plans /
 * resolution. Keep it terse — the LLM has the labels already, no
 * need to repeat them in prose.
 */
export function buildPostmortemPrompt(ctx: PostmortemContext): {
  system: string;
  user: string;
} {
  const { ticket, incident, planSummaries } = ctx;

  const labelLines = Object.entries(incident.labels)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  const timelineLines = buildTimelineLines(incident);

  const planLines =
    planSummaries && planSummaries.length > 0
      ? planSummaries.map((p) => `  - ${p.plan_id}: ${p.outcome}`).join("\n")
      : ticket.plan_ids.length > 0
        ? ticket.plan_ids.map((id) => `  - ${id}`).join("\n")
        : "  (no plans recorded)";

  const detectedAt = incident.detected_at;
  const resolvedAt = incident.resolved_at ?? "(not resolved)";
  const durationS =
    typeof incident.duration_ms === "number"
      ? `${(incident.duration_ms / 1000).toFixed(1)}s`
      : "(unknown duration)";

  const system = [
    "You are RHODES, an SRE agent that just resolved an incident. Write a postmortem in your own voice.",
    "Voice: technical, calm, no marketing words, no executive summary, no headers, no bullet points.",
    "Include specific numbers (percentages, durations, retry counts) and name the root cause clearly.",
    "Output exactly one paragraph of 3-6 sentences. No greeting, no sign-off, no markdown.",
    "If the resolution mentions specific actions (snapshot pruned, qm resume returned, etc.), name them with their durations.",
    "If the root cause is unclear, say so — do not invent one.",
  ].join("\n");

  const user = [
    `Ticket: ${ticket.ticket_id} — ${ticket.title}`,
    `Metric: ${incident.metric}`,
    `Anomaly type: ${incident.anomaly_type}`,
    `Severity: ${incident.severity}`,
    `Detected at: ${detectedAt}`,
    `Resolved at: ${resolvedAt}`,
    `Total duration: ${durationS}`,
    "",
    "Labels:",
    labelLines || "  (none)",
    "",
    "Action timeline:",
    timelineLines || "  (no actions recorded)",
    "",
    "Plans that ran:",
    planLines,
    "",
    `Final resolution reason: ${incident.resolution ?? "(none)"}`,
    "",
    "Now write the postmortem. One paragraph, 3-6 sentences.",
  ].join("\n");

  return { system, user };
}

function buildTimelineLines(incident: Incident): string {
  if (incident.actions_taken.length === 0) return "";
  const records = incident.actions_taken;
  const lines: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const action = records[i];
    const prev: ActionRecord | undefined = records[i - 1];
    const duration = prev
      ? `${msBetween(prev.timestamp, action.timestamp)}ms after prev`
      : "first";
    const outcome = action.success ? "ok" : "FAILED";
    const details = action.details ? ` — ${action.details}` : "";
    lines.push(
      `  [${action.timestamp}] ${action.action} (${duration}, ${outcome})${details}`,
    );
  }
  return lines.join("\n");
}

function msBetween(a: string, b: string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.max(0, tb - ta);
}

/**
 * Generate a postmortem for a resolved incident. Wraps `callLLM` with
 * `purpose: "plan"` so it inherits the configured plan-timeout
 * (default 60s). On timeout, returns `timedOut: true` and a note
 * describing what to do — the caller appends that note as a comment.
 */
export async function generatePostmortem(
  ctx: PostmortemContext,
  config: AIConfig,
  options: PostmortemGeneratorOptions = {},
): Promise<PostmortemResult> {
  const { system, user } = buildPostmortemPrompt(ctx);

  try {
    const text = options.llm
      ? await options.llm(system, user)
      : await callLLM({
          system,
          user,
          config,
          purpose: "plan",
          temperature: 0.2,
          maxTokens: 600,
          timeoutMs: options.timeoutMs,
        });
    const cleaned = cleanPostmortemText(text);
    if (!cleaned) {
      return {
        timedOut: false,
        note: "Postmortem generator returned empty text — re-trigger from the dashboard",
      };
    }
    return { text: cleaned, timedOut: false };
  } catch (err) {
    if (err instanceof LlmTimeoutError) {
      return {
        timedOut: true,
        note: "Postmortem generation timed out — re-trigger from the dashboard",
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      timedOut: false,
      note: `Postmortem generation failed (${msg}) — re-trigger from the dashboard`,
    };
  }
}

/** Strip leading/trailing whitespace, trim quote-wrapping, and collapse
 *  paragraph breaks into a single space — keeps the output a single
 *  paragraph regardless of how the model formatted it. */
export function cleanPostmortemText(raw: string): string {
  let text = raw.trim();
  // Strip surrounding quotes the model sometimes adds.
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  // Collapse multi-line paragraphs.
  text = text.replace(/\s*\n\s*\n+\s*/g, " ").replace(/\s*\n\s*/g, " ");
  // Drop accidental markdown header / leading bullet.
  text = text.replace(/^[#>\-*]\s+/, "").trim();
  return text;
}
