import { describe, it, expect } from "vitest";
import {
  RuleStateTracker,
  buildEntityKey,
} from "../../src/autopilot/rule-state.js";
import type { AutopilotRule } from "../../src/types.js";

function makeRule(overrides?: Partial<AutopilotRule>): AutopilotRule {
  return {
    id: "vm_auto_restart",
    name: "Auto-restart stopped VMs",
    condition: "vm_was_running_now_stopped",
    action: "start_vm",
    params: {},
    tier: "safe_write",
    enabled: true,
    cooldown_s: 120,
    ...overrides,
  };
}

describe("buildEntityKey", () => {
  it("uses vmid when available", () => {
    expect(buildEntityKey("rule1", { vmid: 100, node: "pve1" })).toBe(
      "rule1:100",
    );
  });

  it("falls back to node when vmid is missing", () => {
    expect(buildEntityKey("rule1", { node: "pve1" })).toBe("rule1:pve1");
  });

  it("falls back to storage_id when vmid and node are missing", () => {
    expect(buildEntityKey("rule1", { storage_id: "local-lvm" })).toBe(
      "rule1:local-lvm",
    );
  });

  it("falls back to a stable singleton key for entity-less params", () => {
    expect(buildEntityKey("rule1", {})).toBe("rule1:_global");
  });

  it("treats null/undefined params as missing", () => {
    expect(buildEntityKey("rule1", { vmid: null, node: "pve2" })).toBe(
      "rule1:pve2",
    );
  });
});

