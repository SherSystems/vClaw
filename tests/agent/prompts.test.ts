import { describe, it, expect } from "vitest";
import {
  PLANNER_PROMPT,
  REPLANNER_PROMPT,
  INVESTIGATOR_PROMPT,
  OBSERVER_PROMPT,
} from "../../src/agent/prompts.js";

describe("PLANNER_PROMPT", () => {
  it("returns a string containing planning engine, tool descriptions, cluster state, and memory context", () => {
    const result = PLANNER_PROMPT({
      toolDescriptions: "tool: create_vm — creates a VM",
      clusterStateSummary: "3 nodes, 16GB free RAM",
      memoryContext: "User prefers Ubuntu images",
    });

    expect(result).toContain("planning engine");
    expect(result).toContain("tool: create_vm — creates a VM");
    expect(result).toContain("3 nodes, 16GB free RAM");
    expect(result).toContain("User prefers Ubuntu images");
  });

  it("uses fallback strings when context values are empty", () => {
    const result = PLANNER_PROMPT({
      toolDescriptions: "",
      clusterStateSummary: "",
      memoryContext: "",
    });

    expect(result).toContain("planning engine");
    expect(result).toContain("No tools registered.");
    expect(result).toContain("No cluster state available.");
    expect(result).toContain("No prior memory.");
  });
});

describe("REPLANNER_PROMPT", () => {
  it("returns a string containing replanning engine, original plan, failed step, and failure error", () => {
    const result = REPLANNER_PROMPT({
      toolDescriptions: "tool: create_vm",
      clusterStateSummary: "2 nodes online",
      originalPlan: '{"steps": []}',
      failedStep: "step_2: start_vm",
      failureError: "VM 101 not found",
      completedSteps: "step_1: create_vm completed",
      remainingSteps: "step_3: configure_vm",
    });

    expect(result).toContain("replanning engine");
    expect(result).toContain('{"steps": []}');
    expect(result).toContain("step_2: start_vm");
    expect(result).toContain("VM 101 not found");
    expect(result).toContain("step_1: create_vm completed");
    expect(result).toContain("step_3: configure_vm");
  });

  it("uses 'None' fallback when completedSteps and remainingSteps are empty", () => {
    const result = REPLANNER_PROMPT({
      toolDescriptions: "tool: create_vm",
      clusterStateSummary: "2 nodes online",
      originalPlan: '{"steps": []}',
      failedStep: "step_1: create_vm",
      failureError: "timeout",
      completedSteps: "",
      remainingSteps: "",
    });

    expect(result).toContain("replanning engine");
    // The prompt uses "None" as fallback for empty completed/remaining steps
    const completedSection = result.split("## Steps Already Completed")[1].split("##")[0];
    expect(completedSection.trim()).toBe("None");

    const remainingSection = result.split("## Remaining Steps (not yet executed)")[1].split("##")[0];
    expect(remainingSection.trim()).toBe("None");
  });
});

describe("INVESTIGATOR_PROMPT", () => {
  it("returns a string containing investigation engine, cluster state, events, and audit", () => {
    const result = INVESTIGATOR_PROMPT({
      clusterStateSummary: "node1: degraded",
      recentEvents: "VM 102 crashed at 14:00",
      recentAudit: "user admin deleted snapshot",
    });

    expect(result).toContain("investigation engine");
    expect(result).toContain("node1: degraded");
    expect(result).toContain("VM 102 crashed at 14:00");
    expect(result).toContain("user admin deleted snapshot");
  });
});

describe("OBSERVER_PROMPT", () => {
  it("returns a string containing observation engine, action, params, and state before/after", () => {
    const result = OBSERVER_PROMPT({
      stepDescription: "Create a new VM with 4GB RAM",
      action: "create_vm",
      params: '{"node": "pve1", "ram": 4096}',
      stateBefore: "3 VMs running",
      stateAfter: "4 VMs running",
      clusterStateSummary: "pve1: healthy",
    });

    expect(result).toContain("observation engine");
    expect(result).toContain("create_vm");
    expect(result).toContain('{"node": "pve1", "ram": 4096}');
    expect(result).toContain("3 VMs running");
    expect(result).toContain("4 VMs running");
    expect(result).toContain("Create a new VM with 4GB RAM");
  });
});
