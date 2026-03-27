// ============================================================
// vClaw — CLI / REPL Frontend
// Rich terminal interface for the autonomous infrastructure agent
// ============================================================

import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { AgentCore } from "../agent/core.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventBus } from "../agent/events.js";
import type { GovernanceEngine } from "../governance/index.js";
import type {
  Goal,
  Plan,
  PlanStep,
  AgentMode,
  AgentEvent,
  Investigation,
  StepStatus,
  VMInfo,
  NodeInfo,
  AuditEntry,
} from "../types.js";

// ── ANSI Color Helpers ──────────────────────────────────────

function color(text: string, code: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function bold(text: string): string {
  return color(text, "1");
}

function dim(text: string): string {
  return color(text, "2");
}

function green(text: string): string {
  return color(text, "32");
}

function red(text: string): string {
  return color(text, "31");
}

function yellow(text: string): string {
  return color(text, "33");
}

function blue(text: string): string {
  return color(text, "34");
}

function cyan(text: string): string {
  return color(text, "36");
}

function magenta(text: string): string {
  return color(text, "35");
}

// ── Formatting Helpers ──────────────────────────────────────

function formatStepStatus(status: StepStatus): string {
  switch (status) {
    case "success":
      return green("✓");
    case "failed":
      return red("✗");
    case "running":
      return yellow("⟳");
    case "pending":
      return dim("⏳");
    case "skipped":
      return dim("⊘");
    case "rolled_back":
      return magenta("↩");
    default:
      return dim("?");
  }
}

/**
 * Format step output data into clean, readable tables for common actions.
 * Falls back to truncated JSON for unknown shapes.
 */
function formatStepData(action: string, data: unknown): string {
  try {
    if (action === "list_vms" && Array.isArray(data)) {
      if (data.length === 0) return dim("No VMs found.");

      // Sort: running first, then by vmid
      const sorted = [...data].sort((a: any, b: any) => {
        if (a.status === "running" && b.status !== "running") return -1;
        if (a.status !== "running" && b.status === "running") return 1;
        return (a.vmid ?? a.id ?? 0) - (b.vmid ?? b.id ?? 0);
      });

      const rows = sorted.map((vm: any) => {
        const ramUsed = vm.mem ?? 0;
        const ramTotal = vm.maxmem ?? 0;
        const ramGB = ramTotal > 0 ? (ramTotal / (1024 ** 3)).toFixed(1) : "-";
        const ramPct = ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0;
        const ramStr = ramTotal > 0
          ? `${ramGB} GB ${ramBar(ramPct)}`
          : "-";
        const cpuStr = typeof vm.cpu === "number"
          ? (vm.cpu * 100).toFixed(1) + "%"
          : (vm.cpus ? vm.cpus + " cores" : "-");
        const tags = vm.tags ? dim(` [${vm.tags}]`) : "";

        return {
          id: String(vm.vmid ?? vm.id ?? "-"),
          name: String(vm.name ?? "-").slice(0, 24) + tags,
          status: String(vm.status ?? "-"),
          node: String(vm.node ?? "-"),
          cpu: cpuStr,
          ram: ramStr,
          type: String(vm.type === "lxc" ? "CT" : "VM"),
        };
      });

      return renderTable(
        ["ID", "Name", "Status", "Node", "CPU", "RAM", "Type"],
        rows.map(r => [r.id, r.name, colorStatus(r.status), r.node, r.cpu, r.ram, r.type]),
      );
    }

    if (action === "list_nodes" && Array.isArray(data)) {
      if (data.length === 0) return dim("No nodes found.");
      const rows = data.map((n: any) => ({
        name: String(n.node ?? n.name ?? "-"),
        status: String(n.status ?? "-"),
        cpu: typeof n.cpu === "number" ? (n.cpu * 100).toFixed(1) + "%" : "-",
        ram: n.maxmem ? formatBytes(n.mem ?? 0) + " / " + formatBytes(n.maxmem) : "-",
        uptime: typeof n.uptime === "number" ? formatSecs(n.uptime) : "-",
      }));
      return renderTable(
        ["Node", "Status", "CPU", "RAM", "Uptime"],
        rows.map(r => [r.name, colorStatus(r.status), r.cpu, r.ram, r.uptime]),
      );
    }

    if (action === "list_storage" && Array.isArray(data)) {
      if (data.length === 0) return dim("No storage found.");
      const rows = data.map((s: any) => ({
        name: String(s.storage ?? s.name ?? "-"),
        type: String(s.type ?? "-"),
        status: String(s.status ?? s.active ? "active" : "-"),
        total: s.total ? formatBytes(s.total) : "-",
        used: s.used ? formatBytes(s.used) : "-",
        avail: s.avail ? formatBytes(s.avail) : "-",
        node: String(s.node ?? "-"),
      }));
      return renderTable(
        ["Storage", "Type", "Status", "Total", "Used", "Avail", "Node"],
        rows.map(r => [r.name, r.type, r.status, r.total, r.used, r.avail, r.node]),
      );
    }

    if (action === "list_snapshots" && Array.isArray(data)) {
      if (data.length === 0) return dim("No snapshots found.");
      const rows = data.map((s: any) => ({
        name: String(s.name ?? "-"),
        desc: String(s.description ?? s.snaptime ?? "-").slice(0, 30),
        parent: String(s.parent ?? "-"),
      }));
      return renderTable(
        ["Snapshot", "Description", "Parent"],
        rows.map(r => [r.name, r.desc, r.parent]),
      );
    }

    if (action === "list_tasks" && Array.isArray(data)) {
      if (data.length === 0) return dim("No tasks found.");
      const rows = data.map((t: any) => ({
        upid: String(t.upid ?? "-").slice(-20),
        type: String(t.type ?? "-"),
        status: String(t.status ?? "-"),
        node: String(t.node ?? "-"),
        user: String(t.user ?? "-"),
      }));
      return renderTable(
        ["UPID (tail)", "Type", "Status", "Node", "User"],
        rows.map(r => [r.upid, r.type, colorStatus(r.status), r.node, r.user]),
      );
    }

    if ((action === "get_vm_status" || action === "get_vm_config" || action === "get_node_stats") && typeof data === "object" && data !== null) {
      return renderKV(data as Record<string, unknown>);
    }

    // Fallback: compact display
    if (typeof data === "string") return data;
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
      // Generic array of objects — render as table with first few keys
      const keys = Object.keys(data[0]).slice(0, 7);
      const rows = data.map((item: any) =>
        keys.map(k => {
          const v = item[k];
          if (v === undefined || v === null) return "-";
          if (typeof v === "number" && v > 1e9) return formatBytes(v); // likely bytes
          return String(v).slice(0, 24);
        }),
      );
      return renderTable(keys, rows);
    }
    const dataStr = JSON.stringify(data, null, 2);
    const lines = dataStr.split("\n");
    const maxLines = 20;
    if (lines.length <= maxLines) return dataStr;
    return lines.slice(0, maxLines).join("\n") + "\n" + dim(`... (${lines.length - maxLines} more lines)`);
  } catch {
    return typeof data === "string" ? data : JSON.stringify(data, null, 2).slice(0, 2000);
  }
}

