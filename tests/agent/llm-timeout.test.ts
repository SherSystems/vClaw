// ============================================================
// Tests for LLM call timeout + retry semantics (correctness-2026-05-14 HIGH #2)
//
// Verifies:
//   1. A hung LLM call is cancelled via AbortController at the configured ms
//      and surfaces as `LlmTimeoutError`.
//   2. A fast LLM call resolves normally (no false-positive timeouts).
//   3. Retry-once semantic: two consecutive hangs → `LlmTimeoutError`.
//   4. First hang + second success: callLLM succeeds (no error thrown).
//   5. When an EventBus is wired through, the timeout emits an `llm_timeout`
//      event for dashboards/audits — including the AgentCore path, which is
//      what ensures `maxConcurrentHeals` slots get released.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (must be set up before importing callLLM) ─

// One mutable handle per provider so individual tests can swap out the
// `create` implementation without rebuilding the SDK constructor.
const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
    this.messages = { create: (...args: unknown[]) => anthropicCreate(...args) };
  });
  return { default: MockAnthropic };
});

vi.mock("openai", () => {
  const MockOpenAI = vi.fn(function (this: Record<string, unknown>) {
    this.chat = {
      completions: { create: (...args: unknown[]) => openaiCreate(...args) },
    };
  });
  return { default: MockOpenAI };
});

// ── Imports after mocks ─────────────────────────────────────

import {
  callLLM,
  LlmTimeoutError,
  isLlmTimeoutError,
  type AIConfig,
} from "../../src/agent/llm.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";

// ── Helpers ─────────────────────────────────────────────────

const baseOptions = {
  system: "You are a test assistant.",
  user: "Do something.",
};

function makeConfig(provider: "anthropic" | "openai" = "anthropic"): AIConfig {
  return { provider, apiKey: "test-key", model: "test-model" };
}

/**
 * Returns a `create()` impl that hangs until the test's AbortSignal fires.
 * Resolves only on abort (rejecting with an AbortError mimicking what the
 * Anthropic/OpenAI SDKs surface when their underlying fetch is cancelled).
 */
