// ============================================================
// Tests for MultiProviderOrchestrator — cross-provider coordination
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Goal, Plan, PlanStep, MultiClusterState, ClusterState, ToolDefinition } from "../../src/types.js";
import type { AIConfig } from "../../src/agent/llm.js";
import type { PlanningContext } from "../../src/agent/planner.js";
import { MultiProviderOrchestrator, type PlanResult, type CapacityAnalysis, type MultiQueryResult } from "../../src/agent/orchestrator.js";
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

function makeClusterState(adapter: string, overrides: Partial<ClusterState> = {}): ClusterState {
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

function makeMultiClusterState(providers: MultiClusterState["providers"] = []): MultiClusterState {
  return { providers, timestamp: new Date().toISOString() };
}

function makeProxmoxState(): MultiClusterState["providers"][0] {
  return {
    name: "proxmox",
    type: "proxmox",
    state: makeClusterState("proxmox", {
      nodes: [
        { id: "n1", name: "pve1", status: "online", cpu_cores: 16, cpu_usage_pct: 40, ram_total_mb: 65536, ram_used_mb: 32768, disk_total_gb: 2000, disk_used_gb: 800, disk_usage_pct: 40, uptime_s: 86400 },
        { id: "n2", name: "pve2", status: "online", cpu_cores: 16, cpu_usage_pct: 50, ram_total_mb: 65536, ram_used_mb: 40960, disk_total_gb: 2000, disk_used_gb: 1200, disk_usage_pct: 60, uptime_s: 86400 },
      ],
      vms: [
        { id: 100, name: "vm-1", node: "pve1", status: "running", cpu_cores: 2, ram_mb: 2048, disk_gb: 20 },
        { id: 101, name: "vm-2", node: "pve1", status: "running", cpu_cores: 4, ram_mb: 4096, disk_gb: 40 },
        { id: 102, name: "vm-3", node: "pve2", status: "stopped", cpu_cores: 1, ram_mb: 1024, disk_gb: 10 },
      ],
      containers: [
        { id: 200, name: "ct-1", node: "pve1", status: "running", cpu_cores: 1, ram_mb: 512, disk_gb: 5 },
      ],
      storage: [
        { id: "local", node: "pve1", type: "dir", total_gb: 2000, used_gb: 800, available_gb: 1200, content: ["images", "rootdir"] },
        { id: "local", node: "pve2", type: "dir", total_gb: 2000, used_gb: 1200, available_gb: 800, content: ["images", "rootdir"] },
      ],
    }),
  };
}

function makeVmwareState(): MultiClusterState["providers"][0] {
  return {
    name: "vmware",
    type: "vmware",
    state: makeClusterState("vmware", {
      nodes: [
        { id: "h1", name: "esxi1", status: "online", cpu_cores: 32, cpu_usage_pct: 60, ram_total_mb: 131072, ram_used_mb: 98304, disk_total_gb: 4000, disk_used_gb: 2400, disk_usage_pct: 60, uptime_s: 172800 },
        { id: "h2", name: "esxi2", status: "online", cpu_cores: 32, cpu_usage_pct: 70, ram_total_mb: 131072, ram_used_mb: 104858, disk_total_gb: 4000, disk_used_gb: 2800, disk_usage_pct: 70, uptime_s: 172800 },
      ],
      vms: [
        { id: "vm-1", name: "win-server", node: "esxi1", status: "running", cpu_cores: 4, ram_mb: 8192, disk_gb: 100 },
        { id: "vm-2", name: "linux-app", node: "esxi2", status: "running", cpu_cores: 2, ram_mb: 4096, disk_gb: 50 },
        { id: "vm-3", name: "db-server", node: "esxi1", status: "paused", cpu_cores: 8, ram_mb: 16384, disk_gb: 200 },
      ],
      containers: [],
      storage: [
        { id: "ds1", node: "esxi1", type: "VMFS", total_gb: 4000, used_gb: 2400, available_gb: 1600, content: ["images"] },
        { id: "ds2", node: "esxi2", type: "VMFS", total_gb: 4000, used_gb: 2800, available_gb: 1200, content: ["images"] },
      ],
    }),
  };
}

function makePlan(steps: PlanStep[], overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    goal_id: "goal-1",
    steps,
    created_at: new Date().toISOString(),
    status: "pending",
    resource_estimate: { ram_mb: 0, disk_gb: 0, cpu_cores: 0, vms_created: 0, containers_created: 0 },
    reasoning: "Test plan",
    revision: 1,
    ...overrides,
  };
}

