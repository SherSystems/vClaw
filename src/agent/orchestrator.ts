// ============================================================
// vClaw — Multi-Provider Orchestrator
// Coordinates cross-provider operations: enriches planning context
// with multi-cluster state, handles cross-provider dependencies,
// and aggregates results across providers.
// ============================================================

import type {
  Goal,
  Plan,
  PlanStep,
  StepResult,
  AgentMode,
  ProviderType,
  MultiClusterState,
} from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Planner, PlanningContext } from "./planner.js";
import type { Executor } from "./executor.js";
import type { Observer, ObservationResult } from "./observer.js";
import type { EventBus } from "./events.js";
import type { AIConfig } from "./llm.js";
import type { GovernanceEngineRef } from "./executor.js";
import type { AgentMemory } from "./memory.js";

// ── Types ───────────────────────────────────────────────────

export interface MultiQueryResult {
  providers: Array<{
    name: string;
    type: ProviderType;
    results: unknown;
    error?: string;
  }>;
  aggregated: unknown;
  timestamp: string;
}

export interface CapacityAnalysis {
  providers: Array<{
    name: string;
    type: ProviderType;
    capacity: {
      cpu_total: number;
      cpu_used: number;
      cpu_available: number;
      memory_total_gb: number;
      memory_used_gb: number;
      memory_available_gb: number;
      storage_total_gb: number;
      storage_used_gb: number;
      storage_available_gb: number;
      vm_count: number;
    };
    health: "healthy" | "degraded" | "critical";
  }>;
  recommendation: string;
  timestamp: string;
}

export interface StepResultWithProvider {
  step: PlanStep;
  result: StepResult;
  provider: string;
}

export interface PlanResult {
  success: boolean;
  plan: Plan;
  step_results: StepResultWithProvider[];
  cross_provider: boolean;
  providers_used: string[];
}

// ── Orchestrator ────────────────────────────────────────────

export class MultiProviderOrchestrator {
  private registry: ToolRegistry;
  private planner: Planner;
  private executor: Executor;
  private observer: Observer;
  private eventBus: EventBus;
  private config: AIConfig;
  private governance: GovernanceEngineRef;
  private memory: AgentMemory;

  constructor(options: {
    registry: ToolRegistry;
    planner: Planner;
    executor: Executor;
    observer: Observer;
    eventBus: EventBus;
    config: AIConfig;
    governance: GovernanceEngineRef;
    memory: AgentMemory;
  }) {
    this.registry = options.registry;
    this.planner = options.planner;
    this.executor = options.executor;
    this.observer = options.observer;
    this.eventBus = options.eventBus;
    this.config = options.config;
    this.governance = options.governance;
    this.memory = options.memory;
  }

  /**
   * Execute a goal that may span multiple providers.
   * Enriches the planning context with multi-cluster state,
   * handles cross-provider dependencies in execution order,
   * and aggregates results across providers.
   */
  async executeGoal(goal: Goal, mode: AgentMode): Promise<PlanResult> {
    // 1. Fetch multi-cluster state
    const multiClusterState = await this.registry.getMultiClusterState();

    if (multiClusterState.providers.length === 0) {
      return {
        success: false,
        plan: this.emptyPlan(goal.id, "No providers connected"),
        step_results: [],
        cross_provider: false,
        providers_used: [],
      };
    }

    // 2. Emit multi-provider goal started
    this.eventBus.emit({
      type: "multi_provider_goal_started",
      timestamp: new Date().toISOString(),
      data: {
        goal_id: goal.id,
        goal: goal.description,
        providers: multiClusterState.providers.map((p) => p.name),
      },
    });

    // 3. Build enriched planning context
    const clusterState = await this.registry.getClusterState();
    const memories = this.memory.recall(undefined, undefined, 20);

    const planningContext: PlanningContext = {
      tools: this.registry.getAllTools(),
      clusterState,
      multiClusterState,
      memory: memories,
      config: this.config,
    };

    // 4. Generate plan
    let plan: Plan;
    try {
      plan = await this.planner.plan(goal, planningContext);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        plan: this.emptyPlan(goal.id, `Planning failed: ${errMsg}`),
        step_results: [],
        cross_provider: false,
        providers_used: [],
      };
    }

    // 5. Determine which providers are used and if cross-provider
    const providersUsed = this.detectProvidersUsed(plan);
    const isCrossProvider = providersUsed.length > 1;

    // 6. Execute steps in dependency order
    const stepResults: StepResultWithProvider[] = [];
    const executed = new Set<string>();
    let allSuccess = true;

    plan.status = "executing";