describe("RuleStateTracker", () => {
  // ── Basic admit/record ─────────────────────────────────────

  it("admits the first fire for any entity", () => {
    const t = new RuleStateTracker();
    const result = t.shouldAdmit(makeRule(), "rule:100", new Date());
    expect(result.admitted).toBe(true);
  });

  it("blocks a second fire within the per-entity cooldown window", () => {
    const t = new RuleStateTracker();
    const rule = makeRule({ cooldown_s: 60 });
    const t0 = new Date();

    expect(t.shouldAdmit(rule, "rule:100", t0).admitted).toBe(true);
    t.recordFire(rule, "rule:100", t0);

    const t1 = new Date(t0.getTime() + 30_000); // 30s later
    const blocked = t.shouldAdmit(rule, "rule:100", t1);
    expect(blocked.admitted).toBe(false);
    expect(blocked.suppression?.reason).toBe("global_cooldown");
    expect(blocked.suppression?.retryAfterMs).toBeGreaterThan(0);
  });

  it("admits again once the cooldown window elapses", () => {
    const t = new RuleStateTracker();
    const rule = makeRule({ cooldown_s: 60 });
    const t0 = new Date();
    t.recordFire(rule, "rule:100", t0);

    const t1 = new Date(t0.getTime() + 61_000);
    expect(t.shouldAdmit(rule, "rule:100", t1).admitted).toBe(true);
  });

  // ── Per-entity isolation ───────────────────────────────────

  it("does NOT block other entities when one entity is in cooldown", () => {
    const t = new RuleStateTracker();
    const rule = makeRule({ cooldown_s: 60 });
    const t0 = new Date();

    t.recordFire(rule, "rule:100", t0);

    // A different entity (vm 200) under the same rule must still admit.
    const t1 = new Date(t0.getTime() + 5_000);
    expect(t.shouldAdmit(rule, "rule:200", t1).admitted).toBe(true);
  });

  it("uses per_entity_cooldown_s when set, not cooldown_s", () => {
    const t = new RuleStateTracker();
    const rule = makeRule({ cooldown_s: 600, per_entity_cooldown_s: 30 });
    const t0 = new Date();
    t.recordFire(rule, "rule:100", t0);

    const tWithin = new Date(t0.getTime() + 10_000);
    const tAfter = new Date(t0.getTime() + 35_000);

    const blocked = t.shouldAdmit(rule, "rule:100", tWithin);
    expect(blocked.admitted).toBe(false);
    expect(blocked.suppression?.reason).toBe("entity_cooldown");

    expect(t.shouldAdmit(rule, "rule:100", tAfter).admitted).toBe(true);
  });

  // ── Rate limit ─────────────────────────────────────────────

  it("blocks once rate_limit_max is reached within the window", () => {
    const t = new RuleStateTracker();
    const rule = makeRule({
      id: "ratelim_rule",
      cooldown_s: 0, // disable cooldown so we test rate-limit in isolation
      per_entity_cooldown_s: 0,
      rate_limit_max: 3,
      rate_limit_window_s: 60,
    });
    const t0 = new Date();

    // Three different entities admitted within the window.
    t.recordFire(rule, "ratelim_rule:1", new Date(t0.getTime() + 0));
    t.recordFire(rule, "ratelim_rule:2", new Date(t0.getTime() + 1_000));
    t.recordFire(rule, "ratelim_rule:3", new Date(t0.getTime() + 2_000));

    // Fourth fire across the rule should be rate-limited.
    const fourth = t.shouldAdmit(
      rule,
      "ratelim_rule:4",
      new Date(t0.getTime() + 3_000),
    );
    expect(fourth.admitted).toBe(false);
    expect(fourth.suppression?.reason).toBe("rate_limit");
    expect(fourth.suppression?.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows fires again after the rate-limit window slides past", () => {
    const t = new RuleStateTracker();
    const rule = makeRule({
      id: "ratelim_rule",
      cooldown_s: 0,
      per_entity_cooldown_s: 0,
      rate_limit_max: 2,
      rate_limit_window_s: 30,
    });
    const t0 = new Date();
    t.recordFire(rule, "ratelim_rule:1", t0);
    t.recordFire(rule, "ratelim_rule:2", new Date(t0.getTime() + 1_000));

    // Step past the window.
    const later = new Date(t0.getTime() + 31_000);
    expect(t.shouldAdmit(rule, "ratelim_rule:3", later).admitted).toBe(true);
  });

  it("rate limit only counts fires for the same rule", () => {
    const t = new RuleStateTracker();
    const ruleA = makeRule({
      id: "rule_a",
      cooldown_s: 0,
      rate_limit_max: 1,
      rate_limit_window_s: 60,
    });
    const ruleB = makeRule({
      id: "rule_b",
      cooldown_s: 0,
      rate_limit_max: 1,
      rate_limit_window_s: 60,
    });
    const t0 = new Date();

    t.recordFire(ruleA, "rule_a:1", t0);
    // ruleB's quota should be untouched.
    expect(
      t.shouldAdmit(ruleB, "rule_b:1", new Date(t0.getTime() + 1_000))
        .admitted,
    ).toBe(true);
  });

  // ── reset / snapshot ──────────────────────────────────────

  it("reset() with no id clears all state", () => {
    const t = new RuleStateTracker();
    const rule = makeRule();
    t.recordFire(rule, "rule:1", new Date());
    expect(t.snapshot().length).toBeGreaterThan(0);
    t.reset();
    expect(t.snapshot()).toEqual([]);
  });

  it("reset(ruleId) only clears entries for that rule", () => {
    const t = new RuleStateTracker();
    const ruleA = makeRule({ id: "rule_a" });
    const ruleB = makeRule({ id: "rule_b" });
    t.recordFire(ruleA, "rule_a:1", new Date());
    t.recordFire(ruleB, "rule_b:1", new Date());

    t.reset("rule_a");
    const keys = t.snapshot().map((s) => s.key);
    expect(keys).not.toContain("rule_a:1");
    expect(keys).toContain("rule_b:1");
  });

  it("snapshot() returns lastFire and recentFireCount per entity", () => {
    const t = new RuleStateTracker();
    const rule = makeRule({ rate_limit_max: 5, rate_limit_window_s: 60 });
    const t0 = new Date();
    t.recordFire(rule, "rule:1", t0);
    t.recordFire(rule, "rule:1", new Date(t0.getTime() + 1_000));

    const snap = t.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].key).toBe("rule:1");
    expect(snap[0].recentFireCount).toBe(2);
    expect(snap[0].lastFire).toBe(t0.getTime() + 1_000);
  });
});
