// ============================================================
// vClaw — MCP Server
// Model Context Protocol frontend for Claude Code and other
// AI tools to interact with vClaw as a tool provider.
// ============================================================

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AgentCore } from "../agent/core.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventBus } from "../agent/events.js";
import type { GovernanceEngine } from "../governance/index.js";
import type { Goal, Plan } from "../types.js";
import { randomUUID } from "node:crypto";

// ── Helper: Format cluster state as readable text ───────────

function formatClusterState(state: Record<string, unknown>): string {
  const s = state as {
    adapter?: string;
    nodes?: Array<{
      name: string;
      status: string;
      cpu_cores: number;
      cpu_usage_pct: number;
      ram_total_mb: number;
      ram_used_mb: number;
      uptime_s: number;
    }>;
    vms?: Array<{
      id: string | number;
      name: string;
      node: string;
      status: string;
      cpu_cores: number;
      ram_mb: number;
      disk_gb: number;
      ip_address?: string;
    }>;
    containers?: Array<{
      id: string | number;
      name: string;
      node: string;
      status: string;
      ram_mb: number;
    }>;
    storage?: Array<{
      id: string;
      node: string;
      type: string;
      total_gb: number;
      used_gb: number;
      available_gb: number;
    }>;
    timestamp?: string;
  };

  const lines: string[] = [];
  lines.push(`# Cluster Status (${s.adapter ?? "unknown"} adapter)`);
  lines.push(`Timestamp: ${s.timestamp ?? "unknown"}`);
  lines.push("");

  if (s.nodes && s.nodes.length > 0) {
    lines.push("## Nodes");
    for (const n of s.nodes) {
      const ramPct = n.ram_total_mb > 0
        ? ((n.ram_used_mb / n.ram_total_mb) * 100).toFixed(1)
        : "0";
      lines.push(
        `- **${n.name}** [${n.status}] CPU: ${n.cpu_usage_pct.toFixed(1)}% (${n.cpu_cores} cores) | RAM: ${ramPct}% (${n.ram_used_mb}/${n.ram_total_mb} MB) | Uptime: ${Math.floor(n.uptime_s / 3600)}h`,
      );
    }
    lines.push("");
  }

  if (s.vms && s.vms.length > 0) {
    lines.push("## Virtual Machines");
    for (const vm of s.vms) {
      const ip = vm.ip_address ? ` | IP: ${vm.ip_address}` : "";
      lines.push(
        `- **${vm.name}** (${vm.id}) [${vm.status}] on ${vm.node} | ${vm.cpu_cores} vCPU, ${vm.ram_mb} MB RAM, ${vm.disk_gb} GB disk${ip}`,
      );
    }
    lines.push("");
  }

  if (s.containers && s.containers.length > 0) {
    lines.push("## Containers");
    for (const ct of s.containers) {
      lines.push(
        `- **${ct.name}** (${ct.id}) [${ct.status}] on ${ct.node} | ${ct.ram_mb} MB RAM`,
      );
    }
    lines.push("");
  }

  if (s.storage && s.storage.length > 0) {
    lines.push("## Storage");
    for (const st of s.storage) {
      const usedPct = st.total_gb > 0
        ? ((st.used_gb / st.total_gb) * 100).toFixed(1)
        : "0";
      lines.push(
        `- **${st.id}** (${st.type}) on ${st.node} | ${usedPct}% used (${st.used_gb}/${st.total_gb} GB)`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`# Plan: ${plan.id}`);
  lines.push(`Status: ${plan.status} | Revision: ${plan.revision}`);
  lines.push(`Created: ${plan.created_at}`);
  lines.push(`Reasoning: ${plan.reasoning}`);
  lines.push("");
  lines.push("## Resource Estimate");
  const re = plan.resource_estimate;
  lines.push(
    `RAM: ${re.ram_mb} MB | Disk: ${re.disk_gb} GB | CPU: ${re.cpu_cores} cores | VMs: ${re.vms_created} | Containers: ${re.containers_created}`,
  );
  lines.push("");
  lines.push("## Steps");
  for (const step of plan.steps) {
    const deps = step.depends_on.length > 0
      ? ` (depends on: ${step.depends_on.join(", ")})`
      : "";
    lines.push(
      `${step.id}. [${step.tier}] ${step.action} — ${step.description}${deps}`,
    );
    if (Object.keys(step.params).length > 0) {
      lines.push(`   Params: ${JSON.stringify(step.params)}`);
    }
  }
  return lines.join("\n");
}

// ── Stored plans for execute workflow ───────────────────────

const pendingPlans = new Map<string, Plan>();

// ── MCP Server Class ────────────────────────────────────────

export class vClawMCP {
  private server: McpServer;
  private agentCore: AgentCore;
  private toolRegistry: ToolRegistry;
  private eventBus: EventBus;
  private governance: GovernanceEngine;

  constructor(
    agentCore: AgentCore,
    toolRegistry: ToolRegistry,
    eventBus: EventBus,
    governance: GovernanceEngine,
  ) {
    this.agentCore = agentCore;
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.governance = governance;

    this.server = new McpServer({
      name: "infrawrap",
      version: "0.1.0",
    });

    this.registerInfraTools();
    this.registerAgentTools();
    this.registerResources();
  }

  // ── Start the MCP server on stdio ───────────────────────────

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  // ── Infrastructure Tools (pass-through to Proxmox adapter) ──

  private registerInfraTools(): void {
    // -- list_vms --
    this.server.tool(
      "list_vms",
      "List all virtual machines across the cluster with their status, resources, and IPs.",
      { node: z.string().optional().describe("Filter by node name") },
      async (params) => {
        const result = await this.toolRegistry.execute("list_vms", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        const vms = result.data as Array<Record<string, unknown>>;
        const text = Array.isArray(vms)
          ? vms
              .map(
                (vm) =>
                  `${vm.name} (${vm.id}) [${vm.status}] on ${vm.node} | ${vm.cpu_cores} vCPU, ${vm.ram_mb} MB RAM, ${vm.disk_gb} GB disk${vm.ip_address ? ` | ${vm.ip_address}` : ""}`,
              )
              .join("\n") || "No VMs found."
          : JSON.stringify(result.data, null, 2);
        return { content: [{ type: "text" as const, text }] };
      },
    );

    // -- get_vm_status --
    this.server.tool(
      "get_vm_status",
      "Get detailed status of a specific virtual machine.",
      {
        vmid: z.number().describe("VM ID"),
        node: z.string().optional().describe("Node the VM is on"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("get_vm_status", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
      },
    );

    // -- list_nodes --
    this.server.tool(
      "list_nodes",
      "List all nodes in the cluster with CPU, RAM, and status information.",
      {},
      async () => {
        const result = await this.toolRegistry.execute("list_nodes", {});
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        const nodes = result.data as Array<Record<string, unknown>>;
        const text = Array.isArray(nodes)
          ? nodes
              .map(
                (n) =>
                  `${n.name} [${n.status}] CPU: ${n.cpu_usage_pct}% (${n.cpu_cores} cores) | RAM: ${n.ram_used_mb}/${n.ram_total_mb} MB | Uptime: ${Math.floor((n.uptime_s as number) / 3600)}h`,
              )
              .join("\n") || "No nodes found."
          : JSON.stringify(result.data, null, 2);
        return { content: [{ type: "text" as const, text }] };
      },
    );

    // -- get_node_stats --
    this.server.tool(
      "get_node_stats",
      "Get detailed statistics for a specific node.",
      { node: z.string().describe("Node name") },
      async (params) => {
        const result = await this.toolRegistry.execute("get_node_stats", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
      },
    );

    // -- start_vm --
    this.server.tool(
      "start_vm",
      "Start a stopped virtual machine.",
      {
        vmid: z.number().describe("VM ID to start"),
        node: z.string().optional().describe("Node the VM is on"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("start_vm", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `VM ${params.vmid} started successfully.` }] };
      },
    );

    // -- stop_vm --
    this.server.tool(
      "stop_vm",
      "Immediately stop a virtual machine (power off). Use shutdown_vm for graceful shutdown.",
      {
        vmid: z.number().describe("VM ID to stop"),
        node: z.string().optional().describe("Node the VM is on"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("stop_vm", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `VM ${params.vmid} stopped.` }] };
      },
    );

    // -- shutdown_vm --
    this.server.tool(
      "shutdown_vm",
      "Gracefully shut down a virtual machine via ACPI.",
      {
        vmid: z.number().describe("VM ID to shut down"),
        node: z.string().optional().describe("Node the VM is on"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("shutdown_vm", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `VM ${params.vmid} shutdown initiated.` }] };
      },
    );

    // -- restart_vm --
    this.server.tool(
      "restart_vm",
      "Restart (reboot) a virtual machine.",
      {
        vmid: z.number().describe("VM ID to restart"),
        node: z.string().optional().describe("Node the VM is on"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("restart_vm", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `VM ${params.vmid} restarting.` }] };
      },
    );

    // -- create_vm --
    this.server.tool(
      "create_vm",
      "Create a new virtual machine with specified resources.",
      {
        name: z.string().describe("VM name"),
        node: z.string().describe("Target node"),
        cpu_cores: z.number().optional().default(2).describe("Number of CPU cores"),
        ram_mb: z.number().optional().default(2048).describe("RAM in MB"),
        disk_gb: z.number().optional().default(32).describe("Disk size in GB"),
        iso: z.string().optional().describe("ISO image for installation"),
        storage: z.string().optional().default("local-lvm").describe("Storage pool"),
        network: z.string().optional().default("vmbr0").describe("Network bridge"),
        start_after_create: z.boolean().optional().default(false).describe("Start VM after creation"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("create_vm", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return {
          content: [{ type: "text" as const, text: `VM "${params.name}" created successfully.\n${JSON.stringify(result.data, null, 2)}` }],
        };
      },
    );

    // -- create_ct --
    this.server.tool(
      "create_ct",
      "Create a new LXC container.",
      {
        name: z.string().describe("Container name"),
        node: z.string().describe("Target node"),
        template: z.string().describe("OS template (e.g. ubuntu-22.04-standard)"),
        cpu_cores: z.number().optional().default(1).describe("Number of CPU cores"),
        ram_mb: z.number().optional().default(1024).describe("RAM in MB"),
        disk_gb: z.number().optional().default(8).describe("Root disk size in GB"),
        storage: z.string().optional().default("local-lvm").describe("Storage pool"),
        network: z.string().optional().default("vmbr0").describe("Network bridge"),
        password: z.string().optional().describe("Root password"),
        start_after_create: z.boolean().optional().default(true).describe("Start container after creation"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("create_ct", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return {
          content: [{ type: "text" as const, text: `Container "${params.name}" created successfully.\n${JSON.stringify(result.data, null, 2)}` }],
        };
      },
    );

    // -- delete_vm --
    this.server.tool(
      "delete_vm",
      "Delete a virtual machine. This is a destructive action and cannot be undone.",
      {
        vmid: z.number().describe("VM ID to delete"),
        node: z.string().optional().describe("Node the VM is on"),
        purge: z.boolean().optional().default(false).describe("Also remove from HA and backup configurations"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("delete_vm", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `VM ${params.vmid} deleted.` }] };
      },
    );

    // -- list_snapshots --
    this.server.tool(
      "list_snapshots",
      "List all snapshots for a virtual machine.",
      {
        vmid: z.number().describe("VM ID"),
        node: z.string().optional().describe("Node the VM is on"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("list_snapshots", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
      },
    );

    // -- create_snapshot --
    this.server.tool(
      "create_snapshot",
      "Create a snapshot of a virtual machine for backup/rollback.",
      {
        vmid: z.number().describe("VM ID to snapshot"),
        name: z.string().describe("Snapshot name"),
        description: z.string().optional().describe("Snapshot description"),
        node: z.string().optional().describe("Node the VM is on"),
        include_ram: z.boolean().optional().default(false).describe("Include RAM state in snapshot"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("create_snapshot", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return {
          content: [{ type: "text" as const, text: `Snapshot "${params.name}" created for VM ${params.vmid}.` }],
        };
      },
    );

    // -- list_storage --
    this.server.tool(
      "list_storage",
      "List all storage pools across the cluster with usage information.",
      { node: z.string().optional().describe("Filter by node name") },
      async (params) => {
        const result = await this.toolRegistry.execute("list_storage", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        const storages = result.data as Array<Record<string, unknown>>;
        const text = Array.isArray(storages)
          ? storages
              .map(
                (s) =>
                  `${s.id} (${s.type}) on ${s.node} | ${s.used_gb}/${s.total_gb} GB used | Content: ${Array.isArray(s.content) ? (s.content as string[]).join(", ") : s.content}`,
              )
              .join("\n") || "No storage pools found."
          : JSON.stringify(result.data, null, 2);
        return { content: [{ type: "text" as const, text }] };
      },
    );

    // -- list_isos --
    this.server.tool(
      "list_isos",
      "List available ISO images for VM installation.",
      {
        storage: z.string().optional().describe("Storage pool to search"),
        node: z.string().optional().describe("Node to search on"),
      },
      async (params) => {
        const result = await this.toolRegistry.execute("list_isos", params);
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
      },
    );
  }

  // ── Agent Tools (planning, execution, investigation) ────────

  private registerAgentTools(): void {
    // -- agent_plan --
    this.server.tool(
      "agent_plan",
      "Create an infrastructure plan from a high-level goal description. Returns a plan for review before execution. The plan includes steps, resource estimates, and governance tier classification.",
      {
        goal: z.string().describe("High-level description of what you want to achieve (e.g. 'Deploy a 3-node Kubernetes cluster')"),
        mode: z
          .enum(["build", "watch", "investigate"])
          .optional()
          .default("build")
          .describe("Agent mode: build (create/modify infra), watch (monitor), investigate (diagnose)"),
      },
      async (params) => {
        const goal: Goal = {
          id: randomUUID(),
          mode: params.mode,
          description: params.goal,
          raw_input: params.goal,
          created_at: new Date().toISOString(),
        };

        try {
          const clusterState = await this.toolRegistry.getClusterState();
          const memories = this.agentCore.memory.recall(undefined, undefined, 20);

          const plan = await this.agentCore.planner.plan(goal, {
            tools: this.toolRegistry.getAllTools(),
            clusterState,
            memory: memories,
            config: (this.agentCore as unknown as { config: unknown }).config as import("../agent/llm.js").AIConfig,
          });

          // Store plan for later execution
          pendingPlans.set(plan.id, plan);

          const text = formatPlan(plan);
          return {
            content: [{
              type: "text" as const,
              text: `${text}\n\n---\nPlan ID: ${plan.id}\nUse agent_execute with this plan_id to execute the plan.`,
            }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Planning failed: ${msg}` }],
            isError: true,
          };
        }
      },
    );

    // -- agent_execute --
    this.server.tool(
      "agent_execute",
      "Execute a previously created plan by its plan_id. The plan must have been created via agent_plan first.",
      {
        plan_id: z.string().describe("Plan ID returned from agent_plan"),
      },
      async (params) => {
        const plan = pendingPlans.get(params.plan_id);
        if (!plan) {
          return {
            content: [{
              type: "text" as const,
              text: `Plan not found: ${params.plan_id}. Create a plan first with agent_plan.`,
            }],
            isError: true,
          };
        }

        try {
          const goal: Goal = {
            id: plan.goal_id,
            mode: "build",
            description: `Execute plan ${plan.id}`,
            raw_input: `Execute plan ${plan.id}`,
            created_at: plan.created_at,
          };

          const result = await this.agentCore.run(goal);
          pendingPlans.delete(params.plan_id);

          const lines: string[] = [];
          lines.push(`# Execution Result`);
          lines.push(`Success: ${result.success}`);
          lines.push(`Steps completed: ${result.steps_completed}/${result.plan.steps.length}`);
          lines.push(`Steps failed: ${result.steps_failed}`);
          lines.push(`Replans: ${result.replans}`);
          lines.push(`Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);

          if (result.errors.length > 0) {
            lines.push("");
            lines.push("## Errors");
            for (const e of result.errors) {
              lines.push(`- ${e}`);
            }
          }

          lines.push("");
          lines.push("## Step Results");
          for (const step of result.plan.steps) {
            const dur = step.result?.duration_ms
              ? ` (${(step.result.duration_ms / 1000).toFixed(1)}s)`
              : "";
            lines.push(`- ${step.action} [${step.status}]${dur}`);
            if (step.result?.error) {
              lines.push(`  Error: ${step.result.error}`);
            }
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Execution failed: ${msg}` }],
            isError: true,
          };
        }
      },
    );

    // -- agent_investigate --
    this.server.tool(
      "agent_investigate",
      "Trigger root cause analysis on a problem. vClaw will gather cluster state, recent events, and audit logs to determine what went wrong and optionally propose a fix.",
      {
        problem: z.string().describe("Description of the problem to investigate (e.g. 'VM 102 keeps crashing', 'Network unreachable on vmbr1')"),
      },
      async (params) => {
        try {
          const investigation = await this.agentCore.investigate(params.problem);

          const lines: string[] = [];
          lines.push(`# Investigation: ${investigation.id}`);
          lines.push(`Trigger: ${investigation.trigger}`);
          lines.push(`Root Cause: ${investigation.root_cause}`);
          lines.push(`Timestamp: ${investigation.timestamp}`);
          lines.push("");

          if (investigation.findings.length > 0) {
            lines.push("## Findings");
            for (const f of investigation.findings) {
              lines.push(`- [${f.severity}] ${f.source}: ${f.detail}`);
            }
            lines.push("");
          }

          if (investigation.proposed_fix) {
            const fix = investigation.proposed_fix;
            lines.push("## Proposed Fix");
            lines.push(`Description: ${fix.description}`);
            lines.push(`Confidence: ${fix.confidence}`);
            lines.push(`Requires approval: ${fix.requires_approval}`);
            lines.push(`Steps: ${fix.steps.length}`);
            for (const step of fix.steps) {
              lines.push(`  - [${step.tier}] ${step.action}: ${step.description}`);
            }
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Investigation failed: ${msg}` }],
            isError: true,
          };
        }
      },
    );

    // -- agent_status --
    this.server.tool(
      "agent_status",
      "Get the current state of the vClaw agent including active plans, circuit breaker state, and system health.",
      {},
      async () => {
        const cbState = this.governance.getCircuitBreakerState();
        const activePlans = Array.from(pendingPlans.entries());
        const recentEvents = this.eventBus.getHistory(20);

        const lines: string[] = [];
        lines.push("# vClaw Agent Status");
        lines.push("");

        lines.push("## Circuit Breaker");
        lines.push(`Tripped: ${cbState.tripped}`);
        lines.push(`Consecutive failures: ${cbState.consecutive_failures}`);
        if (cbState.last_failure_at) {
          lines.push(`Last failure: ${cbState.last_failure_at}`);
        }
        if (cbState.cooldown_until) {
          lines.push(`Cooldown until: ${cbState.cooldown_until}`);
        }
        lines.push("");

        lines.push("## Pending Plans");
        if (activePlans.length === 0) {
          lines.push("No pending plans.");
        } else {
          for (const [id, plan] of activePlans) {
            lines.push(`- ${id}: ${plan.steps.length} steps [${plan.status}] (created ${plan.created_at})`);
          }
        }
        lines.push("");

        lines.push("## Recent Events");
        if (recentEvents.length === 0) {
          lines.push("No recent events.");
        } else {
          for (const evt of recentEvents.slice(-10)) {
            lines.push(`- [${evt.timestamp}] ${evt.type}: ${JSON.stringify(evt.data)}`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      },
    );

    // -- agent_audit --
    this.server.tool(
      "agent_audit",
      "Query the audit log with optional filters. Shows a history of all actions taken by the agent with governance decisions and results.",
      {
        action: z.string().optional().describe("Filter by action name"),
        tier: z.enum(["read", "safe_write", "risky_write", "destructive"]).optional().describe("Filter by action tier"),
        result: z.enum(["success", "failed", "blocked", "rolled_back"]).optional().describe("Filter by result"),
        since: z.string().optional().describe("ISO date string — only show entries after this time"),
        limit: z.number().optional().default(20).describe("Maximum number of entries to return"),
      },
      async (params) => {
        try {
          const stats = this.governance.getAuditStats() as {
            total: number;
            by_result: Record<string, number>;
            by_tier: Record<string, number>;
            recent_failures: Array<Record<string, unknown>>;
          };

          const lines: string[] = [];
          lines.push("# Audit Log");
          lines.push(`Total entries: ${stats.total}`);
          lines.push("");

          lines.push("## By Result");
          for (const [r, count] of Object.entries(stats.by_result)) {
            lines.push(`- ${r}: ${count}`);
          }
          lines.push("");

          lines.push("## By Tier");
          for (const [t, count] of Object.entries(stats.by_tier)) {
            lines.push(`- ${t}: ${count}`);
          }
          lines.push("");

          if (stats.recent_failures.length > 0) {
            lines.push("## Recent Failures");
            for (const f of stats.recent_failures) {
              lines.push(`- [${f.timestamp}] ${f.action} (${f.tier}): ${f.error || f.result}`);
            }
          }

          // Apply query filters note
          const filterParts: string[] = [];
          if (params.action) filterParts.push(`action=${params.action}`);
          if (params.tier) filterParts.push(`tier=${params.tier}`);
          if (params.result) filterParts.push(`result=${params.result}`);
          if (params.since) filterParts.push(`since=${params.since}`);
          if (filterParts.length > 0) {
            lines.push("");
            lines.push(`Filters applied: ${filterParts.join(", ")} (limit: ${params.limit})`);
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Audit query failed: ${msg}` }],
            isError: true,
          };
        }
      },
    );
  }

  // ── Resources ───────────────────────────────────────────────

  private registerResources(): void {
    // -- infrawrap://cluster/status --
    this.server.resource(
      "cluster-status",
      "infrawrap://cluster/status",
      async () => {
        try {
          const state = await this.toolRegistry.getClusterState();
          if (!state) {
            return {
              contents: [{
                uri: "infrawrap://cluster/status",
                mimeType: "text/plain",
                text: "No cluster adapter connected. Cannot retrieve cluster status.",
              }],
            };
          }
          const text = formatClusterState(state as unknown as Record<string, unknown>);
          return {
            contents: [{
              uri: "infrawrap://cluster/status",
              mimeType: "text/markdown",
              text,
            }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            contents: [{
              uri: "infrawrap://cluster/status",
              mimeType: "text/plain",
              text: `Error retrieving cluster status: ${msg}`,
            }],
          };
        }
      },
    );

    // -- infrawrap://agent/audit --
    this.server.resource(
      "agent-audit",
      "infrawrap://agent/audit",
      async () => {
        try {
          const stats = this.governance.getAuditStats() as {
            total: number;
            by_result: Record<string, number>;
            by_tier: Record<string, number>;
            recent_failures: Array<Record<string, unknown>>;
          };

          const lines: string[] = [];
          lines.push("# vClaw Audit Log Summary");
          lines.push(`Total actions: ${stats.total}`);
          lines.push("");
          lines.push("## Results");
          for (const [r, count] of Object.entries(stats.by_result)) {
            lines.push(`- ${r}: ${count}`);
          }
          lines.push("");
          lines.push("## Tiers");
          for (const [t, count] of Object.entries(stats.by_tier)) {
            lines.push(`- ${t}: ${count}`);
          }

          if (stats.recent_failures.length > 0) {
            lines.push("");
            lines.push("## Recent Failures");
            for (const f of stats.recent_failures) {
              lines.push(
                `- [${f.timestamp}] ${f.action} (${f.tier}): ${f.error || "failed"}`,
              );
            }
          }

          return {
            contents: [{
              uri: "infrawrap://agent/audit",
              mimeType: "text/markdown",
              text: lines.join("\n"),
            }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            contents: [{
              uri: "infrawrap://agent/audit",
              mimeType: "text/plain",
              text: `Error retrieving audit data: ${msg}`,
            }],
          };
        }
      },
    );
  }
}