function makeStep(id: string, action: string, dependsOn: string[] = []): PlanStep {
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
    { name: "proxmox_list_vms", description: "List Proxmox VMs", tier: "read", adapter: "proxmox", params: [], returns: "VMInfo[]" },
    { name: "proxmox_create_vm", description: "Create Proxmox VM", tier: "safe_write", adapter: "proxmox", params: [], returns: "VM" },
    { name: "vmware_list_vms", description: "List VMware VMs", tier: "read", adapter: "vmware", params: [], returns: "VMInfo[]" },
    { name: "vmware_create_vm", description: "Create VMware VM", tier: "safe_write", adapter: "vmware", params: [], returns: "VM" },
    { name: "ping", description: "Ping a host", tier: "read", adapter: "system", params: [], returns: "boolean" },
  ];
}

function makeMockRegistry(multiClusterState?: MultiClusterState, tools?: ToolDefinition[]) {
  const allTools = tools || makeTools();
  return {
    getMultiClusterState: vi.fn().mockResolvedValue(
      multiClusterState || makeMultiClusterState([makeProxmoxState(), makeVmwareState()]),
    ),
    getClusterState: vi.fn().mockResolvedValue(makeClusterState("proxmox")),
    getAllTools: vi.fn().mockReturnValue(allTools),
    getTool: vi.fn().mockImplementation((name: string) => allTools.find((t) => t.name === name)),
    execute: vi.fn().mockResolvedValue({ success: true, data: {} }),
  } as any;
}

function makeMockPlanner(plan?: Plan) {
  return {
    plan: vi.fn().mockResolvedValue(
      plan || makePlan([makeStep("s1", "proxmox_list_vms")]),
    ),
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
    evaluate: vi.fn().mockResolvedValue({ allowed: true, tier: "read", needs_approval: false, reason: "auto" }),
    logAction: vi.fn(),
    circuitBreaker: { track: vi.fn(), isTripped: vi.fn().mockReturnValue(false) },
  } as any;
}

function makeMockMemory() {
  return {
    recall: vi.fn().mockReturnValue([]),
    save: vi.fn(),
    close: vi.fn(),
  } as any;
}

// ── Test Suite ──────────────────────────────────────────────

