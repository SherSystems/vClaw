// ============================================================
// Circuit Breaker — Halts execution after repeated failures
// ============================================================

import type { CircuitBreakerState } from "../types.js";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before tripping. Default: 3 */
  maxConsecutiveFailures: number;
  /** Cooldown period in milliseconds before auto-reset. Default: 60000 (60s) */
  cooldownMs: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  maxConsecutiveFailures: 3,
  cooldownMs: 60_000,
};

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private lastFailureAt: Date | undefined;
  private trippedAt: Date | undefined;
  private readonly options: CircuitBreakerOptions;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Track the result of an action.
   * - success resets the failure counter
   * - failure increments it and may trip the breaker
   */
  track(success: boolean): void {
    if (success) {
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures++;
    this.lastFailureAt = new Date();

    if (
      this.consecutiveFailures >= this.options.maxConsecutiveFailures &&
      !this.trippedAt
    ) {
      this.trippedAt = new Date();
    }
  }

  /**
   * Check if the circuit breaker is currently tripped.
   * Automatically resets if the cooldown period has elapsed.
   */
  isTripped(): boolean {
    if (!this.trippedAt) return false;

    const now = Date.now();
    const cooldownUntil = this.trippedAt.getTime() + this.options.cooldownMs;

    if (now >= cooldownUntil) {
      // Cooldown elapsed — auto-reset
      this.reset();
      return false;
    }

    return true;
  }

  /**
   * Manually reset the circuit breaker.
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.lastFailureAt = undefined;
    this.trippedAt = undefined;
  }

  /**
   * Get the full state of the circuit breaker for reporting/serialization.
   */
  getState(): CircuitBreakerState {
    const tripped = this.isTripped();

    const state: CircuitBreakerState = {
      consecutive_failures: this.consecutiveFailures,
      tripped,
    };

    if (this.lastFailureAt) {
      state.last_failure_at = this.lastFailureAt.toISOString();
    }

    if (this.trippedAt) {
      state.tripped_at = this.trippedAt.toISOString();
      state.cooldown_until = new Date(
        this.trippedAt.getTime() + this.options.cooldownMs,
      ).toISOString();
    }

    return state;
  }
}
