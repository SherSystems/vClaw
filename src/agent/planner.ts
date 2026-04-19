// ============================================================
// vClaw — Planner
// Converts high-level goals into dependency-ordered execution plans
// ============================================================

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Goal,
  Plan,
  PlanStep,
  ToolDefinition,
  ClusterState,
  MultiClusterState,
  MemoryEntry,
  ResourceEstimate,
} from "../types.js";
import { callLLM, type AIConfig } from "./llm.js";
import { PLANNER_PROMPT, REPLANNER_PROMPT, formatMultiClusterState } from "./prompts.js";

export interface PlanningContext {
  tools: ToolDefinition[];
  clusterState: ClusterState | null;
  multiClusterState?: MultiClusterState;
  memory: MemoryEntry[];
  previousPlan?: Plan;
  config: AIConfig;
}

interface LLMPlanStep {
  id: string;
  action: string;
  params: Record<string, unknown>;
  description: string;
  depends_on: string[];
}

interface LLMPlanResponse {
  steps: LLMPlanStep[];
  reasoning: string;
  resource_estimate?: ResourceEstimate;
}

const LLMPlanStepSchema = z.object({
  id: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  description: z.string(),
  depends_on: z.array(z.string()).default([]),
});

const ResourceEstimateSchema = z.object({
  ram_mb: z.number(),
  disk_gb: z.number(),
  cpu_cores: z.number(),
  vms_created: z.number(),
  containers_created: z.number(),
});

const LLMPlanResponseSchema = z.object({
  steps: z.array(LLMPlanStepSchema),
  reasoning: z.string(),
  resource_estimate: ResourceEstimateSchema.optional(),
});

export class Planner {
  /**
   * Generate an execution plan from a goal.
   */
  async plan(goal: Goal, context: PlanningContext): Promise<Plan> {
    const toolDescriptions = formatToolDescriptions(context.tools);
    const clusterSummary = formatClusterState(context.clusterState);
    const memorySummary = formatMemory(context.memory);
    const multiClusterSummary = context.multiClusterState
      ? formatMultiClusterState(context.multiClusterState)
      : undefined;

    const systemPrompt = PLANNER_PROMPT({
      toolDescriptions,
      clusterStateSummary: clusterSummary,
      memoryContext: memorySummary,
      multiClusterSummary,
    });

    const userMessage = `Goal: ${goal.description}\n\nMode: ${goal.mode}\n\nRaw input: ${goal.raw_input}`;

    const response = await callLLM({
      system: systemPrompt,
      user: userMessage,
      config: context.config,
    });

    const parsed = parseResponse(response);
    validateToolReferences(parsed.steps, context.tools);
    validateDependencyGraph(parsed.steps);

    const planId = randomUUID();
    const steps: PlanStep[] = parsed.steps.map((s, i) => ({
      id: s.id || `step_${i + 1}`,
      action: s.action,
      params: s.params,
      description: s.description,
      depends_on: s.depends_on || [],
      status: "pending" as const,
      tier: context.tools.find((t) => t.name === s.action)?.tier ?? "read",
    }));

    return {
      id: planId,
      goal_id: goal.id,
      steps,
      created_at: new Date().toISOString(),
      status: "pending",
      resource_estimate: parsed.resource_estimate || {
        ram_mb: 0,
        disk_gb: 0,
        cpu_cores: 0,
        vms_created: 0,
        containers_created: 0,
      },
      reasoning: parsed.reasoning || "",
      revision: 1,
    };
  }