/** Render an ASCII table from headers and rows. */
function renderTable(headers: string[], rows: string[][]): string {
  // Strip ANSI for width calculation
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, stripAnsi(row[i] ?? "").length), 0);
    return Math.max(h.length, dataMax);
  });

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
  const sep = dim("  ");

  let out = "\n";
  // Header
  out += dim(headers.map((h, i) => pad(h, widths[i])).join("  ")) + "\n";
  out += dim(widths.map(w => "─".repeat(w)).join("──")) + "\n";
  // Rows
  for (const row of rows) {
    out += row.map((cell, i) => pad(cell, widths[i])).join(sep) + "\n";
  }
  out += dim(`\n${rows.length} item${rows.length === 1 ? "" : "s"}`);
  return out;
}

/** Render key-value pairs for single-object responses. */
function renderKV(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return dim("(empty)");

  const maxKey = Math.min(entries.reduce((m, [k]) => Math.max(m, k.length), 0), 24);

  let out = "\n";
  for (const [key, val] of entries) {
    const k = key.padEnd(maxKey);
    const v = typeof val === "object" ? JSON.stringify(val) : String(val);
    out += `${dim(k)}  ${v.length > 80 ? v.slice(0, 77) + "..." : v}\n`;
  }
  return out;
}

/** Compact ASCII bar for RAM/disk usage */
function ramBar(pct: number): string {
  const width = 8;
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const colorFn = pct > 85 ? red : pct > 60 ? yellow : green;
  return dim("[") + colorFn("█".repeat(filled)) + dim("░".repeat(empty)) + dim("]");
}

function colorStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === "running" || s === "online" || s === "active" || s === "ok" || s === "success") return green(status);
  if (s === "stopped" || s === "offline" || s === "error" || s === "failed") return red(status);
  if (s === "paused" || s === "suspended" || s === "warning") return yellow(status);
  return status;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i >= 3 ? 1 : 0) + " " + units[i];
}

function formatSecs(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatPlanTable(plan: Plan): string {
  const lines: string[] = [];
  const divider = dim("─".repeat(78));

  lines.push("");
  lines.push(divider);
  lines.push(
    bold(
      `  Plan ${cyan(plan.id.slice(0, 8))}  │  ${plan.steps.length} steps  │  Rev ${plan.revision}`,
    ),
  );
  lines.push(divider);
  lines.push(dim("  Reasoning: ") + plan.reasoning);
  lines.push(divider);

  // Resource estimate
  const re = plan.resource_estimate;
  lines.push(
    dim("  Resources: ") +
      `${re.cpu_cores} CPU  │  ${re.ram_mb} MB RAM  │  ${re.disk_gb} GB disk  │  ` +
      `${re.vms_created} VMs  │  ${re.containers_created} containers`,
  );
  lines.push(divider);

  // Column headers
  lines.push(
    bold("  #   Status  Tier          Action                          Description"),
  );
  lines.push(divider);

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const idx = String(i + 1).padStart(3);
    const statusIcon = formatStepStatus(step.status);
    const tier = step.tier.padEnd(13);
    const action = step.action.padEnd(31);
    const desc =
      step.description.length > 40
        ? step.description.slice(0, 37) + "..."
        : step.description;

    lines.push(`  ${idx}   ${statusIcon}       ${dim(tier)} ${action} ${desc}`);

    if (step.depends_on.length > 0) {
      lines.push(dim(`        └─ depends on: ${step.depends_on.join(", ")}`));
    }
  }

  lines.push(divider);
  lines.push("");

  return lines.join("\n");
}

function formatVMTable(vms: VMInfo[]): string {
  const lines: string[] = [];
  const divider = dim("─".repeat(78));

  lines.push("");
  lines.push(divider);
  lines.push(bold("  VMs"));
  lines.push(divider);
  lines.push(
    bold("  ID        Name                Node         Status    CPU  RAM(MB)  IP"),
  );
  lines.push(divider);

  for (const vm of vms) {
    const id = String(vm.id).padEnd(9);
    const name = (vm.name || "").padEnd(19);
    const node = (vm.node || "").padEnd(12);
    const statusColor =
      vm.status === "running"
        ? green
        : vm.status === "stopped"
          ? red
          : yellow;
    const status = statusColor(vm.status.padEnd(9));
    const cpu = String(vm.cpu_cores).padStart(3);
    const ram = String(vm.ram_mb).padStart(7);
    const ip = vm.ip_address || dim("n/a");

    lines.push(`  ${id} ${name} ${node} ${status} ${cpu} ${ram}  ${ip}`);
  }

  lines.push(divider);
  lines.push("");
  return lines.join("\n");
}

