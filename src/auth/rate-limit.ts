// ============================================================
// RHODES — In-memory IP rate limiter for login attempts
// 5 attempts / 15 min, sliding window. Lost on restart (homelab OK).
// ============================================================

export interface RateLimitOptions {
  maxAttempts?: number;
  windowMs?: number;
}

export class LoginRateLimiter {
  private attempts: Map<string, number[]> = new Map();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(opts: RateLimitOptions = {}) {
    this.max = opts.maxAttempts ?? 5;
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000;
  }

  /** Returns true if the key is currently blocked (>= max attempts in window). */
  isBlocked(key: string, now: number = Date.now()): boolean {
    const arr = this.attempts.get(key);
    if (!arr) return false;
    const cutoff = now - this.windowMs;
    const fresh = arr.filter((t) => t >= cutoff);
    if (fresh.length !== arr.length) this.attempts.set(key, fresh);
    return fresh.length >= this.max;
  }

  /** Record a failed attempt. */
  record(key: string, now: number = Date.now()): void {
    const arr = this.attempts.get(key) ?? [];
    arr.push(now);
    const cutoff = now - this.windowMs;
    this.attempts.set(
      key,
      arr.filter((t) => t >= cutoff),
    );
  }

  /** Successful login — clear the counter. */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  /** Remaining attempts before block (informational). */
  remaining(key: string, now: number = Date.now()): number {
    const arr = this.attempts.get(key);
    if (!arr) return this.max;
    const cutoff = now - this.windowMs;
    const fresh = arr.filter((t) => t >= cutoff);
    return Math.max(0, this.max - fresh.length);
  }
}
