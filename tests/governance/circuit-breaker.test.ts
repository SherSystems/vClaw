import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../../src/governance/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
  });

  it("starts not tripped", () => {
    expect(breaker.isTripped()).toBe(false);
  });

  it("trips after maxConsecutiveFailures (default 3)", () => {
    breaker.track(false);
    breaker.track(false);
    expect(breaker.isTripped()).toBe(false);

    breaker.track(false);
    expect(breaker.isTripped()).toBe(true);
  });

  it("success resets failure counter", () => {
    breaker.track(false);
    breaker.track(false);
    breaker.track(true); // reset
    breaker.track(false);
    breaker.track(false);
    expect(breaker.isTripped()).toBe(false);
  });

  it("does NOT trip if success intervenes before threshold", () => {
    breaker.track(false);
    breaker.track(false);
    breaker.track(true);
    breaker.track(false);
    expect(breaker.isTripped()).toBe(false);
  });

  describe("auto-reset after cooldown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("auto-resets after cooldown period elapses", () => {
      breaker.track(false);
      breaker.track(false);
      breaker.track(false);
      expect(breaker.isTripped()).toBe(true);

      // Advance time past the default cooldown (60s)
      vi.advanceTimersByTime(60_001);

      expect(breaker.isTripped()).toBe(false);
    });

    it("remains tripped before cooldown elapses", () => {
      breaker.track(false);
      breaker.track(false);
      breaker.track(false);
      expect(breaker.isTripped()).toBe(true);

      vi.advanceTimersByTime(30_000);
      expect(breaker.isTripped()).toBe(true);
    });
  });

  it("manual reset() works", () => {
    breaker.track(false);
    breaker.track(false);
    breaker.track(false);
    expect(breaker.isTripped()).toBe(true);

    breaker.reset();
    expect(breaker.isTripped()).toBe(false);
  });

  describe("getState()", () => {
    it("returns correct state when not tripped", () => {
      const state = breaker.getState();
      expect(state.tripped).toBe(false);
      expect(state.consecutive_failures).toBe(0);
      expect(state.tripped_at).toBeUndefined();
      expect(state.cooldown_until).toBeUndefined();
    });

    it("returns correct state when tripped", () => {
      breaker.track(false);
      breaker.track(false);
      breaker.track(false);

      const state = breaker.getState();
      expect(state.tripped).toBe(true);
      expect(state.consecutive_failures).toBe(3);
      expect(state.tripped_at).toBeDefined();
      expect(state.cooldown_until).toBeDefined();
      expect(state.last_failure_at).toBeDefined();

      // cooldown_until should be tripped_at + cooldownMs
      const trippedMs = new Date(state.tripped_at!).getTime();
      const cooldownMs = new Date(state.cooldown_until!).getTime();
      expect(cooldownMs - trippedMs).toBe(60_000);
    });
  });

  describe("custom options", () => {
    it("respects custom maxConsecutiveFailures", () => {
      const custom = new CircuitBreaker({ maxConsecutiveFailures: 5 });
      for (let i = 0; i < 4; i++) custom.track(false);
      expect(custom.isTripped()).toBe(false);

      custom.track(false);
      expect(custom.isTripped()).toBe(true);
    });

    it("respects custom cooldownMs", () => {
      vi.useFakeTimers();
      const custom = new CircuitBreaker({ cooldownMs: 5_000 });
      custom.track(false);
      custom.track(false);
      custom.track(false);
      expect(custom.isTripped()).toBe(true);

      vi.advanceTimersByTime(5_001);
      expect(custom.isTripped()).toBe(false);
      vi.useRealTimers();
    });
  });

  it("tracks consecutive failures correctly (2 fail, 1 success, 2 fail = not tripped)", () => {
    breaker.track(false);
    breaker.track(false);
    breaker.track(true);
    breaker.track(false);
    breaker.track(false);
    expect(breaker.isTripped()).toBe(false);
  });
});