function formatNodeTable(nodes: NodeInfo[]): string {
  const lines: string[] = [];
  const divider = dim("─".repeat(78));

  lines.push("");
  lines.push(divider);
  lines.push(bold("  Nodes"));
  lines.push(divider);
  lines.push(
    bold("  Name              Status    CPU(cores)  CPU(%)  RAM(total)  RAM(used)"),
  );
  lines.push(divider);

  for (const node of nodes) {
    const name = node.name.padEnd(17);
    const statusColor =
      node.status === "online"
        ? green
        : node.status === "offline"
          ? red
          : yellow;
    const status = statusColor(node.status.padEnd(9));
    const cpuCores = String(node.cpu_cores).padStart(10);
    const cpuPct = (node.cpu_usage_pct.toFixed(1) + "%").padStart(6);
    const ramTotal = (node.ram_total_mb + " MB").padStart(10);
    const ramUsed = (node.ram_used_mb + " MB").padStart(9);

    lines.push(
      `  ${name} ${status} ${cpuCores} ${cpuPct} ${ramTotal} ${ramUsed}`,
    );
  }

  lines.push(divider);
  lines.push("");
  return lines.join("\n");
}

function formatInvestigation(inv: Investigation): string {
  const lines: string[] = [];
  const divider = dim("─".repeat(78));

  lines.push("");
  lines.push(divider);
  lines.push(bold(cyan("  Investigation Report")));
  lines.push(divider);
  lines.push(dim("  Trigger: ") + inv.trigger);
  lines.push(dim("  Time:    ") + inv.timestamp);
  lines.push(divider);

  lines.push(bold("  Findings:"));
  for (const finding of inv.findings) {
    const severityColor =
      finding.severity === "critical"
        ? red
        : finding.severity === "warning"
          ? yellow
          : dim;
    const badge = severityColor(`[${finding.severity.toUpperCase()}]`);
    lines.push(`    ${badge} ${dim(finding.source)}`);
    lines.push(`        ${finding.detail}`);
  }

  lines.push(divider);
  lines.push(bold("  Root Cause: ") + inv.root_cause);

  if (inv.proposed_fix) {
    lines.push(divider);
    lines.push(bold(green("  Proposed Fix:")));
    lines.push(`    ${inv.proposed_fix.description}`);
    lines.push(
      dim(`    Confidence: ${inv.proposed_fix.confidence}`) +
        (inv.proposed_fix.requires_approval
          ? yellow("  (requires approval)")
          : green("  (auto-applicable)")),
    );
    lines.push(`    Steps: ${inv.proposed_fix.steps.length}`);
  }

  lines.push(divider);
  lines.push("");
  return lines.join("\n");
}

function formatAuditEntries(entries: AuditEntry[]): string {
  const lines: string[] = [];
  const divider = dim("─".repeat(78));

  lines.push("");
  lines.push(divider);
  lines.push(bold("  Audit Log (recent)"));
  lines.push(divider);

  if (entries.length === 0) {
    lines.push(dim("  No audit entries found."));
    lines.push(divider);
    lines.push("");
    return lines.join("\n");
  }

  for (const entry of entries) {
    const resultColor =
      entry.result === "success"
        ? green
        : entry.result === "failed"
          ? red
          : yellow;
    const badge = resultColor(`[${entry.result.toUpperCase()}]`);
    const time = dim(entry.timestamp.slice(11, 19));
    lines.push(`  ${time}  ${badge}  ${entry.action} (${dim(entry.tier)})`);
    if (entry.error) {
      lines.push(red(`           └─ ${entry.error}`));
    }
  }

  lines.push(divider);
  lines.push("");
  return lines.join("\n");
}

