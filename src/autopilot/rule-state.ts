// ============================================================
// RHODES — Autopilot Rule-State Tracker
// In-memory state for per-entity cooldowns and per-rule rate
// limits. Lifted out of the daemon so it can be exercised
// independently and reasoned about with test fixtures.
// ============================================================

import type { AutopilotRule } from "../types.js";

/** Fully-qualified key for dedupe: `${rule.id}:${entityKey}`. */
type DedupeKey = string;

interface FireRecord {
  /** Most recent fire time (ms epoch). */
  lastFire: number;
  /** Fires within the rolling rate-limit window (ms epoch values). */
  recentFires: number[];
}

export type SuppressionReason =
  | "global_cooldown"
  | "entity_cooldown"
  | "rate_limit";

export interface SuppressionInfo {
  reason: SuppressionReason;
  /** Milliseconds until the rule can fire again (best-effort estimate). */
  retryAfterMs: number;
}

export interface AdmitResult {
  admitted: boolean;
  suppression?: SuppressionInfo;
}

/**
 * Build the dedupe key from a match. Falls back to a stable singleton key
 * when the match has no entity-identifying params, which preserves the
 * legacy "one fire per rule" behavior for rules without per-entity fields.
 */
export function buildEntityKey(
  ruleId: string,
  params: Record<string, unknown>,
): DedupeKey {
  const candidates = ["vmid", "vm_id", "node", "node_id", "storage_id"];
  for (const k of candidates) {
    if (params[k] !== undefined && params[k] !== null) {
      return `${ruleId}:${String(params[k])}`;
    }
  }
  return `${ruleId}:_global`;
}

// ── Tracker ─────────────────────────────────────────────────

export class RuleStateTracker {
  private records = new Map<DedupeKey, FireRecord>();

  /**
   * Decide whether `rule` may fire for the entity identified by `entityKey`.
   * Does NOT mutate state; call `recordFire` after a successful admission.
   */
  shouldAdmit(
    rule: AutopilotRule,
    entityKey: DedupeKey,
    now: Date,
  ): AdmitResult {
    const nowMs = now.getTime();
    const record = this.records.get(entityKey);

    // Per-entity cooldown takes precedence when configured. Otherwise, fall
    // back to the rule's global cooldown applied per-entity (so two entities
    // cannot starve each other).
    const entityCooldownMs =
      (rule.per_entity_cooldown_s ?? rule.cooldown_s) * 1000;
    if (record && entityCooldownMs > 0) {
      const elapsed = nowMs - record.lastFire;
      if (elapsed < entityCooldownMs) {
        return {
          admitted: false,
          suppression: {
            reason: rule.per_entity_cooldown_s !== undefined
              ? "entity_cooldown"
              : "global_cooldown",
            retryAfterMs: entityCooldownMs - elapsed,
          },
        };
      }
    }

    // Rate limit: count fires across all entities for this rule within window.
    if (
      rule.rate_limit_max !== undefined &&
      rule.rate_limit_window_s !== undefined
    ) {
      const windowMs = rule.rate_limit_window_s * 1000;
      const horizon = nowMs - windowMs;
      const totalFires = this.countFiresAcrossRule(rule.id, horizon);
      if (totalFires >= rule.rate_limit_max) {
        const oldestRelevant = this.oldestFireSince(rule.id, horizon);
        const retryAfterMs =
          oldestRelevant !== null
            ? Math.max(0, oldestRelevant + windowMs - nowMs)
            : windowMs;
        return {
          admitted: false,
          suppression: { reason: "rate_limit", retryAfterMs },
        };
      }
    }

    return { admitted: true };
  }

  /**
   * Record a fire so subsequent admit decisions account for it.
   */
  recordFire(rule: AutopilotRule, entityKey: DedupeKey, now: Date): void {
    const nowMs = now.getTime();
    const record = this.records.get(entityKey) ?? {
      lastFire: 0,
      recentFires: [],
    };
    record.lastFire = nowMs;

    // Keep recentFires bounded by the window.
    if (rule.rate_limit_window_s !== undefined) {
      const horizon = nowMs - rule.rate_limit_window_s * 1000;
      record.recentFires = record.recentFires.filter((t) => t >= horizon);
    }
    record.recentFires.push(nowMs);

    // Cap to a reasonable size to avoid unbounded growth even when no rate
    // limit is set — only ever need a few hundred timestamps for diagnostics.
    if (record.recentFires.length > 500) {
      record.recentFires = record.recentFires.slice(-500);
    }
    this.records.set(entityKey, record);
  }

  /**
   * Reset state for a rule (or all rules if no id is given). Useful for
   * tests and operator-driven flush operations.
   */
  reset(ruleId?: string): void {
    if (ruleId === undefined) {
      this.records.clear();
      return;
    }
    const prefix = `${ruleId}:`;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
  }

  /** Inspect the snapshot — primarily for tests and observability. */
  snapshot(): Array<{
    key: string;
    lastFire: number;
    recentFireCount: number;
  }> {
    return [...this.records.entries()].map(([key, rec]) => ({
      key,
      lastFire: rec.lastFire,
      recentFireCount: rec.recentFires.length,
    }));
  }

  // ── Internals ─────────────────────────────────────────────

  private countFiresAcrossRule(ruleId: string, horizonMs: number): number {
    const prefix = `${ruleId}:`;
    let count = 0;
    for (const [key, rec] of this.records.entries()) {
      if (!key.startsWith(prefix)) continue;
      for (const t of rec.recentFires) {
        if (t >= horizonMs) count++;
      }
    }
    return count;
  }

  private oldestFireSince(ruleId: string, horizonMs: number): number | null {
    const prefix = `${ruleId}:`;
    let oldest: number | null = null;
    for (const [key, rec] of this.records.entries()) {
      if (!key.startsWith(prefix)) continue;
      for (const t of rec.recentFires) {
        if (t >= horizonMs && (oldest === null || t < oldest)) oldest = t;
      }
    }
    return oldest;
  }
}
