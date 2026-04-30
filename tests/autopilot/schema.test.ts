import { describe, it, expect } from "vitest";
import {
  validateRule,
  validateRules,
  validateRulesStrict,
  KNOWN_CONDITIONS,
  KNOWN_ACTIONS,
} from "../../src/autopilot/schema.js";
import { DEFAULT_RULES } from "../../src/autopilot/rules.js";

const goodRule = {
  id: "test_rule",
  name: "Test Rule",
  condition: "vm_was_running_now_stopped",
  action: "start_vm",
  params: {},
  tier: "safe_write",
  enabled: true,
  cooldown_s: 120,
};

describe("validateRule", () => {
  it("accepts a well-formed rule", () => {
    const out = validateRule(goodRule);
    expect(out.id).toBe("test_rule");
    expect(out.tier).toBe("safe_write");
  });

  it("validates every default rule", () => {
    for (const rule of DEFAULT_RULES) {
      expect(() => validateRule(rule)).not.toThrow();
    }
  });

  it("rejects an unknown tier", () => {
    expect(() =>
      validateRule({ ...goodRule, tier: "definitely_not_a_tier" }),
    ).toThrow();
  });

  it("rejects negative cooldown_s", () => {
    expect(() => validateRule({ ...goodRule, cooldown_s: -10 })).toThrow();
  });

  it("rejects empty id", () => {
    expect(() => validateRule({ ...goodRule, id: "" })).toThrow();
  });

  it("rejects rate_limit_max without rate_limit_window_s", () => {
    expect(() =>
      validateRule({ ...goodRule, rate_limit_max: 5 }),
    ).toThrow(/rate_limit/);
  });

  it("rejects rate_limit_window_s without rate_limit_max", () => {
    expect(() =>
      validateRule({ ...goodRule, rate_limit_window_s: 60 }),
    ).toThrow(/rate_limit/);
  });

  it("accepts rate_limit_max and rate_limit_window_s together", () => {
    const out = validateRule({
      ...goodRule,
      rate_limit_max: 5,
      rate_limit_window_s: 60,
    });
    expect(out.rate_limit_max).toBe(5);
    expect(out.rate_limit_window_s).toBe(60);
  });

  it("accepts per_entity_cooldown_s when set", () => {
    const out = validateRule({ ...goodRule, per_entity_cooldown_s: 30 });
    expect(out.per_entity_cooldown_s).toBe(30);
  });

  it("rejects negative per_entity_cooldown_s", () => {
    expect(() =>
      validateRule({ ...goodRule, per_entity_cooldown_s: -1 }),
    ).toThrow();
  });

  it("defaults params to {} when omitted", () => {
    const { params: _omit, ...rest } = goodRule;
    void _omit;
    const out = validateRule(rest);
    expect(out.params).toEqual({});
  });
});

describe("validateRules", () => {
  it("returns all rules as valid when input is clean", () => {
    const result = validateRules([goodRule, { ...goodRule, id: "another" }]);
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toHaveLength(2);
  });

  it("partitions valid and invalid rules with structured errors", () => {
    const result = validateRules([
      goodRule,
      { ...goodRule, id: "", cooldown_s: -1 },
    ]);
    expect(result.valid).toHaveLength(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const hasIdError = result.errors.some(
      (e) => e.path === "id" && e.index === 1,
    );
    const hasCooldownError = result.errors.some(
      (e) => e.path === "cooldown_s" && e.index === 1,
    );
    expect(hasIdError).toBe(true);
    expect(hasCooldownError).toBe(true);
  });

  it("preserves rule id in errors when present", () => {
    const result = validateRules([
      { ...goodRule, id: "broken", cooldown_s: -5 },
    ]);
    expect(result.errors[0].ruleId).toBe("broken");
  });
});

describe("validateRulesStrict", () => {
  it("returns rules when all are valid", () => {
    const out = validateRulesStrict([goodRule]);
    expect(out).toHaveLength(1);
  });

  it("throws an aggregated error when any rule is invalid", () => {
    expect(() =>
      validateRulesStrict([goodRule, { ...goodRule, cooldown_s: -1 }]),
    ).toThrow(/Invalid autopilot rule definitions/);
  });
});

describe("known constants", () => {
  it("exports a non-empty list of known conditions", () => {
    expect(KNOWN_CONDITIONS.length).toBeGreaterThan(0);
  });

  it("exports a non-empty list of known actions", () => {
    expect(KNOWN_ACTIONS.length).toBeGreaterThan(0);
  });
});
