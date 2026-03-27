// ============================================================
// Edge-case tests for MultiProviderOrchestrator
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Goal,
  Plan,
  PlanStep,
  MultiClusterState,
  ClusterState,
  ToolDefinition,
  StepResult,
} from "../../src/types.js";
import type { AIConfig } from "../../src/agent/llm.js";
import type { PlanningContext } from "../../src/agent/planner.js";
import {
  MultiProviderOrchestrator,
  type PlanResult,
  type CapacityAnalysis,
  type MultiQueryResult,
} from "../../src/agent/orchestrator.js";
import { EventBus } from "../../src/agent/events.js";

// ── Mock Factories ──────────────────────────────────────────

const mockConfig: AIConfig = {
  provider: "anthropic",
  apiKey: "test-key",
  model: "test-model",
};

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    mode: "build",
    description: "Test goal",
    raw_input: "test goal",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeClusterState(
  adapter: string,
  overrides: Partial<ClusterState> = {},
): ClusterState {
  return {
    adapter,
    nodes: [],
    vms: [],
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeMultiClusterState(
  providers: MultiClusterState["providers"] = [],
): MultiClusterState {
  return { providers, timestamp: new Date().toISOString() };
}

function makeProviderState(
  name: string,
  type: "proxmox" | "vmware" | "system",
  stateOverrides: Partial<ClusterState> = {},
): MultiClusterState["providers"][0] {
  return {
    name,
    type,
    state: makeClusterState(name, stateOverrides),
  };
}

function makePlan(steps: PlanStep[], overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    goal_id: "goal-1",
    steps,
    created_at: new Date().toISOString(),
    status: "pending",
    resource_estimate: {
      ram_mb: 0,
      disk_gb: 0,
      cpu_cores: 0,
      vms_created: 0,
      containers_created: 0,
    },
    reasoning: "Test plan",
    revision: 1,
    ...overrides,
  };
}

function makeStep(
  id: string,
  action: string,
  dependsOn: string[] = [],
): PlanStep {
  return {
    id,
    action,
    params: {},
    description: `Step ${id}: ${action}`,
    depends_on: dependsOn,
    status: "pending",
    tier: "read",
  };
}

function makeTools(): ToolDefinition[] {
  return [
    {
      name: "proxmox_list_vms",
      description: "List VMs",
      tier: "read",
      adapter: "proxmox",
      params: [],
      returns: "VMInfo[]",
    },
    {
      name: "proxmox_create_vm",
      description: "Create VM",
      tier: "safe_write",
      adapter: "proxmox",
      params: [],
      returns: "VM",
    },
    {
      name: "vmware_list_vms",
      description: "List VMs",
      tier: "read",
      adapter: "vmware",
      params: [],
      returns: "VMInfo[]",
    },
    {
      name: "vmware_create_vm",
      description: "Create VM",
      tier: "safe_write",
      adapter: "vmware",
      params: [],
      returns: "VM",
    },
    {
      name: "ping",
      description: "Ping",
      tier: "read",
      adapter: "system",
      params: [],
      returns: "boolean",
    },
  ];
}

function makeMockRegistry(
  multiClusterState?: MultiClusterState,
  tools?: ToolDefinition[],
) {
  const allTools = tools || makeTools();
  return {
    getMultiClusterState: vi.fn().mockResolvedValue(
      multiClusterState || makeMultiClusterState([]),
    ),
    getClusterState: vi
      .fn()
      .mockResolvedValue(makeClusterState("proxmox")),
    getAllTools: vi.fn().mockReturnValue(allTools),
    getTool: vi
      .fn()
      .mockImplementation((name: string) =>
        allTools.find((t) => t.name === name),
      ),
    execute: vi.fn().mockResolvedValue({ success: true, data: {} }),
  } as any;
}

function makeMockPlanner(plan?: Plan) {
  return {
    plan: vi
      .fn()
      .mockResolvedValue(plan || makePlan([makeStep("s1", "proxmox_list_vms")])),
    replan: vi.fn().mockResolvedValue(makePlan([])),
  } as any;
}

function makeMockExecutor() {
  return {
    executeStep: vi.fn().mockResolvedValue({
      success: true,
      data: {},
      duration_ms: 50,
      timestamp: new Date().toISOString(),
    }),
  } as any;
}

function makeMockObserver() {
  return {
    observe: vi.fn().mockResolvedValue({
      matches: true,
      discrepancies: [],
      severity: "none",
    }),
  } as any;
}

function makeMockGovernance() {
  return {
    evaluate: vi.fn().mockResolvedValue({
      allowed: true,
      tier: "read",
      needs_approval: false,
      reason: "auto",
    }),
    logAction: vi.fn(),
    circuitBreaker: {
      track: vi.fn(),
      isTripped: vi.fn().mockReturnValue(false),
    },
  } as any;
}

function makeMockMemory() {
  return {
    recall: vi.fn().mockReturnValue([]),
    save: vi.fn(),
    close: vi.fn(),
  } as any;
}

function makeOrchestrator(overrides: Record<string, any> = {}) {
  const eventBus = overrides.eventBus || new EventBus();
  const registry = overrides.registry || makeMockRegistry();
  const planner = overrides.planner || makeMockPlanner();
  const executor = overrides.executor || makeMockExecutor();
  const observer = overrides.observer || makeMockObserver();
  const governance = overrides.governance || makeMockGovernance();
  const memory = overrides.memory || makeMockMemory();

  return new MultiProviderOrchestrator({
    registry,
    planner,
    executor,
    observer,
    eventBus,
    config: mockConfig,
    governance,
    memory,
  });
}

// ── Edge-Case Test Suite ────────────────────────────────────

describe("MultiProviderOrchestrator — Edge Cases", () => {
  // ── Input edge cases ──────────────────────────────────────

  describe("Goal input edge cases", () => {
    it("handles empty string goal description", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan([makeStep("s1", "proxmox_list_vms")]));
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(
        makeGoal({ description: "" }),
        "build",
      );
      // Should still proceed (planner decides what to do)
      expect(result).toBeDefined();
      expect(result.plan).toBeDefined();
    });

    it("handles extremely long goal description (10K chars)", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan([makeStep("s1", "proxmox_list_vms")]));
      const orch = makeOrchestrator({ registry, planner });

      const longDesc = "A".repeat(10_000);
      const result = await orch.executeGoal(
        makeGoal({ description: longDesc }),
        "build",
      );
      expect(result).toBeDefined();
      expect(planner.plan).toHaveBeenCalled();
    });

    it("handles goal with special characters and unicode", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan([makeStep("s1", "proxmox_list_vms")]));
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(
        makeGoal({
          description: "Create VM with name 'test<>&\"' \u00e9\u00e0\u00fc \ud83d\ude80 \u2603 \u0000 \n\t",
        }),
        "build",
      );
      expect(result).toBeDefined();
    });

    it("handles goal with emoji in description", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan([makeStep("s1", "proxmox_list_vms")]));
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(
        makeGoal({ description: "\ud83d\ude80\ud83d\udd25\ud83c\udf1f Deploy all the things" }),
        "build",
      );
      expect(result).toBeDefined();
    });
  });

  // ── State edge cases ──────────────────────────────────────

  describe("Provider state edge cases", () => {
    it("no providers connected returns failure", async () => {
      const registry = makeMockRegistry(makeMultiClusterState([]));
      const orch = makeOrchestrator({ registry });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(false);
      expect(result.plan.reasoning).toContain("No providers connected");
      expect(result.providers_used).toEqual([]);
      expect(result.cross_provider).toBe(false);
    });

    it("all providers disconnected (empty multiClusterState)", async () => {
      const registry = makeMockRegistry(makeMultiClusterState([]));
      const orch = makeOrchestrator({ registry });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(false);
      expect(result.step_results).toHaveLength(0);
    });

    it("provider returns empty cluster state (0 nodes, 0 VMs, 0 storage)", async () => {
      const emptyProvider = makeProviderState("proxmox", "proxmox");
      const registry = makeMockRegistry(
        makeMultiClusterState([emptyProvider]),
      );
      const planner = makeMockPlanner(makePlan([makeStep("s1", "proxmox_list_vms")]));
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result).toBeDefined();
      expect(result.plan).toBeDefined();
    });

    it("provider returns partial data (nodes but no VMs)", async () => {
      const partialProvider = makeProviderState("proxmox", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 8,
            cpu_usage_pct: 50,
            ram_total_mb: 32768,
            ram_used_mb: 16384,
            disk_total_gb: 1000,
            disk_used_gb: 500,
            disk_usage_pct: 50,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
        containers: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([partialProvider]),
      );
      const planner = makeMockPlanner(makePlan([makeStep("s1", "proxmox_list_vms")]));
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result).toBeDefined();
    });

    it("registry.getMultiClusterState throws", async () => {
      const registry = makeMockRegistry();
      registry.getMultiClusterState.mockRejectedValue(
        new Error("Connection refused"),
      );
      const orch = makeOrchestrator({ registry });

      await expect(orch.executeGoal(makeGoal(), "build")).rejects.toThrow(
        "Connection refused",
      );
    });
  });

  // ── Capacity analysis edge cases ──────────────────────────

  describe("getCapacityAnalysis() edge cases", () => {
    it("all providers at 0% usage", async () => {
      const idleProvider = makeProviderState("proxmox", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 16,
            cpu_usage_pct: 0,
            ram_total_mb: 65536,
            ram_used_mb: 0,
            disk_total_gb: 2000,
            disk_used_gb: 0,
            disk_usage_pct: 0,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [
          {
            id: "local",
            node: "pve1",
            type: "dir",
            total_gb: 2000,
            used_gb: 0,
            available_gb: 2000,
            content: ["images"],
          },
        ],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([idleProvider]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].capacity.cpu_used).toBe(0);
      expect(result.providers[0].capacity.memory_used_gb).toBe(0);
      expect(result.providers[0].health).toBe("healthy");
    });

    it("all providers at 100% usage", async () => {
      const saturated = makeProviderState("proxmox", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 16,
            cpu_usage_pct: 100,
            ram_total_mb: 65536,
            ram_used_mb: 65536,
            disk_total_gb: 2000,
            disk_used_gb: 2000,
            disk_usage_pct: 100,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([saturated]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].capacity.cpu_available).toBe(0);
      expect(result.providers[0].capacity.memory_available_gb).toBe(0);
      expect(result.providers[0].health).toBe("critical");
    });

    it("one provider at 100%, one at 0% — recommendation picks the idle one", async () => {
      const saturated = makeProviderState("saturated", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 16,
            cpu_usage_pct: 100,
            ram_total_mb: 65536,
            ram_used_mb: 65536,
            disk_total_gb: 2000,
            disk_used_gb: 2000,
            disk_usage_pct: 100,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const idle = makeProviderState("idle", "vmware", {
        nodes: [
          {
            id: "n2",
            name: "esxi1",
            status: "online",
            cpu_cores: 32,
            cpu_usage_pct: 0,
            ram_total_mb: 131072,
            ram_used_mb: 0,
            disk_total_gb: 4000,
            disk_used_gb: 0,
            disk_usage_pct: 0,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([saturated, idle]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.recommendation).toContain("idle");
    });

    it("provider with 0 nodes, 0 VMs — no division by zero", async () => {
      const empty = makeProviderState("empty", "proxmox", {
        nodes: [],
        vms: [],
        storage: [],
        containers: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([empty]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].capacity.cpu_total).toBe(0);
      expect(result.providers[0].capacity.cpu_used).toBe(0);
      expect(result.providers[0].capacity.memory_total_gb).toBe(0);
      expect(result.providers[0].health).toBe("critical");
    });

    it("provider with 0 total storage — no division by zero", async () => {
      const zeroStorage = makeProviderState("zero-storage", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 8,
            cpu_usage_pct: 50,
            ram_total_mb: 32768,
            ram_used_mb: 16384,
            disk_total_gb: 0,
            disk_used_gb: 0,
            disk_usage_pct: 0,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [
          {
            id: "s1",
            node: "pve1",
            type: "dir",
            total_gb: 0,
            used_gb: 0,
            available_gb: 0,
            content: [],
          },
        ],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([zeroStorage]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].capacity.storage_total_gb).toBe(0);
      expect(result.providers[0].capacity.storage_available_gb).toBe(0);
      // Should not throw
    });

    it("provider with 0 total memory — no division by zero", async () => {
      const zeroMem = makeProviderState("zero-mem", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 8,
            cpu_usage_pct: 50,
            ram_total_mb: 0,
            ram_used_mb: 0,
            disk_total_gb: 1000,
            disk_used_gb: 500,
            disk_usage_pct: 50,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([zeroMem]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].capacity.memory_total_gb).toBe(0);
      expect(result.providers[0].capacity.memory_available_gb).toBe(0);
      // No crash = pass
    });

    it("provider with 0 total CPU — no division by zero", async () => {
      const zeroCpu = makeProviderState("zero-cpu", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 0,
            cpu_usage_pct: 0,
            ram_total_mb: 32768,
            ram_used_mb: 16384,
            disk_total_gb: 1000,
            disk_used_gb: 500,
            disk_usage_pct: 50,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([zeroCpu]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].capacity.cpu_total).toBe(0);
      // avgCpuPct should be 0 when cpuTotal is 0
      expect(result.providers[0].health).not.toBe("critical");
    });

    it("equal capacity across providers — tie-breaking picks first (>= comparison)", async () => {
      const makeIdentical = (name: string, type: "proxmox" | "vmware") =>
        makeProviderState(name, type, {
          nodes: [
            {
              id: "n1",
              name: `${name}-node`,
              status: "online",
              cpu_cores: 16,
              cpu_usage_pct: 50,
              ram_total_mb: 65536,
              ram_used_mb: 32768,
              disk_total_gb: 2000,
              disk_used_gb: 1000,
              disk_usage_pct: 50,
              uptime_s: 86400,
            },
          ],
          vms: [],
          storage: [],
        });
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeIdentical("alpha", "proxmox"),
          makeIdentical("beta", "vmware"),
        ]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      // With >= in reduce, tie goes to the first element
      expect(result.recommendation).toContain("alpha");
    });

    it("single provider — recommendation should pick it", async () => {
      const single = makeProviderState("solo", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 8,
            cpu_usage_pct: 30,
            ram_total_mb: 32768,
            ram_used_mb: 10000,
            disk_total_gb: 1000,
            disk_used_gb: 200,
            disk_usage_pct: 20,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([single]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.recommendation).toContain("solo");
    });

    it("CPU exactly at 80% boundary — degraded", async () => {
      const boundary = makeProviderState("boundary", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 100,
            cpu_usage_pct: 80.01,
            ram_total_mb: 65536,
            ram_used_mb: 10000,
            disk_total_gb: 1000,
            disk_used_gb: 200,
            disk_usage_pct: 20,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([boundary]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].health).toBe("degraded");
    });

    it("CPU exactly at 95% boundary — critical", async () => {
      const boundary = makeProviderState("boundary", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 100,
            cpu_usage_pct: 95.01,
            ram_total_mb: 65536,
            ram_used_mb: 10000,
            disk_total_gb: 1000,
            disk_used_gb: 200,
            disk_usage_pct: 20,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([boundary]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].health).toBe("critical");
    });

    it("memory exactly at 85% boundary — degraded", async () => {
      const boundary = makeProviderState("boundary", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 16,
            cpu_usage_pct: 10,
            ram_total_mb: 100000,
            ram_used_mb: 85001,
            disk_total_gb: 1000,
            disk_used_gb: 200,
            disk_usage_pct: 20,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([boundary]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].health).toBe("degraded");
    });

    it("memory exactly at 95% boundary — critical", async () => {
      const boundary = makeProviderState("boundary", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 16,
            cpu_usage_pct: 10,
            ram_total_mb: 100000,
            ram_used_mb: 95001,
            disk_total_gb: 1000,
            disk_used_gb: 200,
            disk_usage_pct: 20,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([boundary]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      expect(result.providers[0].health).toBe("critical");
    });

    it("negative capacity values do not crash", async () => {
      const negative = makeProviderState("negative", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: -4,
            cpu_usage_pct: -10,
            ram_total_mb: -1000,
            ram_used_mb: -500,
            disk_total_gb: -100,
            disk_used_gb: -50,
            disk_usage_pct: -10,
            uptime_s: -1,
          },
        ],
        vms: [],
        storage: [
          {
            id: "s1",
            node: "pve1",
            type: "dir",
            total_gb: -100,
            used_gb: -50,
            available_gb: -50,
            content: [],
          },
        ],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([negative]),
      );
      const orch = makeOrchestrator({ registry });

      // Should not throw
      const result = await orch.getCapacityAnalysis();
      expect(result).toBeDefined();
      expect(result.providers).toHaveLength(1);
    });

    it("all providers critical — recommendation falls back to critical providers", async () => {
      const crit1 = makeProviderState("crit1", "proxmox", {
        nodes: [
          {
            id: "n1",
            name: "pve1",
            status: "online",
            cpu_cores: 16,
            cpu_usage_pct: 96,
            ram_total_mb: 65536,
            ram_used_mb: 65000,
            disk_total_gb: 1000,
            disk_used_gb: 990,
            disk_usage_pct: 99,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const crit2 = makeProviderState("crit2", "vmware", {
        nodes: [
          {
            id: "n2",
            name: "esxi1",
            status: "online",
            cpu_cores: 16,
            cpu_usage_pct: 98,
            ram_total_mb: 65536,
            ram_used_mb: 64000,
            disk_total_gb: 1000,
            disk_used_gb: 995,
            disk_usage_pct: 99,
            uptime_s: 86400,
          },
        ],
        vms: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([crit1, crit2]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.getCapacityAnalysis();
      // Should still produce a recommendation (falls back to critical)
      expect(result.recommendation).not.toContain("No providers available");
    });
  });

  // ── Plan/execution edge cases ─────────────────────────────

  describe("Plan execution edge cases", () => {
    it("plan with 0 steps completes successfully", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan([]));
      const executor = makeMockExecutor();
      const orch = makeOrchestrator({ registry, planner, executor });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(true);
      expect(result.step_results).toHaveLength(0);
      expect(executor.executeStep).not.toHaveBeenCalled();
    });

    it("plan with 1 step succeeds", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(
        makePlan([makeStep("s1", "proxmox_list_vms")]),
      );
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(true);
      expect(result.step_results).toHaveLength(1);
    });

    it("plan with many steps (20+) executes all", async () => {
      const steps = Array.from({ length: 20 }, (_, i) =>
        makeStep(`s${i + 1}`, "proxmox_list_vms"),
      );
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan(steps));
      const executor = makeMockExecutor();
      const orch = makeOrchestrator({ registry, planner, executor });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(true);
      expect(result.step_results).toHaveLength(20);
      expect(executor.executeStep).toHaveBeenCalledTimes(20);
    });

    it("first step fails — dependent steps skipped", async () => {
      const steps = [
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "proxmox_create_vm", ["s1"]),
        makeStep("s3", "proxmox_create_vm", ["s2"]),
      ];
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan(steps));
      const executor = makeMockExecutor();
      executor.executeStep.mockResolvedValue({
        success: false,
        error: "Failed at s1",
        duration_ms: 10,
        timestamp: new Date().toISOString(),
      });
      const orch = makeOrchestrator({ registry, planner, executor });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(false);
      expect(result.plan.steps[1].status).toBe("skipped");
      expect(result.plan.steps[2].status).toBe("skipped");
      expect(executor.executeStep).toHaveBeenCalledTimes(1);
    });

    it("middle step fails — earlier steps succeed, later dependent steps skipped", async () => {
      const steps = [
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "proxmox_create_vm", ["s1"]),
        makeStep("s3", "proxmox_create_vm", ["s2"]),
      ];
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan(steps));
      const executor = makeMockExecutor();
      executor.executeStep.mockImplementation(async (step: PlanStep) => {
        if (step.id === "s2") {
          return {
            success: false,
            error: "Timeout",
            duration_ms: 10,
            timestamp: new Date().toISOString(),
          };
        }
        return {
          success: true,
          data: {},
          duration_ms: 50,
          timestamp: new Date().toISOString(),
        };
      });
      const orch = makeOrchestrator({ registry, planner, executor });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(false);
      expect(result.plan.steps[0].status).toBe("success");
      expect(result.plan.steps[1].status).toBe("failed");
      expect(result.plan.steps[2].status).toBe("skipped");
    });

    it("last step fails — prior steps still succeed", async () => {
      const steps = [
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "proxmox_create_vm", ["s1"]),
      ];
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan(steps));
      const executor = makeMockExecutor();
      executor.executeStep.mockImplementation(async (step: PlanStep) => {
        if (step.id === "s2") {
          return {
            success: false,
            error: "Disk full",
            duration_ms: 10,
            timestamp: new Date().toISOString(),
          };
        }
        return {
          success: true,
          data: {},
          duration_ms: 50,
          timestamp: new Date().toISOString(),
        };
      });
      const orch = makeOrchestrator({ registry, planner, executor });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(false);
      expect(result.plan.steps[0].status).toBe("success");
      expect(result.plan.steps[1].status).toBe("failed");
    });

    it("all steps fail (independent steps)", async () => {
      const steps = [
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "vmware_list_vms"),
      ];
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan(steps));
      const executor = makeMockExecutor();
      executor.executeStep.mockResolvedValue({
        success: false,
        error: "All broken",
        duration_ms: 10,
        timestamp: new Date().toISOString(),
      });
      const orch = makeOrchestrator({ registry, planner, executor });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(false);
      expect(result.step_results.every((r) => !r.result.success)).toBe(true);
    });

    it("plan generation throws non-Error — handled gracefully", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner();
      planner.plan.mockRejectedValue("string error");
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.success).toBe(false);
      expect(result.plan.reasoning).toContain("Planning failed");
      expect(result.plan.reasoning).toContain("string error");
    });

    it("observer throws — execution continues (non-fatal)", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(
        makePlan([makeStep("s1", "proxmox_list_vms")]),
      );
      const observer = makeMockObserver();
      observer.observe.mockRejectedValue(new Error("Observer crashed"));
      const orch = makeOrchestrator({ registry, planner, observer });

      const result = await orch.executeGoal(makeGoal(), "build");
      // Step should still be marked as success since executor succeeded
      expect(result.success).toBe(true);
    });

    it("system tool steps do not count as provider usage", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan([makeStep("s1", "ping")]));
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.providers_used).toEqual([]);
      expect(result.cross_provider).toBe(false);
    });

    it("unknown tool action — getStepProvider returns 'unknown'", async () => {
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(
        makePlan([makeStep("s1", "nonexistent_tool")]),
      );
      const orch = makeOrchestrator({ registry, planner });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.step_results[0].provider).toBe("unknown");
    });

    it("transitive dependency skip: s1 fails -> s2 (depends s1) skipped -> s3 (depends s2) skipped", async () => {
      const steps = [
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "proxmox_create_vm", ["s1"]),
        makeStep("s3", "proxmox_create_vm", ["s2"]),
        makeStep("s4", "vmware_list_vms"), // independent
      ];
      const registry = makeMockRegistry(
        makeMultiClusterState([
          makeProviderState("proxmox", "proxmox"),
        ]),
      );
      const planner = makeMockPlanner(makePlan(steps));
      const executor = makeMockExecutor();
      executor.executeStep.mockImplementation(async (step: PlanStep) => {
        if (step.id === "s1") {
          return {
            success: false,
            error: "Failed",
            duration_ms: 10,
            timestamp: new Date().toISOString(),
          };
        }
        return {
          success: true,
          data: {},
          duration_ms: 50,
          timestamp: new Date().toISOString(),
        };
      });
      const orch = makeOrchestrator({ registry, planner, executor });

      const result = await orch.executeGoal(makeGoal(), "build");
      expect(result.plan.steps[1].status).toBe("skipped");
      expect(result.plan.steps[2].status).toBe("skipped");
      // s4 is independent, should still execute
      expect(result.plan.steps[3].status).toBe("success");
    });
  });

  // ── queryAllProviders edge cases ──────────────────────────

  describe("queryAllProviders() edge cases", () => {
    it("no providers — returns empty results", async () => {
      const registry = makeMockRegistry(makeMultiClusterState([]));
      const orch = makeOrchestrator({ registry });

      const result = await orch.queryAllProviders("list all");
      expect(result.providers).toHaveLength(0);
      const agg = result.aggregated as any;
      expect(agg.total_vms).toBe(0);
      expect(agg.total_nodes).toBe(0);
      expect(agg.total_containers).toBe(0);
      expect(agg.providers_queried).toBe(0);
    });

    it("provider with null results in aggregation handles gracefully", async () => {
      const provider = makeProviderState("proxmox", "proxmox", {
        nodes: [],
        vms: [],
        containers: [],
        storage: [],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([provider]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.queryAllProviders("list all");
      const agg = result.aggregated as any;
      expect(agg.total_vms).toBe(0);
      expect(agg.total_nodes).toBe(0);
    });

    it("aggregation counts containers from proxmox provider", async () => {
      const provider = makeProviderState("proxmox", "proxmox", {
        containers: [
          {
            id: 200,
            name: "ct-1",
            node: "pve1",
            status: "running",
            cpu_cores: 1,
            ram_mb: 512,
            disk_gb: 5,
          },
          {
            id: 201,
            name: "ct-2",
            node: "pve1",
            status: "stopped",
            cpu_cores: 1,
            ram_mb: 256,
            disk_gb: 2,
          },
        ],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([provider]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.queryAllProviders("list containers");
      const agg = result.aggregated as any;
      expect(agg.total_containers).toBe(2);
    });

    it("mixed success/failure in multi-provider query", async () => {
      // The queryAllProviders code tries to access provider.state directly,
      // so both should succeed unless the state itself is problematic
      const p1 = makeProviderState("proxmox", "proxmox", {
        vms: [
          {
            id: 100,
            name: "vm-1",
            node: "pve1",
            status: "running",
            cpu_cores: 2,
            ram_mb: 2048,
            disk_gb: 20,
          },
        ],
      });
      const p2 = makeProviderState("vmware", "vmware", {
        vms: [
          {
            id: "vm-2",
            name: "win",
            node: "esxi1",
            status: "running",
            cpu_cores: 4,
            ram_mb: 8192,
            disk_gb: 100,
          },
        ],
      });
      const registry = makeMockRegistry(
        makeMultiClusterState([p1, p2]),
      );
      const orch = makeOrchestrator({ registry });

      const result = await orch.queryAllProviders("show vms");
      expect(result.providers).toHaveLength(2);
      const agg = result.aggregated as any;
      expect(agg.total_vms).toBe(2);
    });
  });
});