/** Simple animated spinner using interval-based dot cycling. */
function spinner(): { stop: () => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${cyan(frames[i % frames.length])} `);
    i++;
  }, 80);

  return {
    stop() {
      clearInterval(interval);
      process.stdout.write("\r" + " ".repeat(10) + "\r");
    },
  };
}

// ── Banner ──────────────────────────────────────────────────

function printBanner(toolRegistry: ToolRegistry): void {
  const lines = [
    "",
    cyan(bold("  ╦┌┐┌┌─┐┬─┐┌─┐╦ ╦┬─┐┌─┐┌─┐")),
    cyan(bold("  ║│││├┤ ├┬┘├─┤║║║├┬┘├─┤├─┘")),
    cyan(bold("  ╩┘└┘└  ┴└─┴ ┴╚╩╝┴└─┴ ┴┴  ")),
    "",
    dim("  Autonomous Infrastructure Agent"),
    "",
    dim("  Tools:    ") + `${toolRegistry.getAllTools().length} registered`,
    "",
    dim("  Type a goal to begin, or use /help for commands."),
    "",
  ];
  console.log(lines.join("\n"));
}

// ── Help Text ───────────────────────────────────────────────

const HELP_TEXT = `
${bold("Commands:")}
  ${cyan("/help")}          Show this help message
  ${cyan("/status")}        Show cluster overview
  ${cyan("/vms")}           List all virtual machines
  ${cyan("/nodes")}         List all cluster nodes
  ${cyan("/plan")}          Show the last executed plan
  ${cyan("/history")}       Show recent agent events
  ${cyan("/investigate")}   ${dim("<query>")}  Run root cause analysis
  ${cyan("/audit")}         Show recent audit log entries
  ${cyan("/clear")}         Clear the screen
  ${cyan("/exit")}          Exit vClaw

${bold("Usage:")}
  Type any text to submit it as a goal to the agent.
  Example: ${dim("build me a 3-node k8s cluster")}
`;

// ── Main CLI Class ──────────────────────────────────────────

export class vClawCLI {
  private agentCore: AgentCore;
  private toolRegistry: ToolRegistry;
  private eventBus: EventBus;
  private governanceEngine: GovernanceEngine;

  private rl: readline.Interface | null = null;
  private lastPlan: Plan | null = null;
  private running = false;

  constructor(
    agentCore: AgentCore,
    toolRegistry: ToolRegistry,
    eventBus: EventBus,
    governanceEngine: GovernanceEngine,
  ) {
    this.agentCore = agentCore;
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.governanceEngine = governanceEngine;
  }

  /**
   * Launch the interactive REPL.
   */
  async start(): Promise<void> {
    this.running = true;
    this.subscribeToEvents();

    printBanner(this.toolRegistry);

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: cyan(bold("infrawrap> ")),
      terminal: true,
    });

    // Route plan approval through our readline
    this.governanceEngine.approvalGate.setPlanApprovalHandler(
      async (_planId, goal, steps, reasoning) => {
        console.log("\n" + cyan(bold("  ┌─ PLAN APPROVAL ─────────────────────────────")));
        console.log(cyan("  │") + ` Goal: ${bold(goal)}`);
        if (reasoning) {
          console.log(cyan("  │") + dim(` Reasoning: ${reasoning}`));
        }
        console.log(cyan("  │"));
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          const tierColor = s.tier === "destructive" ? red : s.tier === "risky_write" ? yellow : green;
          console.log(cyan("  │") + `  ${i + 1}. ${tierColor(`[${s.tier}]`)} ${s.action} — ${s.description}`);
        }
        console.log(cyan("  └────────────────────────────────────────────"));

        return new Promise<boolean>((resolve) => {
          this.rl?.question("\n  Approve this plan? [y/N] ", (answer: string) => {
            const approved = answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
            resolve(approved);
          });
        });
      },
    );

    // Route step-level approval (destructive actions) through our readline
    this.governanceEngine.approvalGate.setExternalHandler(async (_request) => {
      return new Promise<boolean>((resolve) => {
        this.rl?.question("\n  Approve? [y/N] ", (answer: string) => {
          const approved = answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
          resolve(approved);
        });
      });
    });

    this.rl.prompt();

    this.rl.on("line", async (line: string) => {
      const input = line.trim();
      if (!input) {
        this.rl?.prompt();
        return;
      }

      try {
        await this.handleInput(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(red(`  Error: ${msg}`));
      }

      if (this.running) {
        this.rl?.prompt();
      }
    });

    this.rl.on("close", () => {
      this.running = false;
      console.log(dim("\n  Goodbye.\n"));
      process.exit(0);
    });
  }

  /**
   * One-shot mode: process a single input and exit.
   */
  async runOnce(input: string): Promise<void> {
    this.subscribeToEvents();
    printBanner(this.toolRegistry);
    console.log(dim(`  Goal: ${input}\n`));

    await this.executeGoal(input, "build");
  }

  // ── Input Handling ────────────────────────────────────────

  private async handleInput(input: string): Promise<void> {
    if (input.startsWith("/")) {
      await this.handleSlashCommand(input);
    } else {
      await this.executeGoal(input, "build");
    }
  }

  private async handleSlashCommand(input: string): Promise<void> {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    switch (cmd) {
      case "/help":
        console.log(HELP_TEXT);
        break;

      case "/status":
        await this.showStatus();
        break;

      case "/vms":
        await this.showVMs();
        break;

      case "/nodes":
        await this.showNodes();
        break;

      case "/plan":
        this.showLastPlan();
        break;

      case "/history":
        this.showHistory();
        break;

      case "/investigate":
        if (!args) {
          console.log(yellow("  Usage: /investigate <description>"));
          break;
        }
        await this.runInvestigation(args);
        break;

      case "/audit":
        this.showAudit();
        break;

      case "/clear":
        console.clear();
        break;

      case "/exit":
        this.running = false;
        this.rl?.close();
        break;

      default:
        console.log(yellow(`  Unknown command: ${cmd}. Type /help for options.`));
    }
  }

  // ── Goal Execution ────────────────────────────────────────

  private async executeGoal(
    description: string,
    mode: AgentMode,
  ): Promise<void> {
    const goal: Goal = {
      id: randomUUID(),
      mode,
      description,
      raw_input: description,
      created_at: new Date().toISOString(),
    };

    console.log(
      dim(`\n  Mode: ${mode}  │  Goal ID: ${goal.id.slice(0, 8)}\n`),
    );

    const spin = spinner();

    try {
      const result = await this.agentCore.run(goal);
      spin.stop();

      this.lastPlan = result.plan;

      // Determine if this is a simple read-only query (1 step, read tier, success)
      const isSimpleRead = result.success
        && result.plan.steps.length === 1
        && result.plan.steps[0].tier === "read"
        && result.replans === 0;

      // Show step outputs (the actual data returned by tools)
      if (result.outputs.length > 0) {
        for (const output of result.outputs) {
          if (output.success && output.data !== undefined) {
            console.log(
              cyan(bold(`\n  ── ${output.action} ──`)),
            );
            const formatted = formatStepData(output.action, output.data);
            for (const line of formatted.split("\n")) {
              console.log(`  ${line}`);
            }
          }
        }
        console.log("");
      }

      if (isSimpleRead) {
        // Minimal one-line summary for simple reads
        console.log(
          dim(`  ✓ ${result.duration_ms}ms`),
        );
      } else {
        // Show full plan table for multi-step / write operations
        console.log(formatPlanTable(result.plan));

        // Summary
        const summaryColor = result.success ? green : red;
        console.log(
          summaryColor(
            bold(
              `  ${result.success ? "SUCCESS" : "FAILED"}  │  ` +
                `${result.steps_completed} completed  │  ${result.steps_failed} failed  │  ` +
                `${result.replans} replans  │  ${result.duration_ms}ms`,
            ),
          ),
        );
      }

      if (result.errors.length > 0) {
        console.log(red("\n  Errors:"));
        for (const err of result.errors) {
          console.log(red(`    - ${err}`));
        }
      }

      console.log("");
    } catch (err) {
      spin.stop();
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`\n  Execution failed: ${msg}\n`));
    }
  }

  // ── Slash Command Handlers ────────────────────────────────

  private async showStatus(): Promise<void> {
    const spin = spinner();

    try {
      const state = await this.toolRegistry.getClusterState();
      spin.stop();

      if (!state) {
        console.log(yellow("\n  No cluster connection available.\n"));
        return;
      }

      const divider = dim("─".repeat(78));
      console.log("");
      console.log(divider);
      console.log(bold(cyan("  Cluster Status")));
      console.log(divider);
      console.log(dim("  Adapter:    ") + state.adapter);
      console.log(dim("  Timestamp:  ") + state.timestamp);
      console.log(dim("  Nodes:      ") + state.nodes.length);
      console.log(dim("  VMs:        ") + state.vms.length);
      console.log(dim("  Containers: ") + state.containers.length);
      console.log(dim("  Storage:    ") + state.storage.length);

      // Circuit breaker state
      const cbState = this.governanceEngine.getCircuitBreakerState();
      const cbStatus = cbState.tripped
        ? red("TRIPPED")
        : green("OK");
      console.log(
        dim("  Circuit:    ") +
          cbStatus +
          dim(` (${cbState.consecutive_failures} consecutive failures)`),
      );

      console.log(divider);
      console.log("");
    } catch (err) {
      spin.stop();
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`\n  Failed to get cluster status: ${msg}\n`));
    }
  }

  private async showVMs(): Promise<void> {
    const spin = spinner();

    try {
      const state = await this.toolRegistry.getClusterState();
      spin.stop();

      if (!state) {
        console.log(yellow("\n  No cluster connection available.\n"));
        return;
      }

      if (state.vms.length === 0) {
        console.log(dim("\n  No VMs found.\n"));
        return;
      }

      console.log(formatVMTable(state.vms));
    } catch (err) {
      spin.stop();
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`\n  Failed to list VMs: ${msg}\n`));
    }
  }

  private async showNodes(): Promise<void> {
    const spin = spinner();

    try {
      const state = await this.toolRegistry.getClusterState();
      spin.stop();

      if (!state) {
        console.log(yellow("\n  No cluster connection available.\n"));
        return;
      }

      if (state.nodes.length === 0) {
        console.log(dim("\n  No nodes found.\n"));
        return;
      }

      console.log(formatNodeTable(state.nodes));
    } catch (err) {
      spin.stop();
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`\n  Failed to list nodes: ${msg}\n`));
    }
  }

  private showLastPlan(): void {
    if (!this.lastPlan) {
      console.log(dim("\n  No plan has been executed yet.\n"));
      return;
    }
    console.log(formatPlanTable(this.lastPlan));
  }

  private showHistory(): void {
    const events = this.eventBus.getHistory(20);

    if (events.length === 0) {
      console.log(dim("\n  No events in history.\n"));
      return;
    }

    const divider = dim("─".repeat(78));
    console.log("");
    console.log(divider);
    console.log(bold("  Recent Events"));
    console.log(divider);

    for (const event of events) {
      const time = dim(event.timestamp.slice(11, 19));
      const typeColor = event.type.includes("fail")
        ? red
        : event.type.includes("complete") || event.type.includes("approved")
          ? green
          : event.type.includes("started") || event.type.includes("created")
            ? cyan
            : yellow;
      const typeLabel = typeColor(event.type.padEnd(28));
      const summary = dim(JSON.stringify(event.data).slice(0, 50));
      console.log(`  ${time}  ${typeLabel}  ${summary}`);
    }

    console.log(divider);
    console.log("");
  }

  private async runInvestigation(trigger: string): Promise<void> {
    console.log(dim(`\n  Investigating: ${trigger}\n`));
    const spin = spinner();

    try {
      const investigation = await this.agentCore.investigate(trigger);
      spin.stop();
      console.log(formatInvestigation(investigation));
    } catch (err) {
      spin.stop();
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`\n  Investigation failed: ${msg}\n`));
    }
  }

  private showAudit(): void {
    try {
      const stats = this.governanceEngine.getAuditStats() as {
        total: number;
        recent_failures: AuditEntry[];
      };

      if (stats.total === 0) {
        console.log(dim("\n  No audit entries recorded.\n"));
        return;
      }

      // Show stats summary
      const divider = dim("─".repeat(78));
      console.log("");
      console.log(divider);
      console.log(bold("  Audit Summary"));
      console.log(divider);
      console.log(dim("  Total entries: ") + String(stats.total));

      if (stats.recent_failures.length > 0) {
        console.log(formatAuditEntries(stats.recent_failures));
      } else {
        console.log(green("  No recent failures."));
        console.log(divider);
        console.log("");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`\n  Failed to load audit log: ${msg}\n`));
    }
  }

  // ── Event Subscriptions ───────────────────────────────────

  private subscribeToEvents(): void {
    this.eventBus.on("plan_created", (event: AgentEvent) => {
      const data = event.data as {
        plan_id: string;
        goal: string;
        step_count: number;
      };
      console.log(
        cyan(
          `\n  [plan] Created plan ${data.plan_id?.toString().slice(0, 8)} ` +
            `with ${data.step_count} steps`,
        ),
      );
    });

    this.eventBus.on("plan_approved", (event: AgentEvent) => {
      const data = event.data as { plan_id: string };
      console.log(
        green(
          `  [plan] Plan ${data.plan_id?.toString().slice(0, 8)} approved`,
        ),
      );
    });

    this.eventBus.on("step_started", (event: AgentEvent) => {
      const data = event.data as { step_id: string; action: string };
      console.log(
        yellow(
          `  ${formatStepStatus("running")} Step ${data.step_id?.toString().slice(0, 8)}: ${data.action}`,
        ),
      );
    });

    this.eventBus.on("step_completed", (event: AgentEvent) => {
      const data = event.data as {
        step_id: string;
        action: string;
        duration_ms: number;
      };
      console.log(
        green(
          `  ${formatStepStatus("success")} Step ${data.step_id?.toString().slice(0, 8)}: ${data.action} (${data.duration_ms}ms)`,
        ),
      );
    });

    this.eventBus.on("step_failed", (event: AgentEvent) => {
      const data = event.data as {
        step_id: string;
        action: string;
        error: string;
      };
      console.log(
        red(
          `  ${formatStepStatus("failed")} Step ${data.step_id?.toString().slice(0, 8)}: ${data.action}`,
        ),
      );
      if (data.error) {
        console.log(red(`        └─ ${data.error}`));
      }
    });

    this.eventBus.on("replan", (event: AgentEvent) => {
      const data = event.data as {
        new_plan_id: string;
        reasoning: string;
      };
      console.log(
        magenta(
          `\n  [replan] New plan ${data.new_plan_id?.toString().slice(0, 8)}: ${data.reasoning}`,
        ),
      );
    });

    this.eventBus.on("investigation_started", (event: AgentEvent) => {
      const data = event.data as { trigger: string };
      console.log(cyan(`\n  [investigate] Starting: ${data.trigger}`));
    });

    this.eventBus.on("investigation_complete", (event: AgentEvent) => {
      const data = event.data as {
        root_cause: string;
        findings_count: number;
        has_fix: boolean;
      };
      console.log(
        cyan(
          `  [investigate] Complete: ${data.findings_count} findings, ` +
            `fix ${data.has_fix ? "available" : "unavailable"}`,
        ),
      );
    });

    this.eventBus.on("approval_requested", (event: AgentEvent) => {
      const data = event.data as {
        plan_id: string;
        type: string;
        mode: string;
      };
      console.log(
        yellow(
          `\n  [approval] Approval requested for plan ${data.plan_id?.toString().slice(0, 8)} (${data.mode} mode)`,
        ),
      );
    });

    this.eventBus.on("circuit_breaker_tripped", () => {
      console.log(
        red(bold("\n  [CIRCUIT BREAKER] Tripped — execution halted.")),
      );
    });

    this.eventBus.on("alert_fired", (event: AgentEvent) => {
      const data = event.data as {
        severity: string;
        message: string;
        source: string;
      };
      const severityColor =
        data.severity === "critical"
          ? red
          : data.severity === "warning"
            ? yellow
            : dim;
      console.log(
        severityColor(
          `\n  [ALERT] ${data.severity?.toUpperCase()}: ${data.message} (${data.source})`,
        ),
      );
    });
  }
}