    while (true) {
      const readySteps = plan.steps.filter(
        (s) =>
          s.status === "pending" &&
          s.depends_on.every((dep) => executed.has(dep)),
      );

      if (readySteps.length === 0) break;

      for (const step of readySteps) {
        step.status = "running";

        // Determine which provider this step targets
        const provider = this.getStepProvider(step);

        const result = await this.executor.executeStep(step, mode, plan.id);
        step.result = result;

        stepResults.push({ step, result, provider });

        if (!result.success) {
          step.status = "failed";
          allSuccess = false;

          // Provider-specific error isolation: if other providers
          // have independent steps, those can still continue.
          // Mark only dependent steps as skipped.
          this.skipDependentSteps(plan, step.id, executed);
        } else {
          step.status = "success";
          executed.add(step.id);

          // Observe result with provider context
          try {
            const currentState = await this.registry.getClusterState();
            const observation: ObservationResult = await this.observer.observe(
              step,
              result,
              currentState,
              this.config,
            );

            if (observation.severity === "major") {
              step.status = "failed";
              allSuccess = false;
            }
          } catch {
            // Observation failure is non-fatal
          }
        }
      }

      // Check if all steps are done
      const allDone = plan.steps.every(
        (s) =>
          s.status === "success" ||
          s.status === "failed" ||
          s.status === "skipped",
      );
      if (allDone) break;
    }

    plan.status = allSuccess ? "completed" : "failed";

    // 7. Emit completion
    this.eventBus.emit({
      type: "multi_provider_goal_completed",
      timestamp: new Date().toISOString(),
      data: {
        goal_id: goal.id,
        success: allSuccess,
        cross_provider: isCrossProvider,
        providers_used: providersUsed,
        steps_completed: stepResults.filter((r) => r.result.success).length,
        steps_failed: stepResults.filter((r) => !r.result.success).length,
      },
    });

