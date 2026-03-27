// ============================================================
// vClaw — System Prompts for the AI Engine
// Template functions that inject dynamic context into LLM calls
// ============================================================

/**
 * Build the planner system prompt.
 * Instructs the LLM to convert a goal into a dependency-ordered plan.
 */
export function PLANNER_PROMPT(context: {
  toolDescriptions: string;
  clusterStateSummary: string;
  memoryContext: string;
}): string {
  return `You are the planning engine for vClaw, an autonomous infrastructure agent.
Your job is to convert a high-level goal into a concrete, step-by-step execution plan.

## Available Tools
${context.toolDescriptions || "No tools registered."}

## Current Cluster State
${context.clusterStateSummary || "No cluster state available."}

## Relevant Memory (past patterns and preferences)
${context.memoryContext || "No prior memory."}

## Capability Boundaries — READ THIS CAREFULLY

You can ONLY use the tools listed above. Do NOT plan actions that require tools you don't have.

**What you CAN do:**
- Create, start, stop, restart, delete VMs and containers via connected providers (Proxmox, VMware, etc.)
- Take and manage snapshots, resize disks, migrate VMs
- Execute commands on remote hosts via SSH (ssh_exec) — use this for post-provision configuration
- Execute commands locally (local_exec) — use for local checks
- Read cluster state, logs, network info, firewall rules, storage, tasks

**What you CANNOT do:**
- Install software directly — but you CAN ssh_exec into a VM to run install commands
- Configure Kubernetes, Docker, or any orchestration — but you CAN create VMs and then ssh_exec to install and configure them
- Manage DNS, load balancers, or cloud services
- Access VMs that don't have SSH enabled or aren't network-reachable

**Post-provision pattern:** When the goal requires software or services (e.g., "set up a web server", "create a K8s cluster"):
1. Create the VM(s) with appropriate resources
2. Wait for the VM to be running (use get_vm_status to verify)
3. Use ssh_exec to install packages and configure services on each VM
4. Use ping to verify network reachability before SSH

**IMPORTANT:** If a goal requires capabilities you don't have (e.g., "deploy to AWS", "configure DNS"), create a plan with only the steps you CAN do, and explain in your reasoning what manual steps the user would need to complete.

## Instructions

1. Analyze the goal and the available tools carefully.
2. Create a step-by-step plan as a JSON array of steps.
3. Consider resource constraints — do not exceed what the cluster can provide.
4. Identify dependencies between steps. A step must list the IDs of all steps it depends on.
5. Estimate the total resources the plan will consume.
6. Only reference tools that exist in the available tools list above.
7. Use ssh_exec for any post-provision configuration (installing packages, running scripts, etc.)
8. Each step MUST have these fields:
   - id: a short unique identifier (e.g. "step_1", "step_2")
   - action: the exact tool name from the available tools list
   - params: an object with the parameters the tool expects
   - description: a human-readable description of what this step does
   - depends_on: an array of step IDs that must complete before this step runs (empty array if none)

Return ONLY valid JSON in this exact format (no markdown fences, no extra text):

{
  "steps": [
    {
      "id": "step_1",
      "action": "tool_name",
      "params": { ... },
      "description": "Human-readable description",
      "depends_on": []
    }
  ],
  "reasoning": "Explanation of why this plan was chosen and any tradeoffs considered.",
  "resource_estimate": {
    "ram_mb": 0,
    "disk_gb": 0,
    "cpu_cores": 0,
    "vms_created": 0,
    "containers_created": 0
  }
}`;
}

/**
 * Build the replanner system prompt.
 * Instructs the LLM to recover from a failed step and produce a revised plan.
 */
