// ============================================================
// vClaw — Chaos Engine
// Simulate and execute failure scenarios to validate resilience
// ============================================================

import { randomUUID } from "node:crypto";
import type { AgentCore } from "../agent/core.js";
import type { EventBus } from "../agent/events.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { HealingOrchestrator } from "../healing/orchestrator.js";
import type { Incident } from "../healing/incidents.js";
import { AgentEventType } from "../types.js";
import type { VMInfo, ClusterState } from "../types.js";
import type { ChaosScenario, ChaosAction } from "./scenarios.js";
import { getScenario, getAllScenarios } from "./scenarios.js";

// ── Interfaces ──────────────────────────────────────────────

export interface BlastRadiusResult {
  affected_vms: Array<{
    vmid: string;
    name: string;
    node: string;
    status: string;
    will_be_affected: boolean;
    expected_recovery: string;
  }>;
  total_affected: number;
  critical_services_affected: number;
  estimated_downtime_s: number;
}

export interface ChaosRun {
  id: string;
  scenario: ChaosScenario;
  status:
    | "pending"
    | "simulating"
    | "executing"
    | "recovering"
    | "verifying"
    | "completed"
    | "failed";
  started_at: string;
  completed_at?: string;

  /** Simulation results (computed before execution) */
  simulation: {
    blast_radius: BlastRadiusResult;
    predicted_recovery_time_s: number;
    risk_score: number; // 0-100
    recommendation: string;
  };

  /** Actual execution results (populated after execution) */
  actual?: {
    recovery_time_s: number;
    all_recovered: boolean;
    incidents_created: string[];
    steps_executed: number;
  };

  /** Predicted-vs-actual comparison */
  score?: {
    predicted_vs_actual_recovery: string;
    resilience_pct: number; // what % of affected VMs recovered
    verdict: "pass" | "partial" | "fail";
  };
}

export interface ChaosEngineOptions {
  agentCore: AgentCore;
  toolRegistry: ToolRegistry;
  eventBus: EventBus;
  healingOrchestrator: HealingOrchestrator;
}

// ── Constants ───────────────────────────────────────────────

