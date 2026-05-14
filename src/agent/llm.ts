// ============================================================
// RHODES — LLM Abstraction Layer
// Routes calls to Anthropic or OpenAI based on configuration
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { PrivacyRouter } from "../security/privacy.js";
import { AgentEventType } from "../types.js";
import type { EventBus } from "./events.js";

export interface AIConfig {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
  /**
   * Optional per-attempt timeout (ms) for plan-level LLM calls. When set,
   * `callLLM({ purpose: "plan" })` uses this as the default. Wired through
   * from `RHODES_LLM_PLAN_TIMEOUT_MS` by `getConfig()`.
   */
  planTimeoutMs?: number;
  /**
   * Optional per-attempt timeout (ms) for step-level LLM calls. When set,
   * `callLLM({ purpose: "step" })` uses this as the default. Wired through
   * from `RHODES_LLM_STEP_TIMEOUT_MS` by `getConfig()`.
   */
  stepTimeoutMs?: number;
}

/**
 * Purpose tag for the LLM call. Used for telemetry and to pick the right
 * default timeout when the caller doesn't pass one explicitly. "plan" is
 * used for full plan/replan generation; "step" for inline reasoning calls
 * like observation, investigation, and RCA.
 */
export type LlmCallPurpose = "plan" | "step";

export interface CallLLMOptions {
  system: string;
  user: string;
  config: AIConfig;
  temperature?: number;
  maxTokens?: number;
  /** Optional privacy router to sanitize prompts before sending to the API */
  privacyRouter?: PrivacyRouter;
  /**
   * Hard timeout per attempt, in milliseconds. The underlying SDK call is
   * cancelled via AbortController when this elapses. Defaults are derived
   * from `purpose` if omitted (60_000ms for "plan", 30_000ms for "step").
   * A value of `0` disables the timeout (kept for tests that don't want
   * fake timers).
   */
  timeoutMs?: number;
  /**
   * Number of retries on timeout. Total attempts = retries + 1, i.e.
   * `retries=1` means up to two attempts. Defaults to 1 (so a single
   * hung Anthropic/OpenAI call will be retried once before bubbling up
   * `LlmTimeoutError`). Set to 0 to disable retries.
   *
   * Non-timeout errors (4xx/5xx, parse failures, etc.) are NOT retried.
   */
  retries?: number;
  /**
   * Logical purpose of this LLM call. Drives the default timeout and is
   * included in any emitted `llm_timeout` event so dashboards/audits can
   * tell apart a hung planner from a hung observation call.
   */
  purpose?: LlmCallPurpose;
  /**
   * Optional event bus. When provided, a timeout fires an `llm_timeout`
   * event so dashboards/audits see it. The agent core wires this through
   * for planner/replanner/observer calls; isolated unit tests can omit it.
   */
  eventBus?: EventBus;
  /**
   * Optional run/plan/step IDs included in the `llm_timeout` event payload
   * for traceability. None of these are required for the timeout to fire —
   * they're purely telemetry.
   */
  runId?: string;
  planId?: string;
  stepId?: string;
}

/**
 * Default per-attempt timeout for plan-level LLM calls (planner.plan,
 * planner.replan). 60 seconds — these are the heaviest calls and we want
 * them to have a generous window before we conclude the SDK is wedged.
 */
export const DEFAULT_PLAN_TIMEOUT_MS = 60_000;

/**
 * Default per-attempt timeout for inline-reasoning LLM calls (observer,
 * investigator). 30 seconds — these are tighter, single-step calls and
 * we want a hung one to free up the agent loop faster.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;

/**
 * Default number of retries on a timeout. Total attempts = retries + 1.
 * A single timeout retries once with a fresh AbortController; two
 * consecutive timeouts give up and throw `LlmTimeoutError`.
 */
export const DEFAULT_LLM_RETRIES = 1;

/**
 * Thrown when an LLM call exceeds `timeoutMs` on every attempt.
 * Callers can `instanceof LlmTimeoutError` to distinguish timeout from a
 * 4xx/5xx API error, a parse error, or any other failure mode.
 */
export class LlmTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly purpose: LlmCallPurpose;

  constructor(timeoutMs: number, attempts: number, purpose: LlmCallPurpose) {
    super(`LLM call timed out after ${timeoutMs}ms (attempts=${attempts}, purpose=${purpose})`);
    this.name = "LlmTimeoutError";
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
    this.purpose = purpose;
  }
}

/** Public type-guard used by callers that can't import the class itself. */
export function isLlmTimeoutError(err: unknown): err is LlmTimeoutError {
  return err instanceof LlmTimeoutError;
}

