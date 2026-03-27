// ============================================================
// InfraWrap — Chaos Scenarios · Unit Tests
// ============================================================

import { describe, it, expect } from "vitest";
import {
  getScenario,
  getAllScenarios,
  BUILTIN_SCENARIOS,
} from "../../src/chaos/scenarios.js";
import type { ChaosScenario } from "../../src/chaos/scenarios.js";

// ── getAllScenarios ──────────────────────────────────────────

describe("getAllScenarios", () => {
  it("returns exactly 4 scenarios", () => {
    const scenarios = getAllScenarios();
    expect(scenarios).toHaveLength(4);
  });

  it("returns a copy, not the original array", () => {
    const a = getAllScenarios();
    const b = getAllScenarios();

    // Different array references
    expect(a).not.toBe(BUILTIN_SCENARIOS);
    expect(a).not.toBe(b);

    // But same contents
    expect(a).toEqual(b);
  });
});

// ── getScenario ─────────────────────────────────────────────

describe("getScenario", () => {
  it('returns the vm_kill scenario', () => {
    const s = getScenario("vm_kill");
    expect(s).toBeDefined();
    expect(s!.id).toBe("vm_kill");
    expect(s!.name).toBe("VM Kill");
  });

  it('returns the random_vm_kill scenario', () => {
    const s = getScenario("random_vm_kill");
    expect(s).toBeDefined();
    expect(s!.id).toBe("random_vm_kill");
    expect(s!.name).toBe("Random VM Kill");
  });

  it('returns the multi_vm_kill scenario', () => {
    const s = getScenario("multi_vm_kill");
    expect(s).toBeDefined();
    expect(s!.id).toBe("multi_vm_kill");
    expect(s!.name).toBe("Multi-VM Kill");
  });

  it('returns the node_drain scenario', () => {
    const s = getScenario("node_drain");
    expect(s).toBeDefined();
    expect(s!.id).toBe("node_drain");
    expect(s!.name).toBe("Node Drain");
  });

  it("returns undefined for a nonexistent scenario", () => {
    expect(getScenario("nonexistent")).toBeUndefined();
  });
});

// ── Schema / required fields ────────────────────────────────

describe("scenario schema", () => {
  const requiredFields: (keyof ChaosScenario)[] = [
    "id",
    "name",
    "description",
    "severity",
    "target_type",
    "actions",
    "expected_recovery",
    "requires_approval",
    "reversible",
  ];

  const scenarios = getAllScenarios();

  it.each(scenarios)(
    "$id has all required fields",
    (scenario) => {
      for (const field of requiredFields) {
        expect(scenario).toHaveProperty(field);
      }
    },
  );

  it.each(scenarios)(
    "$id has at least one action",
    (scenario) => {
      expect(scenario.actions.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(scenarios)(
    "$id — every action has type, params, and description",
    (scenario) => {
      for (const action of scenario.actions) {
        expect(action).toHaveProperty("type");
        expect(action).toHaveProperty("params");
        expect(action).toHaveProperty("description");
      }
    },
  );
});

// ── Approval requirements ───────────────────────────────────

describe("approval requirements", () => {
  it("vm_kill does not require approval", () => {
    expect(getScenario("vm_kill")!.requires_approval).toBe(false);
  });

  it("random_vm_kill does not require approval", () => {
    expect(getScenario("random_vm_kill")!.requires_approval).toBe(false);
  });

  it("multi_vm_kill requires approval", () => {
    expect(getScenario("multi_vm_kill")!.requires_approval).toBe(true);
  });

  it("node_drain requires approval", () => {
    expect(getScenario("node_drain")!.requires_approval).toBe(true);
  });
});

// ── Severity levels ─────────────────────────────────────────

describe("severity levels", () => {
  it("vm_kill has medium severity", () => {
    expect(getScenario("vm_kill")!.severity).toBe("medium");
  });

  it("random_vm_kill has medium severity", () => {
    expect(getScenario("random_vm_kill")!.severity).toBe("medium");
  });

  it("multi_vm_kill has high severity", () => {
    expect(getScenario("multi_vm_kill")!.severity).toBe("high");
  });

  it("node_drain has critical severity", () => {
    expect(getScenario("node_drain")!.severity).toBe("critical");
  });
});
