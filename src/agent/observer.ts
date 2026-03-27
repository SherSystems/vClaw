// ============================================================
// vClaw — Observer
// Compares expected vs actual state after action execution
// ============================================================

import type { PlanStep, StepResult, ClusterState } from "../types.js";
import { callLLM, type AIConfig } from "./llm.js";
import { OBSERVER_PROMPT } from "./prompts.js";

export interface ObservationResult {
  matches: boolean;
  discrepancies: string[];
  severity: "none" | "minor" | "major";
}

/** Read-only actions that don't change state — skip observation entirely. */
const READ_ONLY_ACTIONS = new Set([
  "list_vms",
  "get_vm_status",
  "list_nodes",
  "get_node_stats",
  "get_vm_config",
  "list_snapshots",
  "list_storage",
  "list_isos",
  "list_templates",
  "list_downloaded_templates",
  "get_task_status",
  "list_tasks",
  "wait_for_task",
  "search_logs",
  "list_network_interfaces",
  "get_vm_firewall_rules",
  "get_node_firewall_rules",
  "get_vm_stats",
  "ping",
]);

/** Actions whose outcome can be verified by simple state checks. */
const SIMPLE_VM_ACTIONS = new Set([
  "start_vm",
  "stop_vm",
  "restart_vm",
  "start_container",
  "stop_container",
  "restart_container",
]);

export class Observer {
  /**
   * Observe the outcome of a step by comparing expected vs actual state.
   * Uses simple heuristics for straightforward VM/container actions,
   * falls back to the LLM for complex cases.
   */
  async observe(
    step: PlanStep,
    result: StepResult,
    clusterState: ClusterState | null,
    config: AIConfig,
  ): Promise<ObservationResult> {
    // If the step already failed at the tool level, no observation needed
    if (!result.success) {
      return {
        matches: false,
        discrepancies: [result.error || "Step failed"],
        severity: "major",
      };
    }

    // Read-only actions don't change state — if the tool succeeded, we're good
    if (READ_ONLY_ACTIONS.has(step.action) || step.tier === "read") {
      return { matches: true, discrepancies: [], severity: "none" };
    }

    // For write actions where the provider API returned success (e.g. UPID task),
    // trust the tool result. The LLM observer comparing cluster state snapshots
    // produces false positives because getClusterState() returns summary data
    // that doesn't capture all VM config details.
    if (result.success && result.data !== undefined) {
      return { matches: true, discrepancies: [], severity: "none" };
    }

    // If no state snapshots, we can only trust the tool result
    if (!result.state_before && !result.state_after) {
      return { matches: true, discrepancies: [], severity: "none" };
    }

    // Try simple observation for known action types
    if (SIMPLE_VM_ACTIONS.has(step.action) && clusterState) {
      const simple = this.simpleObserve(step, clusterState);
      if (simple) return simple;
    }

    // Fall back to LLM-based observation for complex cases
    return this.llmObserve(step, result, clusterState, config);
  }

  /**
   * Simple state-check observation for VM/container start/stop actions.
   */
  private simpleObserve(
    step: PlanStep,
    clusterState: ClusterState,
  ): ObservationResult | null {
    const vmid = step.params.vmid ?? step.params.id;
    if (vmid === undefined) return null;

    const targetId = String(vmid);

    if (step.action === "start_vm" || step.action === "restart_vm") {
      const vm = clusterState.vms.find((v) => String(v.id) === targetId);
      if (!vm) {
        return {
          matches: false,
          discrepancies: [`VM ${targetId} not found in cluster state`],
          severity: "major",
        };
      }
      if (vm.status === "running") {
        return { matches: true, discrepancies: [], severity: "none" };
      }
      return {
        matches: false,
        discrepancies: [`VM ${targetId} expected to be running but is ${vm.status}`],
        severity: "major",
      };
    }

    if (step.action === "stop_vm") {
      const vm = clusterState.vms.find((v) => String(v.id) === targetId);
      if (!vm) {
        return {
          matches: false,
          discrepancies: [`VM ${targetId} not found in cluster state`],
          severity: "major",
        };
      }
      if (vm.status === "stopped") {
        return { matches: true, discrepancies: [], severity: "none" };
      }
      return {
        matches: false,
        discrepancies: [`VM ${targetId} expected to be stopped but is ${vm.status}`],
        severity: "major",
      };
    }

    if (step.action === "start_container" || step.action === "restart_container") {
      const ct = clusterState.containers.find((c) => String(c.id) === targetId);
      if (!ct) {
        return {
          matches: false,
          discrepancies: [`Container ${targetId} not found in cluster state`],
          severity: "major",
        };
      }
      if (ct.status === "running") {
        return { matches: true, discrepancies: [], severity: "none" };
      }
      return {
        matches: false,
        discrepancies: [`Container ${targetId} expected to be running but is ${ct.status}`],
        severity: "major",
      };
    }

    if (step.action === "stop_container") {
      const ct = clusterState.containers.find((c) => String(c.id) === targetId);
      if (!ct) {
        return {
          matches: false,
          discrepancies: [`Container ${targetId} not found in cluster state`],
          severity: "major",
        };
      }
      if (ct.status === "stopped") {
        return { matches: true, discrepancies: [], severity: "none" };
      }
      return {
        matches: false,
        discrepancies: [`Container ${targetId} expected to be stopped but is ${ct.status}`],
        severity: "major",
      };
    }

    return null;
  }

  /**
   * LLM-based observation for complex actions where simple state checks
   * are insufficient.
   */
  private async llmObserve(
    step: PlanStep,
    result: StepResult,
    clusterState: ClusterState | null,
    config: AIConfig,
  ): Promise<ObservationResult> {
    const systemPrompt = OBSERVER_PROMPT({
      stepDescription: step.description,
      action: step.action,
      params: JSON.stringify(step.params, null, 2),
      stateBefore: result.state_before
        ? JSON.stringify(result.state_before, null, 2)
        : "Not captured.",
      stateAfter: result.state_after
        ? JSON.stringify(result.state_after, null, 2)
        : "Not captured.",
      clusterStateSummary: clusterState
        ? JSON.stringify(clusterState, null, 2)
        : "Not available.",
    });

    const userMessage = `Verify whether the action "${step.action}" achieved its intended effect: "${step.description}"`;

    try {
      const response = await callLLM({
        system: systemPrompt,
        user: userMessage,
        config,
      });

      const parsed = JSON.parse(response) as {
        matches: boolean;
        discrepancies: string[];
        severity: "none" | "minor" | "major";
      };

      return {
        matches: parsed.matches ?? true,
        discrepancies: parsed.discrepancies ?? [],
        severity: parsed.severity ?? "none",
      };
    } catch (err) {
      // If LLM observation fails, trust the tool result
      console.warn(
        "LLM observation failed, trusting tool result:",
        err instanceof Error ? err.message : String(err),
      );
      return { matches: true, discrepancies: [], severity: "none" };
    }
  }
}