  /**
   * Replan after a step failure. Produces a new plan that works around the failure.
   */
  async replan(
    plan: Plan,
    failedStep: PlanStep,
    error: string,
    context: PlanningContext,
  ): Promise<Plan> {
    const toolDescriptions = formatToolDescriptions(context.tools);
    const clusterSummary = formatClusterState(context.clusterState);

    const completedSteps = plan.steps.filter((s) => s.status === "success");
    const remainingSteps = plan.steps.filter(
      (s) => s.status === "pending" || s.status === "skipped",
    );

    const systemPrompt = REPLANNER_PROMPT({
      toolDescriptions,
      clusterStateSummary: clusterSummary,
      originalPlan: JSON.stringify(plan.steps, null, 2),
      failedStep: JSON.stringify(failedStep, null, 2),
      failureError: error,
      completedSteps: completedSteps.length > 0
        ? JSON.stringify(completedSteps, null, 2)
        : "None",
      remainingSteps: remainingSteps.length > 0
        ? JSON.stringify(remainingSteps, null, 2)
        : "None",
    });

    const userMessage = `The step "${failedStep.description}" (action: ${failedStep.action}) has failed with error: ${error}\n\nPlease produce a revised plan that works around this failure.`;

    const response = await callLLM({
      system: systemPrompt,
      user: userMessage,
      config: context.config,
    });

    const parsed = parseResponse(response);

    if (parsed.steps.length > 0) {
      validateToolReferences(parsed.steps, context.tools);
      validateDependencyGraph(parsed.steps);
    }

    const newPlanId = randomUUID();
    const steps: PlanStep[] = parsed.steps.map((s, i) => ({
      id: s.id || `step_r${i + 1}`,
      action: s.action,
      params: s.params,
      description: s.description,
      depends_on: s.depends_on || [],
      status: "pending" as const,
      tier: context.tools.find((t) => t.name === s.action)?.tier ?? "read",
    }));

    return {
      id: newPlanId,
      goal_id: plan.goal_id,
      steps,
      created_at: new Date().toISOString(),
      status: "pending",
      resource_estimate: parsed.resource_estimate || {
        ram_mb: 0,
        disk_gb: 0,
        cpu_cores: 0,
        vms_created: 0,
        containers_created: 0,
      },
      reasoning: parsed.reasoning || "",
      revision: plan.revision + 1,
      previous_plan_id: plan.id,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────

function parseResponse(raw: string): LLMPlanResponse {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse LLM plan response as JSON: ${raw.slice(0, 500)}`);
  }

  const parsed = LLMPlanResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid LLM plan response schema: ${formatSchemaIssues(parsed.error.issues)}`);
  }

  return parsed.data;
}

function formatSchemaIssues(issues: z.ZodIssue[]): string {
  return issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

function formatIssuePath(path: (string | number)[]): string {
  if (path.length === 0) return "$";

  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") {
      return `${acc}[${segment}]`;
    }
    if (acc.length === 0) {
      return segment;
    }
    return `${acc}.${segment}`;
  }, "");
}

function validateToolReferences(
  steps: LLMPlanStep[],
  tools: ToolDefinition[],
): void {
  const toolNames = new Set(tools.map((t) => t.name));
  for (const step of steps) {
    if (!toolNames.has(step.action)) {
      throw new Error(
        `Plan references unknown tool "${step.action}". Available tools: ${Array.from(toolNames).join(", ")}`,
      );
    }
  }
}

function validateDependencyGraph(steps: LLMPlanStep[]): void {
  const stepIds = new Set(steps.map((s) => s.id));

  // Check all dependencies reference existing steps
  for (const step of steps) {
    for (const dep of step.depends_on || []) {
      if (!stepIds.has(dep)) {
        throw new Error(
          `Step "${step.id}" depends on unknown step "${dep}"`,
        );
      }
    }
  }

  // Check for cycles using DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const adjMap = new Map<string, string[]>();

  for (const step of steps) {
    adjMap.set(step.id, step.depends_on || []);
  }

  function dfs(nodeId: string): void {
    if (inStack.has(nodeId)) {
      throw new Error(`Dependency cycle detected involving step "${nodeId}"`);
    }
    if (visited.has(nodeId)) return;

    inStack.add(nodeId);
    for (const dep of adjMap.get(nodeId) || []) {
      dfs(dep);
    }
    inStack.delete(nodeId);
    visited.add(nodeId);
  }

  for (const step of steps) {
    dfs(step.id);
  }
}

function formatToolDescriptions(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "No tools available.";

  return tools
    .map((t) => {
      const params = t.params
        .map((p) => `  - ${p.name} (${p.type}, ${p.required ? "required" : "optional"}): ${p.description}`)
        .join("\n");
      return `### ${t.name} [${t.tier}]\n${t.description}\n${params ? `Parameters:\n${params}` : "No parameters."}`;
    })
    .join("\n\n");
}

function formatClusterState(state: ClusterState | null): string {
  if (!state) return "No cluster state available.";

  const lines: string[] = [];
  lines.push(`Adapter: ${state.adapter}`);
  lines.push(`Timestamp: ${state.timestamp}`);
  lines.push(`Nodes: ${state.nodes.length}`);

  for (const node of state.nodes) {
    lines.push(
      `  - ${node.name}: ${node.status}, CPU ${node.cpu_usage_pct}%, RAM ${node.ram_used_mb}/${node.ram_total_mb}MB`,
    );
  }

  lines.push(`VMs: ${state.vms.length}`);
  for (const vm of state.vms) {
    lines.push(`  - ${vm.name} (${vm.id}): ${vm.status}, ${vm.ram_mb}MB RAM, ${vm.disk_gb}GB disk`);
  }

  lines.push(`Containers: ${state.containers.length}`);
  for (const ct of state.containers) {
    lines.push(`  - ${ct.name} (${ct.id}): ${ct.status}`);
  }

  lines.push(`Storage pools: ${state.storage.length}`);
  for (const s of state.storage) {
    lines.push(`  - ${s.id}: ${s.available_gb}GB free / ${s.total_gb}GB total`);
  }

  return lines.join("\n");
}

function formatMemory(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "No prior memory.";

  return entries
    .map((e) => `[${e.type}] ${e.key}: ${e.value} (confidence: ${e.confidence}, used ${e.use_count}x)`)
    .join("\n");
}