function hangingCreate() {
  return vi.fn(async (_body: unknown, opts?: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      const signal = opts?.signal;
      if (!signal) {
        // No signal wired = test misconfiguration; surface immediately so
        // we don't sit forever on a real timeout.
        reject(new Error("Test fixture: hangingCreate invoked without AbortSignal"));
        return;
      }
      if (signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });
}

/** Resolves quickly with a fixed text response. */
function fastAnthropicCreate(text = '{"ok":true}') {
  return vi.fn().mockResolvedValue({
    content: [{ type: "text", text }],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. Single-attempt timeout ───────────────────────────────

describe("callLLM timeout", () => {
  it("aborts a hung call at timeoutMs and throws LlmTimeoutError", async () => {
    anthropicCreate.mockImplementation(hangingCreate());

    const promise = callLLM({
      ...baseOptions,
      config: makeConfig(),
      timeoutMs: 5_000,
      retries: 0,
      purpose: "plan",
    });
    // Surface unhandled rejection so the test framework can observe it.
    const caught = promise.catch((e) => e);

    // Advance just past the timeout — the AbortController should fire and
    // the SDK's `create()` should reject with AbortError, which `callLLM`
    // translates to `LlmTimeoutError`.
    await vi.advanceTimersByTimeAsync(5_001);

    const err = await caught;
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(isLlmTimeoutError(err)).toBe(true);
    expect((err as LlmTimeoutError).timeoutMs).toBe(5_000);
    expect((err as LlmTimeoutError).attempts).toBe(1);
    expect((err as LlmTimeoutError).purpose).toBe("plan");
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    // The signal passed to the SDK should have been aborted.
    const opts = anthropicCreate.mock.calls[0][1] as { signal: AbortSignal };
    expect(opts.signal.aborted).toBe(true);
  });

  it("does not fire on a fast call (no false-positive timeout)", async () => {
    anthropicCreate.mockImplementation(fastAnthropicCreate('{"plan":"ok"}'));

    // 30s timeout against a sub-ms resolution. We don't advance fake timers
    // here because the SDK resolves synchronously via mockResolvedValue.
    const result = await callLLM({
      ...baseOptions,
      config: makeConfig(),
      timeoutMs: 30_000,
      retries: 0,
      purpose: "step",
    });
    expect(result).toBe('{"plan":"ok"}');
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  // ── 3. Retry-once: two hangs → fail ───────────────────────

  it("retries once on timeout then throws LlmTimeoutError (retries=1, attempts=2)", async () => {
    anthropicCreate.mockImplementation(hangingCreate());

    const promise = callLLM({
      ...baseOptions,
      config: makeConfig(),
      timeoutMs: 1_000,
      retries: 1,
      purpose: "plan",
    });
    const caught = promise.catch((e) => e);

    // First attempt times out
    await vi.advanceTimersByTimeAsync(1_001);
    // Second attempt times out
    await vi.advanceTimersByTimeAsync(1_001);

    const err = await caught;
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect((err as LlmTimeoutError).attempts).toBe(2);
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });

  // ── 4. First hang + second success ────────────────────────

  it("retries once on timeout then succeeds on second attempt (no plan failure)", async () => {
    let calls = 0;
    anthropicCreate.mockImplementation(async (_body, opts) => {
      calls++;
      if (calls === 1) {
        // First call hangs until aborted
        return new Promise((_resolve, reject) => {
          const signal = (opts as { signal?: AbortSignal }).signal!;
          signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      }
      // Second call returns immediately
      return { content: [{ type: "text", text: '{"recovered":true}' }] };
    });

    const promise = callLLM({
      ...baseOptions,
      config: makeConfig(),
      timeoutMs: 2_000,
      retries: 1,
      purpose: "plan",
    });

    // Trigger the first-attempt timeout
    await vi.advanceTimersByTimeAsync(2_001);
    // Second attempt resolves synchronously — drain the microtask queue
    const result = await promise;
    expect(result).toBe('{"recovered":true}');
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });
});

// ── 5. EventBus emits llm_timeout ───────────────────────────

describe("callLLM emits llm_timeout AgentEvent", () => {
  it("emits AgentEventType.LlmTimeout on each timed-out attempt", async () => {
    anthropicCreate.mockImplementation(hangingCreate());

    const bus = new EventBus();
    const events: { type: AgentEventType; data: Record<string, unknown> }[] = [];
    bus.on("*", (e) => events.push({ type: e.type, data: e.data }));

    const promise = callLLM({
      ...baseOptions,
      config: makeConfig(),
      timeoutMs: 500,
      retries: 1,
      purpose: "plan",
      eventBus: bus,
      runId: "run-1",
      planId: "plan-1",
    });
    const caught = promise.catch((e) => e);

    await vi.advanceTimersByTimeAsync(501);
    await vi.advanceTimersByTimeAsync(501);
    await caught;

    const timeoutEvents = events.filter((e) => e.type === AgentEventType.LlmTimeout);
    // One event per failed attempt (retries=1 → 2 attempts → 2 events)
    expect(timeoutEvents).toHaveLength(2);
    expect(timeoutEvents[0].data.purpose).toBe("plan");
    expect(timeoutEvents[0].data.timeout_ms).toBe(500);
    expect(timeoutEvents[0].data.attempt).toBe(1);
    expect(timeoutEvents[0].data.max_attempts).toBe(2);
    expect(timeoutEvents[0].data.run_id).toBe("run-1");
    expect(timeoutEvents[0].data.plan_id).toBe("plan-1");
    expect(timeoutEvents[1].data.attempt).toBe(2);
  });
});

// ── 6. Concurrency-slot release semantic ────────────────────
//
// This is the operational reason for the timeout: a hung LLM call must
// not pin a `maxConcurrentHeals` slot indefinitely. Concretely:
//   HealingExecutor.executeHealing → agentCore.run → planner.plan →
//   callLLM. When callLLM throws LlmTimeoutError, agentCore.run resolves
//   with `success: false`, the calling executor's `try { ... }`
//   exits cleanly, and `activeHeals.delete(healId)` fires either in the
//   success or catch branch.
//
// Here we exercise just the LLM boundary: when the timeout fires, the
// promise REJECTS (i.e. doesn't sit forever). That's sufficient to free
// the slot above; the linkage is also covered by the existing
// core.test.ts coverage for planner failures.

describe("callLLM timeout does not wedge the caller", () => {
  it("rejects in bounded time so the agentCore concurrency slot can free", async () => {
    anthropicCreate.mockImplementation(hangingCreate());

    const start = Date.now();
    const promise = callLLM({
      ...baseOptions,
      config: makeConfig(),
      timeoutMs: 100,
      retries: 0,
      purpose: "step",
    }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(101);
    const err = await promise;
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(LlmTimeoutError);
    // Fake timers advanced by 101ms — `Date.now()` advances in lockstep
    // because vi.useFakeTimers also installs a fake Date.
    expect(elapsed).toBeLessThan(10_000);
  });
});

// ── 7. AIConfig-level default timeouts ──────────────────────

describe("callLLM honors AIConfig.planTimeoutMs / stepTimeoutMs", () => {
  it("uses config.planTimeoutMs as the default for purpose: plan", async () => {
    anthropicCreate.mockImplementation(hangingCreate());

    const config: AIConfig = {
      ...makeConfig(),
      planTimeoutMs: 250,
      stepTimeoutMs: 5_000, // ensure the wrong one would NOT match
    };
    const promise = callLLM({
      ...baseOptions,
      config,
      retries: 0,
      purpose: "plan",
    }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(251);
    const err = await promise;
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect((err as LlmTimeoutError).timeoutMs).toBe(250);
  });

  it("uses config.stepTimeoutMs as the default for purpose: step", async () => {
    anthropicCreate.mockImplementation(hangingCreate());

    const config: AIConfig = {
      ...makeConfig(),
      planTimeoutMs: 5_000,
      stepTimeoutMs: 250,
    };
    const promise = callLLM({
      ...baseOptions,
      config,
      retries: 0,
      purpose: "step",
    }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(251);
    const err = await promise;
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect((err as LlmTimeoutError).timeoutMs).toBe(250);
  });
});