/**
 * Call an LLM provider and return the raw text response.
 * Uses temperature 0 for deterministic planning by default.
 * Strips markdown code fences from the response if present.
 *
 * On timeout, the underlying SDK call is cancelled via AbortController.
 * If `retries > 0`, a fresh AbortController is created for each attempt.
 * After all attempts time out, throws `LlmTimeoutError`. The agent core
 * surfaces the failure as a plan/step failure and releases the
 * `maxConcurrentHeals` slot so other incidents can still be handled.
 */
export async function callLLM(options: CallLLMOptions): Promise<string> {
  const {
    system: rawSystem,
    user: rawUser,
    config,
    temperature = 0,
    maxTokens = 4096,
    privacyRouter,
    purpose = "plan",
    retries = DEFAULT_LLM_RETRIES,
    eventBus,
    runId,
    planId,
    stepId,
  } = options;

  // Precedence: explicit options.timeoutMs > AIConfig.{plan,step}TimeoutMs >
  // hard-coded default. A value of `0` from any source disables the timeout
  // (used by isolated unit tests that don't want fake timers).
  const configTimeoutMs =
    purpose === "plan" ? config.planTimeoutMs : config.stepTimeoutMs;
  const timeoutMs =
    options.timeoutMs ??
    (typeof configTimeoutMs === "number" && configTimeoutMs >= 0
      ? configTimeoutMs
      : purpose === "plan"
        ? DEFAULT_PLAN_TIMEOUT_MS
        : DEFAULT_STEP_TIMEOUT_MS);

  // Sanitize prompts if a privacy router is provided
  let system = rawSystem;
  let user = rawUser;
  if (privacyRouter) {
    const sanitized = privacyRouter.sanitizeForLLM(rawSystem, rawUser);
    system = sanitized.system;
    user = sanitized.user;
  }

  const maxAttempts = Math.max(1, retries + 1);
  let attempt = 0;
  let timeouts = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt++;
    const controller = new AbortController();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(makeTimeoutReason(timeoutMs)), timeoutMs)
        : undefined;

    try {
      let raw: string;
      if (config.provider === "anthropic") {
        raw = await callAnthropic(system, user, config, temperature, maxTokens, controller.signal);
      } else if (config.provider === "openai") {
        raw = await callOpenAI(system, user, config, temperature, maxTokens, controller.signal);
      } else {
        throw new Error(`Unsupported AI provider: ${config.provider}`);
      }
      return stripMarkdownFences(raw);
    } catch (err) {
      lastError = err;
      if (isAbortError(err, controller.signal)) {
        timeouts++;
        if (eventBus) {
          eventBus.emit({
            type: AgentEventType.LlmTimeout,
            timestamp: new Date().toISOString(),
            data: {
              purpose,
              timeout_ms: timeoutMs,
              attempt,
              max_attempts: maxAttempts,
              provider: config.provider,
              model: config.model,
              run_id: runId,
              plan_id: planId,
              step_id: stepId,
            },
          });
        }
        if (attempt < maxAttempts) {
          continue; // retry with a fresh AbortController
        }
        throw new LlmTimeoutError(timeoutMs, timeouts, purpose);
      }
      // Non-timeout error: surface immediately, don't retry.
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Defensive: unreachable, but keep the type checker happy.
  if (lastError) throw lastError;
  throw new LlmTimeoutError(timeoutMs, timeouts || 1, purpose);
}

function makeTimeoutReason(timeoutMs: number): Error {
  const reason = new Error(`LLM call exceeded ${timeoutMs}ms`);
  reason.name = "AbortError";
  return reason;
}

/**
 * Detect whether an error originated from our AbortController firing on
 * timeout (vs. e.g. an HTTP 4xx). DOMException with name "AbortError" is
 * the canonical fetch/undici signal; the SDKs wrap it as `APIUserAbortError`
 * with name "AbortError" as well. The signal's own `.aborted` flag is the
 * most reliable post-hoc check — if the controller aborted, the throwing
 * call almost certainly originated from that abort.
 */
function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (err && typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && /abort/i.test(name)) return true;
  }
  return false;
}

async function callAnthropic(
  system: string,
  user: string,
  config: AIConfig,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create(
    {
      model: config.model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: user }],
    },
    signal ? { signal } : undefined,
  );

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Anthropic response");
  }

  return textBlock.text;
}

async function callOpenAI(
  system: string,
  user: string,
  config: AIConfig,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const client = new OpenAI({ apiKey: config.apiKey });

  const response = await client.chat.completions.create(
    {
      model: config.model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    signal ? { signal } : undefined,
  );

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No content in OpenAI response");
  }

  return content;
}

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) from LLM output.
 */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();

  // Match ```json\n...\n``` or ```\n...\n```
  const fencePattern = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const match = trimmed.match(fencePattern);
  if (match) {
    return match[1].trim();
  }

  return trimmed;
}