/** VM IDs that must NEVER be targeted by chaos (e.g. the VM running vClaw itself) */
const PROTECTED_VMIDS = new Set(
  (process.env.CHAOS_PROTECTED_VMIDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

/** Maximum time (ms) to wait for healing to complete before declaring failure */
const MAX_RECOVERY_WAIT_MS = 5 * 60 * 1000;
/** Polling interval (ms) while waiting for recovery */
const RECOVERY_POLL_MS = 5_000;
/** Default predicted recovery time when no historical data exists */
const DEFAULT_PREDICTED_RECOVERY_S = 60;

// ── ChaosEngine ─────────────────────────────────────────────

export class ChaosEngine {
  private agentCore: AgentCore;
  private toolRegistry: ToolRegistry;
  private eventBus: EventBus;
  private healingOrchestrator: HealingOrchestrator;

  private history: ChaosRun[] = [];
  private activeRun: ChaosRun | null = null;

  constructor(options: ChaosEngineOptions) {
    this.agentCore = options.agentCore;
    this.toolRegistry = options.toolRegistry;
    this.eventBus = options.eventBus;
    this.healingOrchestrator = options.healingOrchestrator;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Run blast-radius analysis for a scenario WITHOUT executing it.
   * This is the star function: it queries the current cluster state,
   * identifies every VM/resource that would be affected, and uses
   * historical incident data to predict recovery time.
   */
  async simulate(
    scenarioId: string,
    params?: Record<string, unknown>,
  ): Promise<ChaosRun> {
    const scenario = this.resolveScenario(scenarioId);
    const run = this.createRun(scenario);
    run.status = "simulating";

    try {
      const clusterState = await this.toolRegistry.getClusterState();
      if (!clusterState) {
        throw new Error("Cannot simulate: no cluster state available (adapter disconnected?)");
      }

      const blastRadius = this.computeBlastRadius(scenario, clusterState, params);
      const predictedRecovery = this.predictRecoveryTime(scenario, blastRadius);
      const riskScore = this.computeRiskScore(scenario, blastRadius, clusterState);
      const recommendation = this.generateRecommendation(scenario, blastRadius, riskScore);

      run.simulation = {
        blast_radius: blastRadius,
        predicted_recovery_time_s: predictedRecovery,
        risk_score: riskScore,
        recommendation,
      };

      run.status = "pending";
      this.emitEvent(AgentEventType.ChaosSimulated, {
        run_id: run.id,
        scenario_id: scenario.id,
        total_affected: blastRadius.total_affected,
        predicted_recovery_s: predictedRecovery,
        risk_score: riskScore,
        recommendation,
      });

      return run;
    } catch (err) {
      run.status = "failed";
      run.completed_at = new Date().toISOString();
      this.history.push(run);
      throw err;
    }
  }

  /**
   * Actually execute a chaos scenario: inject failures, then wait for
   * the healing orchestrator to detect and recover. Simulation runs
   * automatically as the first step.
   */
  async execute(
    scenarioId: string,
    params?: Record<string, unknown>,
  ): Promise<ChaosRun> {
    if (this.activeRun) {
      throw new Error(
        `A chaos run is already active: ${this.activeRun.id} (scenario: ${this.activeRun.scenario.id}). ` +
        `Only one run at a time is allowed.`,
      );
    }

    // Step 1: Simulate to get blast radius
    const run = await this.simulate(scenarioId, params);

    if (run.scenario.requires_approval && run.simulation.risk_score > 70) {
      run.simulation.recommendation =
        `[BLOCKED] Risk score ${run.simulation.risk_score}/100 exceeds safe threshold. ` +
        run.simulation.recommendation;
    }

    this.activeRun = run;
    run.status = "executing";
    const executionStart = Date.now();

    this.emitEvent(AgentEventType.ChaosStarted, {
      run_id: run.id,
      scenario_id: run.scenario.id,
      scenario_name: run.scenario.name,
      severity: run.scenario.severity,
      total_affected: run.simulation.blast_radius.total_affected,
      affected_vms: run.simulation.blast_radius.affected_vms
        .filter((v) => v.will_be_affected)
        .map((v) => ({ vmid: v.vmid, name: v.name, node: v.node })),
    });

    try {
      // Step 2: Inject failures
      const clusterState = await this.toolRegistry.getClusterState();
      if (!clusterState) {
        throw new Error("Cluster state unavailable during execution");
      }

      const stepsExecuted = await this.injectFailures(run.scenario, clusterState, params);

      // Step 3: Wait for healing
      run.status = "recovering";
      this.emitEvent(AgentEventType.ChaosRecoveryDetected, {
        run_id: run.id,
        scenario_id: run.scenario.id,
        message: "Failures injected, waiting for healing orchestrator to respond",
      });

      const affectedVmids = run.simulation.blast_radius.affected_vms
        .filter((v) => v.will_be_affected)
        .map((v) => v.vmid);

      const recoveryResult = await this.waitForRecovery(
        affectedVmids,
        run.scenario.expected_recovery.max_recovery_time_s * 1000,
      );

      const recoveryTimeS = (Date.now() - executionStart) / 1000;

      // Step 4: Verify and score
      run.status = "verifying";
      const incidentsCreated = this.findRelevantIncidents(affectedVmids, executionStart);

      run.actual = {
        recovery_time_s: Math.round(recoveryTimeS * 10) / 10,
        all_recovered: recoveryResult.allRecovered,
        incidents_created: incidentsCreated.map((i) => i.id),
        steps_executed: stepsExecuted,
      };

      run.score = this.scoreRun(run);
      run.status = "completed";
      run.completed_at = new Date().toISOString();

      this.emitEvent(AgentEventType.ChaosCompleted, {
        run_id: run.id,
        scenario_id: run.scenario.id,
        verdict: run.score.verdict,
        resilience_pct: run.score.resilience_pct,
        predicted_recovery_s: run.simulation.predicted_recovery_time_s,
        actual_recovery_s: run.actual.recovery_time_s,
        all_recovered: run.actual.all_recovered,
        incidents_created: run.actual.incidents_created.length,
      });

      this.history.push(run);
      this.activeRun = null;
      return run;
    } catch (err) {
      run.status = "failed";
      run.completed_at = new Date().toISOString();

      const errMsg = err instanceof Error ? err.message : String(err);
      this.emitEvent(AgentEventType.ChaosFailed, {
        run_id: run.id,
        scenario_id: run.scenario.id,
        error: errMsg,
      });

      this.history.push(run);
      this.activeRun = null;
      throw err;
    }
  }

  /**
   * Get all past chaos runs.
   */
  getHistory(): ChaosRun[] {
    return [...this.history];
  }

  /**
   * Get the currently executing chaos run, if any.
   */
  getActiveRun(): ChaosRun | null {
    return this.activeRun;
  }

  /**
   * Cancel the currently active chaos run.
   */
  cancel(): ChaosRun | null {
    if (!this.activeRun) return null;
    const run = this.activeRun;
    run.status = "failed";
    run.completed_at = new Date().toISOString();
    this.emitEvent(AgentEventType.ChaosFailed, {
      run_id: run.id,
      scenario_id: run.scenario.id,
      error: "Cancelled by operator",
    });
    this.history.push(run);
    this.activeRun = null;
    return run;
  }

  /**
   * List all available scenarios (built-in).
   */
  listScenarios(): ChaosScenario[] {
    return getAllScenarios();
  }

  // ── Blast Radius Analysis ─────────────────────────────────

  private computeBlastRadius(
    scenario: ChaosScenario,
    clusterState: ClusterState,
    params?: Record<string, unknown>,
  ): BlastRadiusResult {
    const runningVMs = clusterState.vms.filter(
      (v) => v.status === "running" && !PROTECTED_VMIDS.has(String(v.id)),
    );
    const affectedVMs: BlastRadiusResult["affected_vms"] = [];

    switch (scenario.id) {
      case "vm_kill": {
        const targetVmid = params?.vmid as string | number | undefined;
        if (!targetVmid) {
          throw new Error("vm_kill scenario requires params.vmid");
        }
        const targetVmidStr = String(targetVmid);
        if (PROTECTED_VMIDS.has(targetVmidStr)) {
          throw new Error(`VM ${targetVmid} is protected — it runs vClaw itself and cannot be targeted`);
        }
        const vm = clusterState.vms.find((v) => String(v.id) === targetVmidStr);
        if (!vm) {
          throw new Error(`VM ${targetVmid} not found in cluster state`);
        }
        affectedVMs.push({
          vmid: String(vm.id),
          name: vm.name,
          node: vm.node,
          status: vm.status,
          will_be_affected: true,
          expected_recovery: "Self-healing restart via vm_stopped playbook",
        });
        break;
      }

      case "random_vm_kill": {
        if (runningVMs.length === 0) {
          throw new Error("No running VMs available for random_vm_kill");
        }
        // Show all running VMs; mark one as the random pick
        const pickIndex = Math.floor(Math.random() * runningVMs.length);
        for (let i = 0; i < runningVMs.length; i++) {
          const vm = runningVMs[i];
          affectedVMs.push({
            vmid: String(vm.id),
            name: vm.name,
            node: vm.node,
            status: vm.status,
            will_be_affected: i === pickIndex,
            expected_recovery:
              i === pickIndex
                ? "Self-healing restart via vm_stopped playbook"
                : "Not affected",
          });
        }
        break;
      }

      case "multi_vm_kill": {
        const count = Math.min(
          (params?.count as number) || 2,
          runningVMs.length,
        );
        if (runningVMs.length < 2) {
          throw new Error(
            `multi_vm_kill requires at least 2 running VMs (found ${runningVMs.length})`,
          );
        }
        // Shuffle and pick
        const shuffled = [...runningVMs].sort(() => Math.random() - 0.5);
        const picked = new Set(shuffled.slice(0, count).map((v) => String(v.id)));

        for (const vm of runningVMs) {
          affectedVMs.push({
            vmid: String(vm.id),
            name: vm.name,
            node: vm.node,
            status: vm.status,
            will_be_affected: picked.has(String(vm.id)),
            expected_recovery: picked.has(String(vm.id))
              ? "Concurrent self-healing restart"
              : "Not affected",
          });
        }
        break;
      }

      case "node_drain": {
        const targetNode = params?.node as string | undefined;
        if (!targetNode) {
          throw new Error("node_drain scenario requires params.node");
        }
        const nodeExists = clusterState.nodes.some(
          (n) => n.name === targetNode,
        );
        if (!nodeExists) {
          throw new Error(`Node "${targetNode}" not found in cluster state`);
        }

        for (const vm of clusterState.vms) {
          const onTargetNode = vm.node === targetNode;
          affectedVMs.push({
            vmid: String(vm.id),
            name: vm.name,
            node: vm.node,
            status: vm.status,
            will_be_affected: onTargetNode && vm.status === "running",
            expected_recovery: onTargetNode
              ? "Bulk restart or migration after node failure detection"
              : "Not affected (different node)",
          });
        }
        break;
      }

      case "cpu_stress":
      case "memory_pressure":
      case "network_partition": {
        const targetVmid = params?.vmid as string | number | undefined;
        if (!targetVmid) {
          throw new Error(`${scenario.id} scenario requires params.vmid`);
        }

        const targetVmidStr = String(targetVmid);
        if (PROTECTED_VMIDS.has(targetVmidStr)) {
          throw new Error(`VM ${targetVmid} is protected — it runs vClaw itself and cannot be targeted`);
        }

        const vm = clusterState.vms.find((v) => String(v.id) === targetVmidStr);
        if (!vm) {
          throw new Error(`VM ${targetVmid} not found in cluster state`);
        }

        affectedVMs.push({
          vmid: String(vm.id),
          name: vm.name,
          node: vm.node,
          status: vm.status,
          will_be_affected: vm.status === "running",
          expected_recovery: scenario.id === "network_partition"
            ? "Connectivity should recover after partition window ends"
            : "Resource pressure should recover after stress window ends",
        });
        break;
      }

      default:
        throw new Error(`Unknown scenario: ${scenario.id}`);
    }

    const affected = affectedVMs.filter((v) => v.will_be_affected);
    // Heuristic: VMs with names containing critical-service keywords
    const criticalPatterns = /\b(db|database|api|gateway|dns|auth|ldap|ad|vcenter)\b/i;
    const criticalCount = affected.filter((v) =>
      criticalPatterns.test(v.name),
    ).length;

    return {
      affected_vms: affectedVMs,
      total_affected: affected.length,
      critical_services_affected: criticalCount,
      estimated_downtime_s: scenario.expected_recovery.max_recovery_time_s,
    };
  }

  // ── Recovery Prediction ───────────────────────────────────

  private predictRecoveryTime(
    scenario: ChaosScenario,
    blastRadius: BlastRadiusResult,
  ): number {
    // Use historical incident data to refine predictions
    const incidentManager = this.healingOrchestrator.incidentManager;
    const recentIncidents = incidentManager.getRecent(50);

    // Find resolved VM-status incidents and compute average resolution time
    const vmResolved = recentIncidents.filter(
      (i) =>
        i.status === "resolved" &&
        i.metric === "vm_status" &&
        i.duration_ms !== undefined,
    );

    let baseRecoveryS: number;
    if (vmResolved.length > 0) {
      const avgMs =
        vmResolved.reduce((sum, i) => sum + (i.duration_ms ?? 0), 0) /
        vmResolved.length;
      baseRecoveryS = Math.round(avgMs / 1000);
    } else {
      baseRecoveryS = DEFAULT_PREDICTED_RECOVERY_S;
    }

    // Scale by blast radius: more VMs = longer recovery
    const scaleFactor = Math.max(1, blastRadius.total_affected * 0.5);
    // Critical services add extra predicted time
    const criticalPenalty = blastRadius.critical_services_affected * 15;

    return Math.round(baseRecoveryS * scaleFactor + criticalPenalty);
  }

  // ── Risk Scoring ──────────────────────────────────────────

  private computeRiskScore(
    scenario: ChaosScenario,
    blastRadius: BlastRadiusResult,
    clusterState: ClusterState,
  ): number {
    let score = 0;

    // Severity contribution (0-30)
    const severityWeights: Record<string, number> = {
      low: 5,
      medium: 15,
      high: 25,
      critical: 30,
    };
    score += severityWeights[scenario.severity] ?? 15;

    // Blast radius contribution (0-30)
    const totalRunning = clusterState.vms.filter(
      (v) => v.status === "running",
    ).length;
    const affectedPct =
      totalRunning > 0
        ? (blastRadius.total_affected / totalRunning) * 100
        : 0;
    score += Math.min(30, Math.round(affectedPct * 0.3));

    // Critical services contribution (0-20)
    score += Math.min(20, blastRadius.critical_services_affected * 10);

    // Cluster health contribution (0-20)
    // If the cluster is already stressed, the risk is higher
    const offlineNodes = clusterState.nodes.filter(
      (n) => n.status !== "online",
    ).length;
    score += Math.min(10, offlineNodes * 5);

    const avgCpuPct =
      clusterState.nodes.length > 0
        ? clusterState.nodes.reduce((s, n) => s + n.cpu_usage_pct, 0) /
          clusterState.nodes.length
        : 0;
    if (avgCpuPct > 70) score += 5;
    if (avgCpuPct > 85) score += 5;

    return Math.min(100, Math.max(0, score));
  }

  // ── Recommendation Generation ─────────────────────────────

  private generateRecommendation(
    scenario: ChaosScenario,
    blastRadius: BlastRadiusResult,
    riskScore: number,
  ): string {
    const parts: string[] = [];

    if (riskScore <= 20) {
      parts.push("Low risk. Safe to execute.");
    } else if (riskScore <= 50) {
      parts.push("Moderate risk. Review blast radius before proceeding.");
    } else if (riskScore <= 70) {
      parts.push("Elevated risk. Consider running during a maintenance window.");
    } else {
      parts.push("HIGH RISK. Manual approval strongly recommended.");
    }

    if (blastRadius.critical_services_affected > 0) {
      parts.push(
        `${blastRadius.critical_services_affected} critical service(s) will be affected.`,
      );
    }

    if (blastRadius.total_affected === 0) {
      parts.push("No running VMs would be affected — scenario may be a no-op.");
    }

    if (scenario.requires_approval) {
      parts.push("This scenario requires operator approval.");
    }

    return parts.join(" ");
  }

  // ── Failure Injection ─────────────────────────────────────

  private async injectFailures(
    scenario: ChaosScenario,
    clusterState: ClusterState,
    params?: Record<string, unknown>,
  ): Promise<number> {
    let stepsExecuted = 0;
    const runningVMs = clusterState.vms.filter(
      (v) => v.status === "running" && !PROTECTED_VMIDS.has(String(v.id)),
    );

    for (const action of scenario.actions) {
      if (action.delay_before_ms && action.delay_before_ms > 0) {
        await this.sleep(action.delay_before_ms);
      }

      switch (action.type) {
        case "stop_vm":
        case "kill_vm": {
          const targets = this.resolveTargetVMs(
            action,
            scenario,
            runningVMs,
            params,
          );
          for (const vm of targets) {
            await this.stopVM(vm);
            stepsExecuted++;
          }
          break;
        }

        case "custom_goal": {
          const goalDesc =
            (action.params.goal_description as string) ||
            action.description;
          const goal = {
            id: randomUUID(),
            mode: "build" as const,
            description: goalDesc,
            raw_input: goalDesc,
            created_at: new Date().toISOString(),
          };
          await this.agentCore.run(goal);
          stepsExecuted++;
          break;
        }

        case "stress_cpu":
        case "stress_memory":
        case "disconnect_network": {
          const targets = this.resolveTargetVMs(
            action,
            scenario,
            runningVMs,
            params,
          );
          for (const vm of targets) {
            await this.injectGuestFault(vm, action);
            stepsExecuted++;
          }
          break;
        }

        // fill_disk — placeholder for future implementation
        default:
          console.warn(
            `[chaos] Action type "${action.type}" not yet implemented, skipping`,
          );
          break;
      }
    }

    return stepsExecuted;
  }

  /**
   * Determine which VMs to target for a stop/kill action based on
   * the scenario type and user-provided params.
   */
  private resolveTargetVMs(
    _action: ChaosAction,
    scenario: ChaosScenario,
    runningVMs: VMInfo[],
    params?: Record<string, unknown>,
  ): VMInfo[] {
    // Node drain: all running VMs on the target node
    if (_action.params.all_on_node) {
      const node = params?.node as string | undefined;
      if (!node) throw new Error("node_drain requires params.node");
      return runningVMs.filter((v) => v.node === node);
    }

    // Random pick (single or multiple)
    if (_action.params.random) {
      const count = Math.min(
        (_action.params.count as number) || (params?.count as number) || 1,
        runningVMs.length,
      );
      const shuffled = [...runningVMs].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, count);
    }

    // Explicit target by vmid
    const vmid = (params?.vmid as string | number | undefined) ?? _action.target;
    if (vmid !== undefined) {
      const vm = runningVMs.find((v) => String(v.id) === String(vmid));
      if (!vm) {
        throw new Error(
          `Target VM ${vmid} not found or not running`,
        );
      }
      return [vm];
    }

    throw new Error(
      `Cannot resolve target VMs for action "${_action.type}" in scenario "${scenario.id}". ` +
      `Provide params.vmid, params.node, or use a random-pick scenario.`,
    );
  }

  /**
   * Force-stop a VM via the infrastructure adapter.
   */
  private async stopVM(vm: VMInfo): Promise<void> {
    console.log(`[chaos] Stopping VM ${vm.name} (${vm.id}) on ${vm.node}`);
    const vmId = String(vm.id);
    const result = vmId.startsWith("vm-")
      ? await this.toolRegistry.execute("vmware_vm_power_off", {
          vm_id: vmId,
        })
      : await this.toolRegistry.execute("stop_vm", {
          node: vm.node,
          vmid: Number(vm.id),
        });
    if (!result.success) {
      throw new Error(
        `Failed to stop VM ${vm.id} (${vm.name}): ${result.error}`,
      );
    }
  }

  private async injectGuestFault(vm: VMInfo, action: ChaosAction): Promise<void> {
    if (!vm.ip_address) {
      throw new Error(
        `VM ${vm.id} (${vm.name}) has no IP address; cannot execute guest-level chaos action "${action.type}"`,
      );
    }

    const durationS = Math.max(
      1,
      Number(action.params.duration_s ?? 60),
    );

    let command: string;
    if (action.type === "stress_cpu") {
      const workers = Math.max(1, Number(action.params.workers ?? 2));
      command = [
        "sh -lc",
        `'for i in $(seq 1 ${workers}); do yes > /dev/null & done;`,
        `sleep ${durationS};`,
        "pkill -f '^yes$' || true'",
      ].join(" ");
    } else if (action.type === "stress_memory") {
      const bytesMb = Math.max(32, Number(action.params.bytes_mb ?? 512));
      const bytes = bytesMb * 1024 * 1024;
      command = [
        "python3 -c",
        `'import time; _buf=bytearray(${bytes}); time.sleep(${durationS})'`,
      ].join(" ");
    } else {
      command = [
        "sh -lc",
        `'iptables -I INPUT -j DROP; iptables -I OUTPUT -j DROP;`,
        `sleep ${durationS};`,
        "iptables -D INPUT 1 || true; iptables -D OUTPUT 1 || true'",
      ].join(" ");
    }

    const result = await this.toolRegistry.execute("ssh_exec", {
      host: vm.ip_address,
      user: "root",
      command,
      timeout_ms: (durationS + 30) * 1000,
    });
    if (!result.success) {
      throw new Error(
        `Failed to execute "${action.type}" on VM ${vm.id} (${vm.name}): ${result.error}`,
      );
    }
  }

  // ── Recovery Monitoring ───────────────────────────────────

  /**
   * Poll the cluster state until all affected VMs are running again
   * or the timeout expires.
   */
  private async waitForRecovery(
    affectedVmids: string[],
    timeoutMs: number,
  ): Promise<{ allRecovered: boolean; recovered: string[]; notRecovered: string[] }> {
    const deadline = Date.now() + Math.min(timeoutMs, MAX_RECOVERY_WAIT_MS);
    const recoveredSet = new Set<string>();

    while (Date.now() < deadline) {
      await this.sleep(RECOVERY_POLL_MS);

      const state = await this.toolRegistry.getClusterState();
      if (!state) continue;

      for (const vmid of affectedVmids) {
        if (recoveredSet.has(vmid)) continue;
        const vm = state.vms.find((v) => String(v.id) === vmid);
        if (vm && vm.status === "running") {
          recoveredSet.add(vmid);
          console.log(`[chaos] VM ${vmid} recovered (running)`);
        }
      }

      if (recoveredSet.size === affectedVmids.length) {
        break;
      }
    }

    const notRecovered = affectedVmids.filter((id) => !recoveredSet.has(id));
    return {
      allRecovered: notRecovered.length === 0,
      recovered: [...recoveredSet],
      notRecovered,
    };
  }

  /**
   * Find incidents that were opened for the affected VMs during this chaos run.
   */
  private findRelevantIncidents(
    affectedVmids: string[],
    executionStartMs: number,
  ): Incident[] {
    const recent = this.healingOrchestrator.incidentManager.getRecent(50);
    const vmidStrings = new Set(affectedVmids.map(String));

    return recent.filter((incident) => {
      const incidentTime = new Date(incident.detected_at).getTime();
      if (incidentTime < executionStartMs) return false;
      // Match by vmid label
      return vmidStrings.has(incident.labels.vmid);
    });
  }

  // ── Scoring ───────────────────────────────────────────────

  private scoreRun(run: ChaosRun): NonNullable<ChaosRun["score"]> {
    const predicted = run.simulation.predicted_recovery_time_s;
    const actual = run.actual!.recovery_time_s;
    const totalAffected = run.simulation.blast_radius.total_affected;

    // Predicted vs actual comparison
    let comparison: string;
    const diff = actual - predicted;
    const pctDiff =
      predicted > 0 ? Math.round((diff / predicted) * 100) : 0;
    if (Math.abs(pctDiff) <= 10) {
      comparison = `Accurate (predicted ${predicted}s, actual ${actual}s, ${pctDiff > 0 ? "+" : ""}${pctDiff}%)`;
    } else if (actual < predicted) {
      comparison = `Faster than predicted (predicted ${predicted}s, actual ${actual}s, ${pctDiff}%)`;
    } else {
      comparison = `Slower than predicted (predicted ${predicted}s, actual ${actual}s, +${pctDiff}%)`;
    }

    // Resilience percentage
    let resiliencePct: number;
    if (totalAffected === 0) {
      resiliencePct = 100;
    } else if (run.actual!.all_recovered) {
      resiliencePct = 100;
    } else {
      // Count how many VMs actually recovered (incidents resolved)
      const resolvedIncidents = run.actual!.incidents_created.filter((id) => {
        const incident = this.healingOrchestrator.incidentManager.getById(id);
        return incident?.status === "resolved";
      });
      resiliencePct = Math.round(
        (resolvedIncidents.length / totalAffected) * 100,
      );
    }

    // Verdict
    let verdict: "pass" | "partial" | "fail";
    if (
      run.actual!.all_recovered &&
      actual <= run.scenario.expected_recovery.max_recovery_time_s
    ) {
      verdict = "pass";
    } else if (resiliencePct >= 50) {
      verdict = "partial";
    } else {
      verdict = "fail";
    }

    return {
      predicted_vs_actual_recovery: comparison,
      resilience_pct: resiliencePct,
      verdict,
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  private resolveScenario(scenarioId: string): ChaosScenario {
    const scenario = getScenario(scenarioId);
    if (!scenario) {
      const available = getAllScenarios()
        .map((s) => s.id)
        .join(", ");
      throw new Error(
        `Unknown scenario "${scenarioId}". Available: ${available}`,
      );
    }
    return scenario;
  }

  private createRun(scenario: ChaosScenario): ChaosRun {
    return {
      id: randomUUID(),
      scenario,
      status: "pending",
      started_at: new Date().toISOString(),
      simulation: {
        blast_radius: {
          affected_vms: [],
          total_affected: 0,
          critical_services_affected: 0,
          estimated_downtime_s: 0,
        },
        predicted_recovery_time_s: 0,
        risk_score: 0,
        recommendation: "",
      },
    };
  }

  private emitEvent(
    type: AgentEventType,
    data: Record<string, unknown>,
  ): void {
    this.eventBus.emit({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