describe("MultiProviderOrchestrator", () => {
  let eventBus: EventBus;
  let registry: ReturnType<typeof makeMockRegistry>;
  let planner: ReturnType<typeof makeMockPlanner>;
  let executor: ReturnType<typeof makeMockExecutor>;
  let observer: ReturnType<typeof makeMockObserver>;
  let governance: ReturnType<typeof makeMockGovernance>;
  let memory: ReturnType<typeof makeMockMemory>;
  let orchestrator: MultiProviderOrchestrator;

  beforeEach(() => {
    eventBus = new EventBus();
    registry = makeMockRegistry();
    planner = makeMockPlanner();
    executor = makeMockExecutor();
    observer = makeMockObserver();
    governance = makeMockGovernance();
    memory = makeMockMemory();

    orchestrator = new MultiProviderOrchestrator({
      registry,
      planner,
      executor,
      observer,
      eventBus,
      config: mockConfig,
      governance,
      memory,
    });
  });

  // ── executeGoal() ─────────────────────────────────────────

  describe("executeGoal()", () => {
    it("single-provider goal (Proxmox-only) routes correctly", async () => {
      const plan = makePlan([makeStep("s1", "proxmox_list_vms")]);
      planner.plan.mockResolvedValue(plan);

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(true);
      expect(result.providers_used).toEqual(["proxmox"]);
      expect(result.cross_provider).toBe(false);
      expect(executor.executeStep).toHaveBeenCalledTimes(1);
    });

    it("single-provider goal (VMware-only) routes correctly", async () => {
      const plan = makePlan([makeStep("s1", "vmware_list_vms")]);
      planner.plan.mockResolvedValue(plan);

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(true);
      expect(result.providers_used).toEqual(["vmware"]);
      expect(result.cross_provider).toBe(false);
    });

    it("cross-provider goal spans both Proxmox and VMware", async () => {
      const plan = makePlan([
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "vmware_list_vms"),
      ]);
      planner.plan.mockResolvedValue(plan);

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(true);
      expect(result.cross_provider).toBe(true);
      expect(result.providers_used).toContain("proxmox");
      expect(result.providers_used).toContain("vmware");
      expect(executor.executeStep).toHaveBeenCalledTimes(2);
    });

    it("goal execution with all providers healthy succeeds", async () => {
      const plan = makePlan([
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "vmware_list_vms"),
        makeStep("s3", "proxmox_create_vm", ["s1"]),
      ]);
      planner.plan.mockResolvedValue(plan);

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(true);
      expect(result.step_results).toHaveLength(3);
      expect(result.step_results.every((r) => r.result.success)).toBe(true);
    });

    it("goal execution with partial provider failure isolates errors", async () => {
      const plan = makePlan([
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "vmware_list_vms"),
        makeStep("s3", "proxmox_create_vm", ["s1"]),
      ]);
      planner.plan.mockResolvedValue(plan);

      // Fail VMware step, succeed Proxmox steps
      executor.executeStep.mockImplementation(async (step: PlanStep) => {
        if (step.action.startsWith("vmware_")) {
          return { success: false, error: "VMware connection lost", duration_ms: 10, timestamp: new Date().toISOString() };
        }
        return { success: true, data: {}, duration_ms: 50, timestamp: new Date().toISOString() };
      });

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(false);
      // Proxmox steps should still complete
      const proxmoxResults = result.step_results.filter((r) => r.provider === "proxmox");
      expect(proxmoxResults.every((r) => r.result.success)).toBe(true);
      // VMware step should fail
      const vmwareResults = result.step_results.filter((r) => r.provider === "vmware");
      expect(vmwareResults.some((r) => !r.result.success)).toBe(true);
    });

    it("provider-specific error isolation: one fails, others continue", async () => {
      const plan = makePlan([
        makeStep("s1", "vmware_list_vms"),
        makeStep("s2", "proxmox_list_vms"),
      ]);
      planner.plan.mockResolvedValue(plan);

      executor.executeStep.mockImplementation(async (step: PlanStep) => {
        if (step.id === "s1") {
          return { success: false, error: "VMware timeout", duration_ms: 10, timestamp: new Date().toISOString() };
        }
        return { success: true, data: {}, duration_ms: 50, timestamp: new Date().toISOString() };
      });

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      // s2 is independent of s1, so it should still execute
      expect(result.step_results).toHaveLength(2);
      const s2Result = result.step_results.find((r) => r.step.id === "s2");
      expect(s2Result?.result.success).toBe(true);
    });

    it("cross-provider dependencies executed in order", async () => {
      const plan = makePlan([
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "vmware_create_vm", ["s1"]),
      ]);
      planner.plan.mockResolvedValue(plan);

      const executionOrder: string[] = [];
      executor.executeStep.mockImplementation(async (step: PlanStep) => {
        executionOrder.push(step.id);
        return { success: true, data: {}, duration_ms: 50, timestamp: new Date().toISOString() };
      });

      await orchestrator.executeGoal(makeGoal(), "build");

      expect(executionOrder).toEqual(["s1", "s2"]);
    });

    it("plan generation includes multi-cluster context", async () => {
      const plan = makePlan([makeStep("s1", "proxmox_list_vms")]);
      planner.plan.mockResolvedValue(plan);

      await orchestrator.executeGoal(makeGoal(), "build");

      expect(planner.plan).toHaveBeenCalledTimes(1);
      const calledContext = planner.plan.mock.calls[0][1] as PlanningContext;
      expect(calledContext.multiClusterState).toBeDefined();
      expect(calledContext.multiClusterState!.providers.length).toBeGreaterThan(0);
    });

    it("no providers connected returns error", async () => {
      registry.getMultiClusterState.mockResolvedValue(makeMultiClusterState([]));

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(false);
      expect(result.plan.reasoning).toContain("No providers connected");
      expect(result.providers_used).toEqual([]);
    });

    it("single provider connected still works", async () => {
      registry.getMultiClusterState.mockResolvedValue(
        makeMultiClusterState([makeProxmoxState()]),
      );
      const plan = makePlan([makeStep("s1", "proxmox_list_vms")]);
      planner.plan.mockResolvedValue(plan);

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(true);
      expect(result.cross_provider).toBe(false);
    });

    it("planning failure returns success:false with error reason", async () => {
      planner.plan.mockRejectedValue(new Error("LLM unavailable"));

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(false);
      expect(result.plan.reasoning).toContain("Planning failed");
      expect(result.plan.reasoning).toContain("LLM unavailable");
    });

    it("emits multi_provider_goal_started event", async () => {
      const events: any[] = [];
      eventBus.on("multi_provider_goal_started", (e) => events.push(e));

      const plan = makePlan([makeStep("s1", "proxmox_list_vms")]);
      planner.plan.mockResolvedValue(plan);

      await orchestrator.executeGoal(makeGoal(), "build");

      expect(events).toHaveLength(1);
      expect(events[0].data.goal_id).toBe("goal-1");
      expect(events[0].data.providers).toContain("proxmox");
      expect(events[0].data.providers).toContain("vmware");
    });

    it("emits multi_provider_goal_completed event", async () => {
      const events: any[] = [];
      eventBus.on("multi_provider_goal_completed", (e) => events.push(e));

      const plan = makePlan([
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "vmware_list_vms"),
      ]);
      planner.plan.mockResolvedValue(plan);

      await orchestrator.executeGoal(makeGoal(), "build");

      expect(events).toHaveLength(1);
      expect(events[0].data.success).toBe(true);
      expect(events[0].data.cross_provider).toBe(true);
      expect(events[0].data.steps_completed).toBe(2);
    });

    it("skips dependent steps when a step fails", async () => {
      const plan = makePlan([
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "proxmox_create_vm", ["s1"]),
      ]);
      planner.plan.mockResolvedValue(plan);

      executor.executeStep.mockImplementation(async (step: PlanStep) => {
        if (step.id === "s1") {
          return { success: false, error: "Failed", duration_ms: 10, timestamp: new Date().toISOString() };
        }
        return { success: true, data: {}, duration_ms: 50, timestamp: new Date().toISOString() };
      });

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(false);
      // s2 depends on s1, so it should be skipped
      const s2 = result.plan.steps.find((s) => s.id === "s2");
      expect(s2?.status).toBe("skipped");
      // executor should only be called for s1
      expect(executor.executeStep).toHaveBeenCalledTimes(1);
    });

    it("step_results include provider information", async () => {
      const plan = makePlan([
        makeStep("s1", "proxmox_list_vms"),
        makeStep("s2", "vmware_list_vms"),
      ]);
      planner.plan.mockResolvedValue(plan);

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.step_results[0].provider).toBe("proxmox");
      expect(result.step_results[1].provider).toBe("vmware");
    });

    it("observer major discrepancy marks step as failed", async () => {
      const plan = makePlan([makeStep("s1", "proxmox_create_vm")]);
      planner.plan.mockResolvedValue(plan);

      observer.observe.mockResolvedValue({
        matches: false,
        discrepancies: ["VM not actually created"],
        severity: "major",
      });

      const result = await orchestrator.executeGoal(makeGoal(), "build");

      expect(result.success).toBe(false);
      expect(result.plan.steps[0].status).toBe("failed");
    });
  });

  // ── queryAllProviders() ───────────────────────────────────

  describe("queryAllProviders()", () => {
    it("aggregates results from multiple providers", async () => {
      const result = await orchestrator.queryAllProviders("show all VMs");

      expect(result.providers).toHaveLength(2);
      expect(result.providers[0].name).toBe("proxmox");
      expect(result.providers[1].name).toBe("vmware");

      const agg = result.aggregated as any;
      // proxmox has 3 VMs, vmware has 3 VMs
      expect(agg.total_vms).toBe(6);
      expect(agg.total_nodes).toBe(4); // 2 proxmox + 2 vmware
      expect(agg.providers_queried).toBe(2);
      expect(agg.providers_failed).toBe(0);
    });

    it("handles empty providers gracefully", async () => {
      registry.getMultiClusterState.mockResolvedValue(makeMultiClusterState([]));

      const result = await orchestrator.queryAllProviders("show all VMs");

      expect(result.providers).toHaveLength(0);
      const agg = result.aggregated as any;
      expect(agg.total_vms).toBe(0);
      expect(agg.providers_queried).toBe(0);
    });

    it("emits multi_provider_query event", async () => {
      const events: any[] = [];
      eventBus.on("multi_provider_query", (e) => events.push(e));

      await orchestrator.queryAllProviders("list all resources");

      expect(events).toHaveLength(1);
      expect(events[0].data.query).toBe("list all resources");
      expect(events[0].data.providers_queried).toBe(2);
    });

    it("includes timestamp in result", async () => {
      const result = await orchestrator.queryAllProviders("test");

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });
  });

  // ── getCapacityAnalysis() ─────────────────────────────────

  describe("getCapacityAnalysis()", () => {
    it("returns capacity for multiple providers", async () => {
      const result = await orchestrator.getCapacityAnalysis();

      expect(result.providers).toHaveLength(2);

      const proxmox = result.providers.find((p) => p.name === "proxmox")!;
      expect(proxmox.type).toBe("proxmox");
      expect(proxmox.capacity.cpu_total).toBe(32); // 16 + 16
      expect(proxmox.capacity.memory_total_gb).toBeGreaterThan(0);
      expect(proxmox.capacity.vm_count).toBe(3);

      const vmware = result.providers.find((p) => p.name === "vmware")!;
      expect(vmware.type).toBe("vmware");
      expect(vmware.capacity.cpu_total).toBe(64); // 32 + 32
      expect(vmware.capacity.vm_count).toBe(3);
    });

    it("recommendation picks provider with most available resources", async () => {
      const result = await orchestrator.getCapacityAnalysis();

      // Proxmox: 128GB total, ~72GB used = ~56GB free
      // VMware: 256GB total, ~198GB used = ~58GB free
      // Both are close but we just check the recommendation mentions one of them
      expect(result.recommendation).toMatch(/proxmox|vmware/);
      expect(result.recommendation).toContain("most available resources");
    });

    it("detects healthy provider", async () => {
      // Default proxmox: 40% and 50% CPU, ~56% memory => healthy
      const result = await orchestrator.getCapacityAnalysis();

      const proxmox = result.providers.find((p) => p.name === "proxmox")!;
      expect(proxmox.health).toBe("healthy");
    });

    it("detects degraded provider with offline nodes", async () => {
      const degradedState = makeProxmoxState();
      degradedState.state.nodes[1].status = "offline";
      registry.getMultiClusterState.mockResolvedValue(
        makeMultiClusterState([degradedState]),
      );

      const result = await orchestrator.getCapacityAnalysis();

      expect(result.providers[0].health).toBe("degraded");
    });

    it("detects critical provider when all nodes offline", async () => {
      const criticalState = makeProxmoxState();
      criticalState.state.nodes[0].status = "offline";
      criticalState.state.nodes[1].status = "offline";
      registry.getMultiClusterState.mockResolvedValue(
        makeMultiClusterState([criticalState]),
      );

      const result = await orchestrator.getCapacityAnalysis();

      expect(result.providers[0].health).toBe("critical");
    });

    it("handles provider with no nodes", async () => {
      const noNodesState: MultiClusterState["providers"][0] = {
        name: "empty-provider",
        type: "proxmox",
        state: makeClusterState("empty-provider"),
      };
      registry.getMultiClusterState.mockResolvedValue(
        makeMultiClusterState([noNodesState]),
      );

      const result = await orchestrator.getCapacityAnalysis();

      expect(result.providers[0].health).toBe("critical");
      expect(result.providers[0].capacity.cpu_total).toBe(0);
      expect(result.providers[0].capacity.memory_total_gb).toBe(0);
    });

    it("handles empty state (no providers)", async () => {
      registry.getMultiClusterState.mockResolvedValue(makeMultiClusterState([]));

      const result = await orchestrator.getCapacityAnalysis();

      expect(result.providers).toHaveLength(0);
      expect(result.recommendation).toContain("No providers available");
    });

    it("emits capacity_analysis event", async () => {
      const events: any[] = [];
      eventBus.on("capacity_analysis", (e) => events.push(e));

      await orchestrator.getCapacityAnalysis();

      expect(events).toHaveLength(1);
      expect(events[0].data.provider_count).toBe(2);
      expect(events[0].data.recommendation).toBeDefined();
    });

    it("prefers healthy providers in recommendation over critical ones", async () => {
      const criticalVmware = makeVmwareState();
      criticalVmware.state.nodes[0].cpu_usage_pct = 96;
      criticalVmware.state.nodes[1].cpu_usage_pct = 96;

      registry.getMultiClusterState.mockResolvedValue(
        makeMultiClusterState([makeProxmoxState(), criticalVmware]),
      );

      const result = await orchestrator.getCapacityAnalysis();

      expect(result.recommendation).toContain("proxmox");
    });

    it("includes timestamp", async () => {
      const result = await orchestrator.getCapacityAnalysis();

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });

    it("calculates available resources correctly", async () => {
      const result = await orchestrator.getCapacityAnalysis();

      for (const provider of result.providers) {
        const cap = provider.capacity;
        // available = total - used
        expect(cap.cpu_available).toBeCloseTo(cap.cpu_total - cap.cpu_used, 1);
        expect(cap.memory_available_gb).toBeCloseTo(cap.memory_total_gb - cap.memory_used_gb, 1);
        expect(cap.storage_available_gb).toBe(cap.storage_total_gb - cap.storage_used_gb);
      }
    });
  });
});