    return {
      success: allSuccess,
      plan,
      step_results: stepResults,
      cross_provider: isCrossProvider,
      providers_used: providersUsed,
    };
  }

  /**
   * Query all providers and return aggregated information.
   * Used for cross-provider queries like "show all VMs".
   */
  async queryAllProviders(query: string): Promise<MultiQueryResult> {
    const multiState = await this.registry.getMultiClusterState();
    const providerResults: MultiQueryResult["providers"] = [];

    for (const provider of multiState.providers) {
      try {
        // Extract VMs, containers, nodes, storage from the state
        providerResults.push({
          name: provider.name,
          type: provider.type,
          results: {
            nodes: provider.state.nodes,
            vms: provider.state.vms,
            containers: provider.state.containers,
            storage: provider.state.storage,
          },
        });
      } catch (err) {
        providerResults.push({
          name: provider.name,
          type: provider.type,
          results: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Aggregate across all providers
    const aggregated = {
      total_vms: providerResults.reduce((sum, p) => {
        const r = p.results as { vms?: unknown[] } | null;
        return sum + (r?.vms?.length ?? 0);
      }, 0),
      total_nodes: providerResults.reduce((sum, p) => {
        const r = p.results as { nodes?: unknown[] } | null;
        return sum + (r?.nodes?.length ?? 0);
      }, 0),
      total_containers: providerResults.reduce((sum, p) => {
        const r = p.results as { containers?: unknown[] } | null;
        return sum + (r?.containers?.length ?? 0);
      }, 0),
      providers_queried: providerResults.length,
      providers_failed: providerResults.filter((p) => p.error).length,
      query,
    };

    this.eventBus.emit({
      type: "multi_provider_query",
      timestamp: new Date().toISOString(),
      data: {
        query,
        providers_queried: aggregated.providers_queried,
        total_vms: aggregated.total_vms,
        total_nodes: aggregated.total_nodes,
      },
    });

    return {
      providers: providerResults,
      aggregated,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Analyze resource capacity across all providers.
   * Used by the planner to decide WHERE to place workloads.
   */
  async getCapacityAnalysis(): Promise<CapacityAnalysis> {
    const multiState = await this.registry.getMultiClusterState();
    const providerCapacities: CapacityAnalysis["providers"] = [];

    for (const provider of multiState.providers) {
      const s = provider.state;

      const cpuTotal = s.nodes.reduce((sum, n) => sum + n.cpu_cores, 0);
      const cpuUsed = s.nodes.reduce(
        (sum, n) => sum + (n.cpu_cores * n.cpu_usage_pct) / 100,
        0,
      );

      const memTotalMb = s.nodes.reduce((sum, n) => sum + n.ram_total_mb, 0);
      const memUsedMb = s.nodes.reduce((sum, n) => sum + n.ram_used_mb, 0);

      const storageTotalGb = s.storage.reduce((sum, st) => sum + st.total_gb, 0);
      const storageUsedGb = s.storage.reduce((sum, st) => sum + st.used_gb, 0);

      // Determine health
      const offlineNodes = s.nodes.filter((n) => n.status === "offline");
      const avgCpuPct = cpuTotal > 0 ? (cpuUsed / cpuTotal) * 100 : 0;
      const avgMemPct = memTotalMb > 0 ? (memUsedMb / memTotalMb) * 100 : 0;

      let health: "healthy" | "degraded" | "critical" = "healthy";
      if (offlineNodes.length > 0 || avgCpuPct > 80 || avgMemPct > 85) {
        health = "degraded";
      }
      if (
        offlineNodes.length === s.nodes.length ||
        avgCpuPct > 95 ||
        avgMemPct > 95
      ) {
        health = "critical";
      }
      // Edge case: if no nodes at all, mark as critical
      if (s.nodes.length === 0) {
        health = "critical";
      }

      providerCapacities.push({
        name: provider.name,
        type: provider.type,
        capacity: {
          cpu_total: cpuTotal,
          cpu_used: Math.round(cpuUsed * 100) / 100,
          cpu_available: Math.round((cpuTotal - cpuUsed) * 100) / 100,
          memory_total_gb: Math.round((memTotalMb / 1024) * 100) / 100,
          memory_used_gb: Math.round((memUsedMb / 1024) * 100) / 100,
          memory_available_gb: Math.round(((memTotalMb - memUsedMb) / 1024) * 100) / 100,
          storage_total_gb: storageTotalGb,
          storage_used_gb: storageUsedGb,
          storage_available_gb: storageTotalGb - storageUsedGb,
          vm_count: s.vms.length,
        },
        health,
      });
    }

    // Recommendation: pick the provider with the most available memory
    let recommendation = "No providers available for workload placement.";
    if (providerCapacities.length > 0) {
      const healthyProviders = providerCapacities.filter((p) => p.health !== "critical");
      const candidates = healthyProviders.length > 0 ? healthyProviders : providerCapacities;

      const best = candidates.reduce((a, b) =>
        a.capacity.memory_available_gb >= b.capacity.memory_available_gb ? a : b,
      );

      recommendation = `${best.name} (${best.type}) has the most available resources: ${best.capacity.memory_available_gb.toFixed(1)}GB RAM free, ${best.capacity.cpu_available.toFixed(1)} CPU cores available, ${best.capacity.storage_available_gb.toFixed(0)}GB storage free.`;
    }

    this.eventBus.emit({
      type: "capacity_analysis",
      timestamp: new Date().toISOString(),
      data: {
        provider_count: providerCapacities.length,
        recommendation,
      },
    });

    return {
      providers: providerCapacities,
      recommendation,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Detect which providers are used by a plan based on tool prefixes
   * and tool adapter registrations.
   */
  private detectProvidersUsed(plan: Plan): string[] {
    const providers = new Set<string>();
    const tools = this.registry.getAllTools();
    const toolAdapterMap = new Map<string, string>();
    for (const t of tools) {
      toolAdapterMap.set(t.name, t.adapter);
    }

    for (const step of plan.steps) {
      const adapter = toolAdapterMap.get(step.action);
      if (adapter && adapter !== "system") {
        providers.add(adapter);
      }
    }

    return Array.from(providers);
  }

  /**
   * Get the provider name for a given step.
   */
  private getStepProvider(step: PlanStep): string {
    const tool = this.registry.getTool(step.action);
    return tool?.adapter ?? "unknown";
  }

  /**
   * Skip steps that depend on a failed step (directly or transitively).
   */
  private skipDependentSteps(
    plan: Plan,
    failedStepId: string,
    executed: Set<string>,
  ): void {
    const toSkip = new Set<string>();

    // Find all steps that transitively depend on the failed step
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of plan.steps) {
        if (step.status !== "pending" || toSkip.has(step.id)) continue;
        const dependsOnFailed = step.depends_on.some(
          (dep) => dep === failedStepId || toSkip.has(dep),
        );
        if (dependsOnFailed) {
          toSkip.add(step.id);
          changed = true;
        }
      }
    }

    for (const step of plan.steps) {
      if (toSkip.has(step.id)) {
        step.status = "skipped";
      }
    }
  }

  private emptyPlan(goalId: string, reasoning: string): Plan {
    return {
      id: `empty-${Date.now()}`,
      goal_id: goalId,
      steps: [],
      created_at: new Date().toISOString(),
      status: "failed",
      resource_estimate: {
        ram_mb: 0,
        disk_gb: 0,
        cpu_cores: 0,
        vms_created: 0,
        containers_created: 0,
      },
      reasoning,
      revision: 0,
    };
  }
}