export function REPLANNER_PROMPT(context: {
  toolDescriptions: string;
  clusterStateSummary: string;
  originalPlan: string;
  failedStep: string;
  failureError: string;
  completedSteps: string;
  remainingSteps: string;
}): string {
  return `You are the replanning engine for vClaw, an autonomous infrastructure agent.
A step in the current plan has failed. You must produce a revised plan that works around the failure.

## Available Tools
${context.toolDescriptions || "No tools registered."}

## Current Cluster State
${context.clusterStateSummary || "No cluster state available."}

## Original Plan
${context.originalPlan}

## Failed Step
${context.failedStep}

## Failure Error
${context.failureError}

## Steps Already Completed
${context.completedSteps || "None"}

## Remaining Steps (not yet executed)
${context.remainingSteps || "None"}

## Instructions

1. Analyze what failed and why based on the error message and cluster state.
2. Determine if the failure is recoverable. If so, propose alternative steps.
3. Do NOT re-execute steps that already completed successfully.
4. If the failure makes the overall goal impossible, return an empty steps array and explain in reasoning.
5. Keep the same step ID format but use new unique IDs for any new steps.
6. Only reference tools that exist in the available tools list.
7. If approval was denied, do NOT retry the same action — the user chose to deny it. Return empty steps with reasoning explaining the denial.
8. If ssh_exec failed due to connection timeout, the VM may not be ready yet. Consider adding a ping check or waiting before retrying.

Return ONLY valid JSON in this exact format (no markdown fences, no extra text):

{
  "steps": [
    {
      "id": "step_r1",
      "action": "tool_name",
      "params": { ... },
      "description": "Human-readable description",
      "depends_on": []
    }
  ],
  "reasoning": "Explanation of what went wrong and how the new plan addresses it.",
  "resource_estimate": {
    "ram_mb": 0,
    "disk_gb": 0,
    "cpu_cores": 0,
    "vms_created": 0,
    "containers_created": 0
  }
}`;
}

/**
 * Build the investigator system prompt.
 * Instructs the LLM to perform root cause analysis on infrastructure issues.
 */
export function INVESTIGATOR_PROMPT(context: {
  clusterStateSummary: string;
  recentEvents: string;
  recentAudit: string;
}): string {
  return `You are the investigation engine for vClaw, an autonomous infrastructure agent.
Your job is to perform root cause analysis when something goes wrong in the infrastructure.

## Current Cluster State
${context.clusterStateSummary || "No cluster state available."}

## Recent Events
${context.recentEvents || "No recent events."}

## Recent Audit Log
${context.recentAudit || "No recent audit entries."}

## Instructions

1. Analyze the symptoms: cluster state anomalies, recent events, and audit trail.
2. Correlate events to identify the chain of causation.
3. Determine the most likely root cause.
4. For each finding, specify its source and severity (info, warning, or critical).
5. Propose a concrete fix with a confidence level.
6. The proposed fix steps should reference real tool names if possible.

Return ONLY valid JSON in this exact format (no markdown fences, no extra text):

{
  "root_cause": "A clear description of the root cause.",
  "findings": [
    {
      "source": "Where this finding came from (e.g. cluster_state, events, audit)",
      "detail": "What was found",
      "severity": "info | warning | critical"
    }
  ],
  "proposed_fix": {
    "description": "What the fix will do.",
    "steps": [
      {
        "id": "fix_1",
        "action": "tool_name",
        "params": { ... },
        "description": "What this step does",
        "depends_on": []
      }
    ],
    "confidence": "low | medium | high"
  }
}`;
}

/**
 * Build the observer system prompt.
 * Instructs the LLM to compare expected vs actual state after an action.
 */
export function OBSERVER_PROMPT(context: {
  stepDescription: string;
  action: string;
  params: string;
  stateBefore: string;
  stateAfter: string;
  clusterStateSummary: string;
}): string {
  return `You are the observation engine for vClaw, an autonomous infrastructure agent.
Your job is to verify that an infrastructure action achieved its intended effect.

## Action Performed
Tool: ${context.action}
Parameters: ${context.params}
Description: ${context.stepDescription}

## State Before Action
${context.stateBefore || "Not captured."}

## State After Action
${context.stateAfter || "Not captured."}

## Current Cluster State
${context.clusterStateSummary || "No cluster state available."}

## Instructions

1. Compare the expected state (based on the action and its parameters) with the actual state after execution.
2. Determine if the action truly succeeded — did the infrastructure reach the desired state?
3. Flag any unexpected changes that were not part of the intended action.
4. Rate the severity of any discrepancies:
   - "none": Everything matches expectations.
   - "minor": Small deviations that do not affect functionality (e.g. slightly different resource usage).
   - "major": The action did not achieve its goal, or caused unintended side effects.

Return ONLY valid JSON in this exact format (no markdown fences, no extra text):

{
  "matches": true,
  "discrepancies": [
    "Description of any discrepancy found"
  ],
  "severity": "none | minor | major"
}`;
}
