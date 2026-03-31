import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolRegistry } from "../../src/tools/registry.js";
import type { GovernanceEngine } from "../../src/governance/index.js";
import type { ClusterState } from "../../src/types.js";
import { EventBus } from "../../src/agent/events.js";

vi.mock("../../src/autopilot/rules.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/autopilot/rules.js")>(
    "../../src/autopilot/rules.js",
  );
  return {
    ...actual,
    evaluateRules: vi.fn(),
  };
});

import { evaluateRules } from "../../src/autopilot/rules.js";
import { AutopilotDaemon } from "../../src/autopilot/daemon.js";

function makeClusterState(): ClusterState {
  return {
    adapter: "test",
    nodes: [],
    vms: [],
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
  };
}

function makeRegistry(): ToolRegistry {
  return {
    getClusterState: vi.fn().mockResolvedValue(makeClusterState()),
    execute: vi.fn().mockResolvedValue({ success: true }),
    getAllTools: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistry;
}

function makeGovernance(): GovernanceEngine {
  return {
    evaluate: vi.fn().mockResolvedValue({ allowed: true, reason: "ok" }),
    circuitBreaker: { isTripped: vi.fn().mockReturnValue(false) },
  } as unknown as GovernanceEngine;
}

describe("AutopilotDaemon resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(evaluateRules).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues ticking after a rule evaluation exception", async () => {
    vi.mocked(evaluateRules)
      .mockImplementationOnce(() => {
        throw new Error("rule evaluation boom");
      })
      .mockReturnValue([]);

    const registry = makeRegistry();
    const governance = makeGovernance();
    const eventBus = new EventBus();
    const daemon = new AutopilotDaemon(registry, governance, eventBus, {
      pollIntervalMs: 1000,
    });

    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    daemon.stop();

    expect(registry.getClusterState).toHaveBeenCalledTimes(2);
    const alerts = daemon.getAlerts();
    expect(
      alerts.some(
        (a) =>
          a.source === "autopilot/poll" &&
          a.message.includes("rule evaluation boom"),
      ),
    ).toBe(true);
  });
});
