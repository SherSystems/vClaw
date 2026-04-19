import { beforeEach, describe, expect, it, vi } from "vitest";
import { Planner, type PlanningContext } from "../../src/agent/planner.js";
import { callLLM } from "../../src/agent/llm.js";
import type { Goal, Plan, PlanStep, ToolDefinition } from "../../src/types.js";

vi.mock("../../src/agent/llm.js", () => ({
  callLLM: vi.fn(),
}));

const callLLMMock = vi.mocked(callLLM);

const tools: ToolDefinition[] = [
  {
    name: "list_vms",
    description: "List virtual machines",
    tier: "read",
    adapter: "proxmox",
    params: [],
    returns: "VMInfo[]",
  },
  {
    name: "start_vm",
    description: "Start a VM",
    tier: "safe_write",
    adapter: "proxmox",
    params: [{ name: "vmid", type: "number", required: true, description: "VM ID" }],
    returns: "void",
  },
];

function makeGoal(): Goal {
  return {
    id: "goal-1",
    mode: "build",
    description: "Ensure VM is healthy",
    raw_input: "Bring VM 101 back online",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeContext(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return {
    tools,
    clusterState: null,
    memory: [],
    config: {
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-test",
    },
    ...overrides,
  };
}

function makePlanStep(id: string, action: string, status: PlanStep["status"] = "pending"): PlanStep {
  return {
    id,
    action,
    params: {},
    description: `${action} step`,
    depends_on: [],
    status,
    tier: "read",
  };
}

function makePlan(): Plan {
  return {
    id: "plan-1",
    goal_id: "goal-1",
    steps: [makePlanStep("s1", "list_vms", "success"), makePlanStep("s2", "start_vm", "pending")],
    created_at: "2026-01-01T00:00:00.000Z",
    status: "pending",
    resource_estimate: {
      ram_mb: 64,
      disk_gb: 1,
      cpu_cores: 1,
      vms_created: 0,
      containers_created: 0,
    },
    reasoning: "baseline plan",
    revision: 2,
  };
}

describe("Planner", () => {
  let planner: Planner;

  beforeEach(() => {
    planner = new Planner();
    callLLMMock.mockReset();
  });

  it("creates a valid pending plan with default resource estimate fallback", async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify({
        steps: [
          {
            id: "s1",
            action: "list_vms",
            params: {},
            description: "List VMs",
            depends_on: [],
          },
          {
            id: "s2",
            action: "start_vm",
            params: { vmid: 101 },
            description: "Start VM 101",
            depends_on: ["s1"],
          },
        ],
        reasoning: "Check state then remediate",
      }),
    );

    const plan = await planner.plan(makeGoal(), makeContext());

    expect(plan.goal_id).toBe("goal-1");
    expect(plan.status).toBe("pending");
    expect(plan.revision).toBe(1);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].status).toBe("pending");
    expect(plan.steps[0].tier).toBe("read");
    expect(plan.steps[1].tier).toBe("safe_write");
    expect(plan.resource_estimate).toEqual({
      ram_mb: 0,
      disk_gb: 0,
      cpu_cores: 0,
      vms_created: 0,
      containers_created: 0,
    });
  });

  it("rejects plans that reference unknown tools", async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify({
        steps: [
          {
            id: "s1",
            action: "destroy_everything",
            params: {},
            description: "Bad tool",
            depends_on: [],
          },
        ],
        reasoning: "invalid",
        resource_estimate: { ram_mb: 1, disk_gb: 1, cpu_cores: 1, vms_created: 0, containers_created: 0 },
      }),
    );

    await expect(planner.plan(makeGoal(), makeContext())).rejects.toThrow(
      'Plan references unknown tool "destroy_everything"',
    );
  });

  it("rejects unknown dependencies", async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify({
        steps: [
          {
            id: "s1",
            action: "list_vms",
            params: {},
            description: "List VMs",
            depends_on: ["missing-step"],
          },
        ],
        reasoning: "invalid dependency",
        resource_estimate: { ram_mb: 1, disk_gb: 1, cpu_cores: 1, vms_created: 0, containers_created: 0 },
      }),
    );

    await expect(planner.plan(makeGoal(), makeContext())).rejects.toThrow(
      'depends on unknown step "missing-step"',
    );
  });

  it("rejects dependency cycles", async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify({
        steps: [
          {
            id: "s1",
            action: "list_vms",
            params: {},
            description: "First",
            depends_on: ["s2"],
          },
          {
            id: "s2",
            action: "start_vm",
            params: { vmid: 101 },
            description: "Second",
            depends_on: ["s1"],
          },
        ],
        reasoning: "cyclic",
        resource_estimate: { ram_mb: 1, disk_gb: 1, cpu_cores: 1, vms_created: 0, containers_created: 0 },
      }),
    );

    await expect(planner.plan(makeGoal(), makeContext())).rejects.toThrow(
      "Dependency cycle detected",
    );
  });

  it("surfaces malformed JSON responses", async () => {
    callLLMMock.mockResolvedValue("not-json");

    await expect(planner.plan(makeGoal(), makeContext())).rejects.toThrow(
      "Failed to parse LLM plan response as JSON",
    );
  });

  it("surfaces field-level schema errors for malformed step payloads", async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify({
        steps: [
          {
            id: "s1",
            action: 42,
            params: {},
            description: "Invalid step payload",
            depends_on: "s0",
          },
        ],
        reasoning: "invalid shape",
        resource_estimate: { ram_mb: 1, disk_gb: 1, cpu_cores: 1, vms_created: 0, containers_created: 0 },
      }),
    );

    await expect(planner.plan(makeGoal(), makeContext())).rejects.toThrow(
      "Invalid LLM plan response schema: steps[0].action: Expected string, received number; steps[0].depends_on: Expected array, received string",
    );
  });

  it("surfaces missing required top-level fields", async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify({
        resource_estimate: { ram_mb: 1, disk_gb: 1, cpu_cores: 1, vms_created: 0, containers_created: 0 },
      }),
    );

    await expect(planner.plan(makeGoal(), makeContext())).rejects.toThrow(
      "Invalid LLM plan response schema: steps: Required; reasoning: Required",
    );
  });

  it("replans with incremented revision and previous plan linkage", async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify({
        steps: [
          {
            id: "r1",
            action: "list_vms",
            params: {},
            description: "Re-check VM state",
            depends_on: [],
          },
        ],
        reasoning: "recover by re-checking state first",
        resource_estimate: { ram_mb: 8, disk_gb: 1, cpu_cores: 1, vms_created: 0, containers_created: 0 },
      }),
    );

    const previousPlan = makePlan();
    const failedStep = makePlanStep("s2", "start_vm", "failed");

    const replanned = await planner.replan(
      previousPlan,
      failedStep,
      "adapter timeout",
      makeContext(),
    );

    expect(replanned.revision).toBe(previousPlan.revision + 1);
    expect(replanned.previous_plan_id).toBe(previousPlan.id);
    expect(replanned.goal_id).toBe(previousPlan.goal_id);
    expect(replanned.steps).toHaveLength(1);
    expect(replanned.steps[0].action).toBe("list_vms");
  });

  it("allows empty replans when the model returns no next steps", async () => {
    callLLMMock.mockResolvedValue(
      JSON.stringify({
        steps: [],
        reasoning: "No further automated action required",
      }),
    );

    const replanned = await planner.replan(
      makePlan(),
      makePlanStep("s2", "start_vm", "failed"),
      "already healthy",
      makeContext(),
    );

    expect(replanned.steps).toHaveLength(0);
    expect(replanned.resource_estimate).toEqual({
      ram_mb: 0,
      disk_gb: 0,
      cpu_cores: 0,
      vms_created: 0,
      containers_created: 0,
    });
  });
});
