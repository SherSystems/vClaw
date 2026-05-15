// ============================================================
// RHODES — Conversational Reply Generator
//
// When the operator @-mentions RHODES in Slack (or DMs the bot),
// the agent runs a plan and then replies in the thread. This module
// produces THAT reply — in RHODES's own voice, as if a coworker is
// answering the question.
//
// Distinct from `postmortem.ts`:
//  - postmortem is for resolved-incident write-ups: structured
//    timeline + specific numbers + root cause naming.
//  - conversational-reply is for casual "you asked me X, here's
//    what I found" answers: shorter, first-person, often ends
//    with a question or next-step suggestion when the situation
//    calls for it.
//
// Voice contract:
//  - First-person. "I checked", "I see", "Looks like".
//  - 1-3 sentences. This goes in a Slack thread, not a postmortem.
//  - Specific facts, not platitudes. Quote real values from the
//    step outputs (status, percentages, names).
//  - End with a next-step question only when the data actually
//    suggests one. Otherwise stop talking.
//  - Never start with greetings. Never sign off. No emoji. No
//    "I'll get right on it!" filler.
//
// If the LLM call times out or fails, we fall back to a templated
// reply so the operator isn't left waiting silently.
// ============================================================

import { callLLM, LlmTimeoutError } from "./llm.js";
import type { AIConfig } from "./llm.js";

export interface ConversationalReplyInput {
  /** The original user message that triggered the agent run. Free-form
   *  natural language ("investigate vmid 200", "any open incidents", etc). */
  command: string;
  /** Whether the plan completed successfully end-to-end. */
  success: boolean;
  /** Number of steps that completed. */
  steps_completed: number;
  /** Plan id, for the templated fallback. */
  plan_id?: string;
  /** Compact summary of each step's action + key output fields. The
   *  caller is responsible for keeping this under ~4 KB; we don't
   *  trim here. */
  step_summaries: StepSummary[];
  /** Optional dashboard URL for the fallback templated reply. */
  dashboard_url?: string;
}

export interface StepSummary {
  step_id: string;
  action: string;
  /** Brief one-line description of what came back. Caller decides
   *  what's salient — for `get_vm_status` it'd be "status=running
   *  qmpstatus=io-error", for `list_snapshots` it'd be "2 snapshots,
   *  oldest 24d". */
  outcome_brief: string;
  /** Was the step successful? */
  ok: boolean;
}

export interface ConversationalReplyResult {
  reply: string;
  /** True when the LLM produced this, false when the templated
   *  fallback kicked in (LLM timeout, no model configured, etc). */
  generated_by_llm: boolean;
}

export interface ConversationalReplyOptions {
  aiConfig: AIConfig;
  /** Override the timeout. Defaults to `aiConfig.stepTimeoutMs` —
   *  this is a quick second LLM call after the plan completes, not a
   *  full planning round. */
  timeoutMs?: number;
}

// ── Prompt assembly ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are RHODES, an autonomous infrastructure agent. \
You just finished running a plan that was triggered by a user message in \
Slack. Reply to the user as if you're a coworker who just looked into the \
thing they asked about.

Voice rules (non-negotiable):
- First-person ("I checked", "I see", "Looks like…"). You are RHODES, you did the work.
- 1-3 sentences. This goes in a Slack thread reply, not a report.
- Be specific. Quote real values from the step outputs (status="running", \
qmpstatus="io-error", thin-pool=80%, etc). Vague answers are useless.
- End with a concrete next-step question ONLY when the data actually \
suggests one ("want me to try qm resume?", "should I prune the oldest \
snapshot?"). If it doesn't, just stop.
- Never start with "Hi" / "Hello" / "Sure!". Never sign off ("Hope this helps"). \
No emoji. No "I'll get right on it!" filler.
- If the plan failed or hit an error, say what failed and what you know about why. \
Don't pretend success.
- If the user's question was ambiguous and the data doesn't really answer it, \
say so. Don't invent.`;

export function buildConversationalReplyPrompt(input: ConversationalReplyInput): {
  system: string;
  user: string;
} {
  const lines: string[] = [];
  lines.push(`User said: ${input.command.trim()}`);
  lines.push("");
  lines.push(`Plan ${input.success ? "completed" : "did NOT complete cleanly"} with ${input.steps_completed} step(s).`);
  lines.push("");
  lines.push("Step results (action → what came back):");
  for (const s of input.step_summaries) {
    const marker = s.ok ? " " : " (FAILED) ";
    lines.push(`  ${s.step_id}${marker}${s.action} → ${s.outcome_brief}`);
  }
  lines.push("");
  lines.push("Reply now. 1-3 sentences. First-person. Voice rules apply.");
  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

// ── Templated fallback (no LLM) ─────────────────────────────────────

function templatedFallback(input: ConversationalReplyInput): string {
  const stepStr = input.steps_completed === 1 ? "1 step" : `${input.steps_completed} steps`;
  if (!input.success) {
    return `I looked into "${input.command.trim()}" but the plan didn't complete cleanly — ${stepStr} ran. The dashboard has the step-by-step audit log.`;
  }
  return `I handled "${input.command.trim()}" — ${stepStr} ran. Dashboard has the full audit if you want to dig in.`;
}

// ── Public entry point ──────────────────────────────────────────────

export async function generateConversationalReply(
  input: ConversationalReplyInput,
  options: ConversationalReplyOptions,
): Promise<ConversationalReplyResult> {
  // No model configured (test environment, dev w/o API keys) →
  // return the fallback synchronously.
  if (!options.aiConfig.apiKey) {
    return { reply: templatedFallback(input), generated_by_llm: false };
  }

  const { system, user } = buildConversationalReplyPrompt(input);

  try {
    const text = await callLLM({
      system,
      user,
      config: options.aiConfig,
      purpose: "step",
      timeoutMs: options.timeoutMs ?? options.aiConfig.stepTimeoutMs,
      maxTokens: 512,
      temperature: 0.2,
    });
    const trimmed = (text ?? "").trim();
    if (trimmed.length === 0) {
      return { reply: templatedFallback(input), generated_by_llm: false };
    }
    // Defensive: if the model started with "Hi" / "Hello" anyway,
    // drop the salutation rather than letting it leak through.
    return { reply: stripSalutation(trimmed), generated_by_llm: true };
  } catch (err) {
    if (err instanceof LlmTimeoutError) {
      return { reply: templatedFallback(input), generated_by_llm: false };
    }
    return { reply: templatedFallback(input), generated_by_llm: false };
  }
}

function stripSalutation(s: string): string {
  return s
    .replace(/^\s*(hi|hey|hello|greetings|sure[!,.]?)[\s,!.-]*/i, "")
    .trim();
}
