// ============================================================
// vClaw — Telegram Bot Frontend
// Mobile interface for the autonomous infrastructure agent
// ============================================================

import { Bot, Context, InlineKeyboard } from "grammy";
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
  StepStatus,
  VMInfo,
  NodeInfo,
  StorageInfo,
  Investigation,
} from "../types.js";
import type { ChaosEngine, BlastRadiusResult, ChaosRun } from "../chaos/engine.js";

// ── Telegram MarkdownV2 Helpers ─────────────────────────────

const MD2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

function escMd2(text: string): string {
  return text.replace(MD2_SPECIAL, "\\$1");
}

function md2Bold(text: string): string {
  return `*${escMd2(text)}*`;
}

function md2Italic(text: string): string {
  return `_${escMd2(text)}_`;
}

function md2Code(text: string): string {
  return `\`${text.replace(/[`\\]/g, "\\$&")}\``;
}

function md2Pre(text: string, lang = ""): string {
  const escaped = text.replace(/`/g, "\\`");
  return `\`\`\`${lang}\n${escaped}\n\`\`\``;
}

// ── Safe Send (MarkdownV2 → plain text fallback) ────────────

async function safeSend(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "MarkdownV2" });
  } catch {
    const plain = text
      .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/_([^_]+)_/g, "$1");
    await ctx.reply(plain);
  }
}

async function safeSendWithKeyboard(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: keyboard });
  } catch {
    const plain = text
      .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/_([^_]+)_/g, "$1");
    await ctx.reply(plain, { reply_markup: keyboard });
  }
}

// ── Formatting Helpers ──────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function statusEmoji(status: string): string {
  switch (status) {
    case "running":
    case "online":
      return "\u{1F7E2}";
    case "stopped":
    case "offline":
      return "\u{1F534}";
    case "paused":
    case "suspended":
      return "\u{1F7E1}";
    default:
      return "\u26AA";
  }
}

function stepStatusIcon(status: StepStatus): string {
  switch (status) {
    case "success":
      return "\u2705";
    case "failed":
      return "\u274C";
    case "running":
      return "\u23F3";
    case "pending":
      return "\u23F8";
    case "skipped":
      return "\u23ED";
    case "rolled_back":
      return "\u21A9";
    default:
      return "\u2753";
  }
}

function progressBar(pct: number, width = 8): string {
  const filled = Math.round((pct / 100) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

// ── Message Formatters ──────────────────────────────────────

function formatStatusMessage(
  nodes: NodeInfo[],
  vms: VMInfo[],
  containers: { id: string | number; name: string; status: string }[],
  storage: StorageInfo[],
): string {
  const lines: string[] = [];

  // Header
  lines.push(`\u{1F3E0} ${md2Bold("vClaw Cluster Status")}`);
  lines.push("");

  // Nodes
  for (const node of nodes) {
    const icon = statusEmoji(node.status);
    const cpuPct = node.cpu_usage_pct;
    const ramPct = node.ram_total_mb > 0
      ? Math.round((node.ram_used_mb / node.ram_total_mb) * 100)
      : 0;
    const ramGB = (node.ram_total_mb / 1024).toFixed(1);

    lines.push(`${icon} ${md2Bold(node.name)}`);
    lines.push(
      `   CPU: ${md2Code(progressBar(cpuPct))} ${escMd2(cpuPct.toFixed(1) + "%")} \\(${escMd2(String(node.cpu_cores))} cores\\)`,
    );
    lines.push(
      `   RAM: ${md2Code(progressBar(ramPct))} ${escMd2(ramPct + "%")} \\(${escMd2(ramGB + " GB")}\\)`,
    );
    lines.push(
      `   Uptime: ${md2Code(formatUptime(node.uptime_s))}`,
    );
    lines.push("");
  }

  // Summary counts
  const running = vms.filter((v) => v.status === "running").length;
  const stopped = vms.filter((v) => v.status === "stopped").length;
  const ctRunning = containers.filter((c) => c.status === "running").length;

  lines.push(`\u{1F5A5} ${md2Bold("Resources")}`);
  lines.push(
    `   VMs: ${escMd2(String(vms.length))} \\(${escMd2(String(running))} running, ${escMd2(String(stopped))} stopped\\)`,
  );
  if (containers.length > 0) {
    lines.push(
      `   Containers: ${escMd2(String(containers.length))} \\(${escMd2(String(ctRunning))} running\\)`,
    );
  }
  lines.push(`   Storage pools: ${escMd2(String(storage.length))}`);

  return lines.join("\n");
}

function formatVMListMessage(vms: VMInfo[]): string {
  if (vms.length === 0) {
    return escMd2("No VMs found.");
  }

  // Sort: running first, then by id
  const sorted = [...vms].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    return Number(a.id) - Number(b.id);
  });

  const lines: string[] = [
    `\u{1F5A5} ${md2Bold("Virtual Machines")} \\(${escMd2(String(vms.length))}\\)`,
    "",
  ];

  for (const vm of sorted) {
    const icon = statusEmoji(vm.status);
    const ramStr = vm.ram_mb >= 1024
      ? (vm.ram_mb / 1024).toFixed(1) + " GB"
      : vm.ram_mb + " MB";

    lines.push(
      `${icon} ${md2Code(String(vm.id))} ${md2Bold(vm.name)}`,
    );
    lines.push(
      `   ${escMd2(vm.node)} \\| ${escMd2(String(vm.cpu_cores))} cores \\| ${escMd2(ramStr)} \\| ${escMd2(vm.disk_gb + " GB")}`,
    );
    if (vm.uptime_s && vm.uptime_s > 0) {
      lines.push(
        `   Uptime: ${md2Code(formatUptime(vm.uptime_s))}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatVMDetail(vm: VMInfo): string {
  const icon = statusEmoji(vm.status);
  const ramStr = vm.ram_mb >= 1024
    ? (vm.ram_mb / 1024).toFixed(1) + " GB"
    : vm.ram_mb + " MB";

  const lines = [
    `${icon} ${md2Bold(vm.name)} \\(${md2Code(String(vm.id))}\\)`,
    "",
    `\u{1F4CB} ${md2Bold("Details")}`,
    `   Status: ${md2Code(vm.status)}`,
    `   Node: ${md2Code(vm.node)}`,
    "",
    `\u{1F4CA} ${md2Bold("Resources")}`,
    `   CPU: ${escMd2(String(vm.cpu_cores))} cores`,
    `   RAM: ${escMd2(ramStr)}`,
    `   Disk: ${escMd2(vm.disk_gb + " GB")}`,
  ];

  if (vm.ip_address) {
    lines.push(`   IP: ${md2Code(vm.ip_address)}`);
  }
  if (vm.uptime_s && vm.uptime_s > 0) {
    lines.push(`   Uptime: ${md2Code(formatUptime(vm.uptime_s))}`);
  }

  return lines.join("\n");
}

function formatNodeListMessage(nodes: NodeInfo[]): string {
  if (nodes.length === 0) {
    return escMd2("No nodes found.");
  }

  const lines: string[] = [
    `\u{1F3E0} ${md2Bold("Cluster Nodes")} \\(${escMd2(String(nodes.length))}\\)`,
    "",
  ];

  for (const node of nodes) {
    const icon = statusEmoji(node.status);
    const cpuPct = node.cpu_usage_pct;
    const ramPct = node.ram_total_mb > 0
      ? Math.round((node.ram_used_mb / node.ram_total_mb) * 100)
      : 0;

    lines.push(`${icon} ${md2Bold(node.name)}`);
    lines.push(
      `   CPU: ${md2Code(progressBar(cpuPct))} ${escMd2(cpuPct.toFixed(1) + "% of " + node.cpu_cores + " cores")}`,
    );
    lines.push(
      `   RAM: ${md2Code(progressBar(ramPct))} ${escMd2(node.ram_used_mb + " / " + node.ram_total_mb + " MB")}`,
    );
    lines.push(`   Uptime: ${md2Code(formatUptime(node.uptime_s))}`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatStorageMessage(storage: StorageInfo[]): string {
  if (storage.length === 0) {
    return escMd2("No storage found.");
  }

  const lines: string[] = [
    `\u{1F4BE} ${md2Bold("Storage Pools")} \\(${escMd2(String(storage.length))}\\)`,
    "",
  ];

  for (const s of storage) {
    const usedPct = s.total_gb > 0 ? Math.round((s.used_gb / s.total_gb) * 100) : 0;
    lines.push(`${md2Bold(s.id)} \\(${escMd2(s.type)}\\) on ${escMd2(s.node)}`);
    lines.push(
      `   ${md2Code(progressBar(usedPct))} ${escMd2(s.used_gb.toFixed(1) + " / " + s.total_gb.toFixed(1) + " GB")} \\(${escMd2(usedPct + "%")}\\)`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

function formatPlanMessage(plan: Plan): string {
  const lines: string[] = [];

  lines.push(md2Bold(`Plan ${plan.id.slice(0, 8)}`));
  lines.push(`${md2Italic("Steps:")} ${escMd2(String(plan.steps.length))} \\| ${md2Italic("Rev:")} ${escMd2(String(plan.revision))}`);
  lines.push("");

  if (plan.reasoning) {
    lines.push(escMd2(plan.reasoning.slice(0, 200)));
    lines.push("");
  }

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const icon = stepStatusIcon(step.status);
    const desc = step.description.length > 50
      ? step.description.slice(0, 47) + "..."
      : step.description;
    lines.push(
      `${icon} ${md2Code(step.action)} \\- ${escMd2(desc)}`,
    );
  }

  return lines.join("\n");
}

// ── Smart Output Formatter ──────────────────────────────────
// Renders common tool outputs as clean Telegram messages instead of raw JSON

function formatOutputData(action: string, data: unknown): string {
  try {
    // ── list_vms ──
    if (action === "list_vms" && Array.isArray(data)) {
      if (data.length === 0) return "No VMs found.";
      const sorted = [...data].sort((a: any, b: any) => {
        if (a.status === "running" && b.status !== "running") return -1;
        if (a.status !== "running" && b.status === "running") return 1;
        return (a.vmid ?? a.id ?? 0) - (b.vmid ?? b.id ?? 0);
      });
      const lines = [`\u{1F5A5} VMs (${data.length})`, ""];
      for (const vm of sorted) {
        const icon = statusEmoji(vm.status ?? "unknown");
        const id = vm.vmid ?? vm.id ?? "?";
        const name = vm.name ?? `vm-${id}`;
        const ramBytes = vm.maxmem ?? 0;
        const ramStr = ramBytes > 0
          ? ramBytes >= 1073741824
            ? (ramBytes / 1073741824).toFixed(1) + " GB"
            : Math.round(ramBytes / 1048576) + " MB"
          : "-";
        const cpuStr = typeof vm.cpu === "number"
          ? (vm.cpu * 100).toFixed(1) + "%"
          : (vm.cpus ? vm.cpus + " cores" : "-");
        const node = vm.node ?? "-";
        const tags = vm.tags ? ` [${vm.tags}]` : "";
        lines.push(`${icon} ${id} ${name}${tags}`);
        lines.push(`   ${node} \u2022 CPU: ${cpuStr} \u2022 RAM: ${ramStr}`);
        if (vm.uptime && vm.uptime > 0) {
          lines.push(`   Uptime: ${formatUptime(vm.uptime)}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    }

    // ── list_nodes / get_nodes ──
    if ((action === "list_nodes" || action === "get_nodes") && Array.isArray(data)) {
      if (data.length === 0) return "No nodes found.";
      const lines = [`\u{1F3E0} Nodes (${data.length})`, ""];
      for (const n of data) {
        const icon = statusEmoji(n.status ?? "unknown");
        const name = n.node ?? n.name ?? "?";
        const cpuPct = typeof n.cpu === "number" ? (n.cpu * 100).toFixed(1) + "%" : "-";
        const ramUsed = n.mem ?? 0;
        const ramTotal = n.maxmem ?? 0;
        const ramPct = ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) + "%" : "-";
        const ramGB = ramTotal > 0 ? (ramTotal / 1073741824).toFixed(1) + " GB" : "-";
        lines.push(`${icon} ${name}`);
        lines.push(`   CPU: ${progressBar(parseFloat(cpuPct) || 0)} ${cpuPct} (${n.maxcpu ?? "?"} cores)`);
        lines.push(`   RAM: ${progressBar(parseInt(ramPct) || 0)} ${ramPct} / ${ramGB}`);
        if (n.uptime) lines.push(`   Uptime: ${formatUptime(n.uptime)}`);
        lines.push("");
      }
      return lines.join("\n");
    }

    // ── get_vm_status / get_vm_config ──
    if ((action === "get_vm_status" || action === "get_vm_config") && typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      const lines: string[] = [];
      const name = d.name ?? d.vmid ?? "VM";
      const icon = statusEmoji(String(d.status ?? "unknown"));
      lines.push(`${icon} ${name}`);
      lines.push("");

      const importantKeys = ["status", "vmid", "name", "cpus", "cores", "memory", "maxmem", "maxdisk", "netin", "netout", "uptime", "node", "type"];
      const shown = new Set<string>();

      for (const key of importantKeys) {
        if (d[key] !== undefined && d[key] !== null) {
          let val = d[key];
          if (typeof val === "number" && (key === "maxmem" || key === "mem" || key === "memory" || key === "maxdisk" || key === "netin" || key === "netout")) {
            val = formatBytes(val as number);
          } else if (typeof val === "number" && key === "uptime") {
            val = formatUptime(val as number);
          }
          lines.push(`  ${key}: ${val}`);
          shown.add(key);
        }
      }

      // Show remaining keys
      const remaining = Object.entries(d).filter(([k]) => !shown.has(k));
      if (remaining.length > 0) {
        lines.push("");
        for (const [k, v] of remaining.slice(0, 10)) {
          const val = typeof v === "object" ? JSON.stringify(v) : String(v);
          lines.push(`  ${k}: ${val.slice(0, 80)}`);
        }
        if (remaining.length > 10) {
          lines.push(`  ... and ${remaining.length - 10} more fields`);
        }
      }
      return lines.join("\n");
    }

    // ── list_storage ──
    if (action === "list_storage" && Array.isArray(data)) {
      if (data.length === 0) return "No storage found.";
      const lines = [`\u{1F4BE} Storage (${data.length})`, ""];
      for (const s of data) {
        const name = s.storage ?? s.name ?? "?";
        const total = s.total ?? 0;
        const used = s.used ?? 0;
        const pct = total > 0 ? Math.round((used / total) * 100) : 0;
        lines.push(`${name} (${s.type ?? "?"}) on ${s.node ?? "?"}`);
        lines.push(`   ${progressBar(pct)} ${formatBytes(used)} / ${formatBytes(total)} (${pct}%)`);
        lines.push("");
      }
      return lines.join("\n");
    }

    // ── list_snapshots ──
    if (action === "list_snapshots" && Array.isArray(data)) {
      if (data.length === 0) return "No snapshots found.";
      const lines = [`\u{1F4F7} Snapshots (${data.length})`, ""];
      for (const s of data) {
        const name = s.name ?? "?";
        const desc = s.description ?? "";
        const parent = s.parent ? ` (parent: ${s.parent})` : "";
        lines.push(`  \u2022 ${name}${parent}`);
        if (desc) lines.push(`    ${desc}`);
      }
      return lines.join("\n");
    }

    // ── list_tasks ──
    if (action === "list_tasks" && Array.isArray(data)) {
      if (data.length === 0) return "No tasks found.";
      const lines = [`\u{1F4CB} Tasks (${data.length})`, ""];
      for (const t of data.slice(0, 15)) {
        const icon = t.status === "OK" ? "\u2705" : t.status?.includes("ERROR") ? "\u274C" : "\u23F3";
        lines.push(`${icon} ${t.type ?? "?"} — ${t.status ?? "?"} (${t.user ?? "?"})`);
      }
      if (data.length > 15) lines.push(`\n... and ${data.length - 15} more`);
      return lines.join("\n");
    }

    // ── create_vm / start_vm / stop_vm (task ID responses) ──
    if (typeof data === "string" && data.startsWith("UPID:")) {
      return `\u2705 Task started: ${data.split(":").slice(-2).join(":")}`;
    }

    // ── Generic object ──
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const entries = Object.entries(data as Record<string, unknown>);
      if (entries.length <= 15) {
        const lines: string[] = [];
        for (const [k, v] of entries) {
          const val = typeof v === "object" ? JSON.stringify(v) : String(v ?? "-");
          lines.push(`  ${k}: ${val.slice(0, 100)}`);
        }
        return lines.join("\n");
      }
    }

    // ── Generic array ──
    if (Array.isArray(data) && data.length > 0) {
      const lines = [`${data.length} items:`, ""];
      for (const item of data.slice(0, 10)) {
        if (typeof item === "object" && item !== null) {
          const keys = Object.keys(item).slice(0, 4);
          const parts = keys.map((k) => `${k}: ${String((item as any)[k]).slice(0, 20)}`);
          lines.push(`  \u2022 ${parts.join(" | ")}`);
        } else {
          lines.push(`  \u2022 ${String(item).slice(0, 80)}`);
        }
      }
      if (data.length > 10) lines.push(`\n  ... and ${data.length - 10} more`);
      return lines.join("\n");
    }
  } catch {
    // Fall through to default
  }

  // ── Default: compact JSON ──
  const str = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return str.length > 2000 ? str.slice(0, 2000) + "\n..." : str;
}

// ── Inline Keyboards ────────────────────────────────────────

function vmActionsKeyboard(vmid: number, status: string): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (status === "stopped") {
    kb.text("\u25B6 Start", `vm_start:${vmid}`);
  } else if (status === "running") {
    kb.text("\u23F9 Stop", `vm_stop:${vmid}`)
      .text("\u{1F504} Restart", `vm_restart:${vmid}`);
  }

  kb.row();
  kb.text("\u{1F4F7} Snapshot", `vm_snap:${vmid}`)
    .text("\u{1F4CB} Detail", `vm_detail:${vmid}`);

  return kb;
}

function confirmKeyboard(action: string, vmid: number, vmName?: string): InlineKeyboard {
  const label = vmName ? `${vmName} (${vmid})` : `VM ${vmid}`;
  const icons: Record<string, string> = {
    start: "\u25B6",
    stop: "\u23F9",
    restart: "\u{1F504}",
    snapshot: "\u{1F4F7}",
    delete: "\u{1F5D1}",
  };
  const icon = icons[action] || "\u2705";

  return new InlineKeyboard()
    .text(`${icon} Yes, ${action} ${label}`, `confirm:${action}:${vmid}`)
    .text("\u274C Cancel", "cancel_action");
}

// ── Pending Approval Tracking ───────────────────────────────

interface PendingApproval {
  planId: string;
  plan: Plan;
  chatId: number;
  messageId: number;
  goal: Goal;
  resolveApproval: (approved: boolean) => void;
}

// ── Bot Configuration ───────────────────────────────────────

export interface TelegramBotConfig {
  botToken: string;
  allowedUsers: number[];
}

// ── Main Bot Class ──────────────────────────────────────────

export class vClawBot {
  private bot: Bot;
  private agentCore: AgentCore;
  private toolRegistry: ToolRegistry;
  private eventBus: EventBus;
  private governanceEngine?: GovernanceEngine;

  /** Set externally after construction (requires HealingOrchestrator). */
  chaosEngine?: ChaosEngine;

  private allowedUsers: Set<number>;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private progressMessages: Map<string, { chatId: number; messageId: number }> =
    new Map();
  private lastActiveChatId: number | null = null;

  /**
   * Get the chat ID to send messages to.
   * Falls back to the first allowed user if no active chat.
   */
  private getChatId(): number | null {
    if (this.lastActiveChatId) return this.lastActiveChatId;
    // Fallback: use first allowed user's ID (works for private chats)
    const first = this.allowedUsers.values().next();
    return first.done ? null : first.value;
  }

  /**
   * Escape text for Telegram HTML parse mode.
   */
  private escHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  constructor(
    config: TelegramBotConfig,
    agentCore: AgentCore,
    toolRegistry: ToolRegistry,
    eventBus: EventBus,
    governanceEngine?: GovernanceEngine,
  ) {
    this.bot = new Bot(config.botToken);
    this.agentCore = agentCore;
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.governanceEngine = governanceEngine;
    this.allowedUsers = new Set(config.allowedUsers);

    this.registerMiddleware();
    this.registerCommands();
    this.registerCallbackQueries();
    this.registerTextHandler();
    this.subscribeToEvents();
  }

  /**
   * Launch the bot and start polling for updates.
   */
  async start(): Promise<void> {
    console.log("[telegram] Starting vClaw Telegram bot...");

    await this.bot.api.setMyCommands([
      { command: "help", description: "Show all commands" },
      { command: "status", description: "Cluster overview with resource bars" },
      { command: "vms", description: "List all VMs with action buttons" },
      { command: "vm", description: "VM detail — /vm <vmid>" },
      { command: "nodes", description: "Node details" },
      { command: "storage", description: "Storage pools" },
      { command: "start", description: "Start a VM — /start <vmid>" },
      { command: "stop", description: "Stop a VM — /stop <vmid>" },
      { command: "restart", description: "Restart a VM — /restart <vmid>" },
      { command: "snap", description: "Snapshot a VM — /snap <vmid>" },
      { command: "build", description: "Run agent goal — /build <description>" },
      { command: "investigate", description: "Root cause analysis" },
      { command: "audit", description: "Recent audit entries" },
      { command: "governance", description: "Governance status" },
      { command: "incidents", description: "Open & recent incidents" },
      { command: "chaos", description: "Chaos engineering — /chaos help" },
    ]);

    // Register as the plan-level approval handler
    // This shows the full plan in Telegram and waits for one Approve/Deny
    // Once approved, all non-destructive steps auto-execute without individual approval
    if (this.governanceEngine) {
      this.governanceEngine.approvalGate.setPlanApprovalHandler(
        async (planId, goal, steps, reasoning) => {
          const chatId = this.getChatId();
          if (!chatId) {
            console.error("[telegram] No active chat for plan approval — auto-denying");
            return false;
          }

          const lines = [
            "\u{1F4CB} PLAN APPROVAL REQUIRED",
            "",
            `\u{1F3AF} Goal: ${goal}`,
            "",
            `\u{1F4DD} Steps (${steps.length}):`,
          ];

          for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            const tierIcon = s.tier === "destructive" ? "\u{1F534}" : s.tier === "risky_write" ? "\u{1F7E1}" : s.tier === "safe_write" ? "\u{1F7E2}" : "\u26AA";
            lines.push(`  ${i + 1}. ${tierIcon} ${s.action} — ${s.description}`);
          }

          if (reasoning) {
            lines.push("");
            lines.push(`\u{1F4AC} Reasoning: ${reasoning}`);
          }

          const shortId = planId.slice(0, 8);
          const keyboard = new InlineKeyboard()
            .text("\u2705 Approve Plan", `plan_approve:${shortId}`)
            .text("\u274C Deny Plan", `plan_deny:${shortId}`);

          try {
            await this.bot.api.sendMessage(chatId, lines.join("\n"), {
              reply_markup: keyboard,
            });
          } catch (err) {
            console.error("[telegram] Failed to send plan approval:", err);
            return false;
          }

          return new Promise<boolean>((resolve) => {
            this.pendingApprovals.set(shortId, {
              planId,
              plan: { id: planId, steps: [], reasoning, status: "pending", goal_id: "", created_at: "", resource_estimate: { ram_mb: 0, disk_gb: 0, cpu_cores: 0, vms_created: 0, containers_created: 0 }, revision: 0 } as unknown as Plan,
              chatId,
              messageId: 0,
              goal: { id: "", mode: "build", description: goal, raw_input: "", created_at: "" } as unknown as Goal,
              resolveApproval: resolve,
            });

            // Timeout after 5 minutes
            setTimeout(() => {
              if (this.pendingApprovals.has(shortId)) {
                this.pendingApprovals.delete(shortId);
                resolve(false);
                this.bot.api.sendMessage(chatId, "\u23F0 Plan approval timed out — auto-denied.").catch(() => {});
              }
            }, 5 * 60 * 1000);
          });
        },
      );

      // Also keep step-level handler for destructive actions that still need individual approval
      this.governanceEngine.approvalGate.setExternalHandler(async (request) => {
        const chatId = this.getChatId();
        if (!chatId) {
          console.error("[telegram] No active chat for step approval — auto-denying");
          return false;
        }

        const requestId = request.id || randomUUID();
        const tierLabel = request.tier.replace(/_/g, " ").toUpperCase();

        const keyboard = new InlineKeyboard()
          .text("\u2705 Approve", `gov_approve:${requestId.slice(0, 8)}`)
          .text("\u274C Deny", `gov_deny:${requestId.slice(0, 8)}`);

        const lines = [
          "\u{1F6A8} STEP APPROVAL REQUIRED",
          "",
          `Action:  ${request.action}`,
          `Tier:    ${tierLabel}`,
        ];
        if (request.reasoning) {
          lines.push(`Reason:  ${request.reasoning}`);
        }
        // Filter out internal params
        const displayParams = Object.fromEntries(
          Object.entries(request.params || {}).filter(([k]) => !k.startsWith("_")),
        );
        if (Object.keys(displayParams).length > 0) {
          lines.push(`Params:  ${JSON.stringify(displayParams)}`);
        }

        try {
          await this.bot.api.sendMessage(chatId, lines.join("\n"), {
            reply_markup: keyboard,
          });
        } catch (err) {
          console.error("[telegram] Failed to send step approval:", err);
          return false;
        }

        const shortId = requestId.slice(0, 8);
        return new Promise<boolean>((resolve) => {
          this.pendingApprovals.set(shortId, {
            planId: requestId,
            plan: { id: requestId, steps: [], reasoning: "", status: "pending", goal_id: "", created_at: "", resource_estimate: { ram_mb: 0, disk_gb: 0, cpu_cores: 0, vms_created: 0, containers_created: 0 }, revision: 0 } as unknown as Plan,
            chatId,
            messageId: 0,
            goal: { id: "", mode: "build", description: request.action, raw_input: "", created_at: "" } as unknown as Goal,
            resolveApproval: resolve,
          });

          setTimeout(() => {
            if (this.pendingApprovals.has(shortId)) {
              this.pendingApprovals.delete(shortId);
              resolve(false);
              this.bot.api.sendMessage(chatId, "\u23F0 Approval timed out — auto-denied.").catch(() => {});
            }
          }, 5 * 60 * 1000);
        });
      });
    }

    this.bot.start({
      drop_pending_updates: true,
      onStart: () => console.log("[telegram] Bot is running."),
    });
  }

  // ── Middleware ────────────────────────────────────────────

  private registerMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.allowedUsers.has(userId)) {
        console.log(
          `[telegram] Rejected message from unauthorized user: ${userId ?? "unknown"}`,
        );
        await ctx.reply("\u{1F6AB} You are not authorized to use this bot.");
        return;
      }
      if (ctx.chat?.id) this.lastActiveChatId = ctx.chat.id;
      await next();
    });
  }

  // ── Command Handlers ─────────────────────────────────────

  private registerCommands(): void {
    // ── /help ──
    // Commands must NOT be wrapped in backticks so Telegram makes them clickable
    this.bot.command("help", async (ctx) => {
      const text = [
        "\u{1F916} vClaw Agent",
        "",
        "\u26A1 Quick Actions",
        "  /status — Cluster overview",
        "  /vms — List VMs with action buttons",
        "  /vm — VM detail (/vm 101)",
        "  /nodes — Node details",
        "  /storage — Storage pools",
        "  /start — Start a VM (/start 101)",
        "  /stop — Stop a VM (/stop 101)",
        "  /restart — Restart a VM (/restart 101)",
        "  /snap — Take snapshot (/snap 101)",
        "",
        "\u{1F9E0} Agent",
        "  /build — Run an infrastructure goal",
        "  /investigate — Root cause analysis",
        "  /audit — Recent audit trail",
        "  /governance — Governance status",
        "  /incidents — Open & recent incidents",
        "",
        "\u{1F3AF} Chaos Engineering",
        "  /chaos — Available scenarios & help",
        "  /chaos simulate <scenario> [target]",
        "  /chaos run <scenario> [target]",
        "  /chaos status — Active chaos run",
        "  /chaos history — Recent runs",
        "",
        "Or just type in plain English:",
        '  "list all my vms"',
        '  "create a VM called webserver with 4 cores"',
        '  "why is my cluster using so much RAM?"',
      ].join("\n");

      await ctx.reply(text);
    });

    // ── /status ──
    this.bot.command("status", async (ctx) => {
      try {
        const state = await this.toolRegistry.getClusterState();
        if (!state) {
          await ctx.reply("No cluster connection available.");
          return;
        }
        await safeSend(
          ctx,
          formatStatusMessage(state.nodes, state.vms, state.containers, state.storage),
        );
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // ── /vms ──
    this.bot.command("vms", async (ctx) => {
      try {
        const state = await this.toolRegistry.getClusterState();
        if (!state) {
          await ctx.reply("No cluster connection available.");
          return;
        }

        if (state.vms.length === 0) {
          await ctx.reply("No VMs found.");
          return;
        }

        // Send VM list
        await safeSend(ctx, formatVMListMessage(state.vms));

        // Send action buttons for each VM
        for (const vm of state.vms) {
          const kb = vmActionsKeyboard(Number(vm.id), vm.status);
          const icon = statusEmoji(vm.status);
          await safeSendWithKeyboard(
            ctx,
            `${icon} ${md2Bold(vm.name)} \\(${md2Code(String(vm.id))}\\)`,
            kb,
          );
        }
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // ── /vm <vmid> ──
    this.bot.command("vm", async (ctx) => {
      const vmid = parseInt(ctx.match || "", 10);
      if (isNaN(vmid)) {
        await ctx.reply("Usage: /vm <vmid>");
        return;
      }
      await this.sendVMDetail(ctx, vmid);
    });

    // ── /nodes ──
    this.bot.command("nodes", async (ctx) => {
      try {
        const state = await this.toolRegistry.getClusterState();
        if (!state) {
          await ctx.reply("No cluster connection available.");
          return;
        }
        await safeSend(ctx, formatNodeListMessage(state.nodes));
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // ── /storage ──
    this.bot.command("storage", async (ctx) => {
      try {
        const state = await this.toolRegistry.getClusterState();
        if (!state) {
          await ctx.reply("No cluster connection available.");
          return;
        }
        await safeSend(ctx, formatStorageMessage(state.storage));
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // ── /start <vmid> ──
    this.bot.command("start", async (ctx) => {
      const vmid = parseInt(ctx.match || "", 10);
      if (isNaN(vmid)) {
        await ctx.reply("Usage: /start <vmid>");
        return;
      }
      const vm = await this.findVM(vmid);
      await safeSendWithKeyboard(
        ctx,
        `Start ${md2Bold(vm?.name || "VM " + vmid)}?`,
        confirmKeyboard("start", vmid, vm?.name),
      );
    });

    // ── /stop <vmid> ──
    this.bot.command("stop", async (ctx) => {
      const vmid = parseInt(ctx.match || "", 10);
      if (isNaN(vmid)) {
        await ctx.reply("Usage: /stop <vmid>");
        return;
      }
      const vm = await this.findVM(vmid);
      await safeSendWithKeyboard(
        ctx,
        `Stop ${md2Bold(vm?.name || "VM " + vmid)}?`,
        confirmKeyboard("stop", vmid, vm?.name),
      );
    });

    // ── /restart <vmid> ──
    this.bot.command("restart", async (ctx) => {
      const vmid = parseInt(ctx.match || "", 10);
      if (isNaN(vmid)) {
        await ctx.reply("Usage: /restart <vmid>");
        return;
      }
      const vm = await this.findVM(vmid);
      await safeSendWithKeyboard(
        ctx,
        `Restart ${md2Bold(vm?.name || "VM " + vmid)}?`,
        confirmKeyboard("restart", vmid, vm?.name),
      );
    });

    // ── /snap <vmid> ──
    this.bot.command("snap", async (ctx) => {
      const vmid = parseInt(ctx.match || "", 10);
      if (isNaN(vmid)) {
        await ctx.reply("Usage: /snap <vmid>");
        return;
      }
      const vm = await this.findVM(vmid);
      await safeSendWithKeyboard(
        ctx,
        `Take snapshot of ${md2Bold(vm?.name || "VM " + vmid)}?`,
        confirmKeyboard("snapshot", vmid, vm?.name),
      );
    });

    // ── /build <goal> ──
    this.bot.command("build", async (ctx) => {
      const description = ctx.match;
      if (!description) {
        await ctx.reply("Usage: /build <description of what to build>");
        return;
      }
      await this.handleGoal(ctx, description.trim(), "build");
    });

    // ── /investigate <trigger> ──
    this.bot.command("investigate", async (ctx) => {
      const trigger = ctx.match;
      if (!trigger) {
        await ctx.reply("Usage: /investigate <description of the issue>");
        return;
      }
      await this.handleInvestigation(ctx, trigger.trim());
    });

    // ── /audit ──
    this.bot.command("audit", async (ctx) => {
      try {
        const events = this.eventBus.getHistory(15);
        if (events.length === 0) {
          await ctx.reply("No recent events.");
          return;
        }

        const lines = [`\u{1F4DC} ${md2Bold("Recent Events")}`, ""];
        for (const event of events) {
          const time = event.timestamp.slice(11, 19);
          const icon =
            event.type.includes("completed") || event.type.includes("approved")
              ? "\u2705"
              : event.type.includes("failed") || event.type.includes("tripped")
                ? "\u274C"
                : event.type.includes("started") || event.type.includes("created")
                  ? "\u{1F535}"
                  : "\u26AA";
          lines.push(`${icon} ${md2Code(time)} ${escMd2(event.type.replace(/_/g, " "))}`);
        }

        await safeSend(ctx, lines.join("\n"));
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // ── /governance ──
    this.bot.command("governance", async (ctx) => {
      try {
        const cbState = this.governanceEngine?.getCircuitBreakerState();
        const cbIcon = cbState?.tripped ? "\u{1F534}" : "\u{1F7E2}";
        const cbLabel = cbState?.tripped ? "TRIPPED" : "Closed";

        const lines = [
          `\u{1F6E1} ${md2Bold("Governance Status")}`,
          "",
          `${cbIcon} ${md2Bold("Circuit Breaker:")} ${md2Code(cbLabel)}`,
        ];

        if (cbState) {
          lines.push(
            `   Consecutive failures: ${escMd2(String(cbState.consecutive_failures))}`,
          );
          if (cbState.last_failure_at) {
            lines.push(
              `   Last failure: ${md2Code(cbState.last_failure_at.slice(11, 19))}`,
            );
          }
        }

        if (this.pendingApprovals.size > 0) {
          lines.push("");
          lines.push(
            `\u{1F6A8} ${md2Bold("Pending Approvals:")} ${escMd2(String(this.pendingApprovals.size))}`,
          );
        }

        await safeSend(ctx, lines.join("\n"));
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // ── /incidents ──
    this.bot.command("incidents", async (ctx) => {
      try {
        const history = this.eventBus.getHistory();

        // Collect open and recent incidents from event history
        const incidentMap = new Map<string, {
          id: string;
          description: string;
          severity: string;
          status: string;
          metric: string;
          detected_at: string;
          resolved_at?: string;
        }>();

        for (const event of history) {
          const d = event.data as Record<string, unknown>;
          const incidentId = d.incident_id as string | undefined;
          if (!incidentId) continue;

          if (event.type === "incident_opened") {
            incidentMap.set(incidentId, {
              id: incidentId,
              description: (d.description as string) || "Unknown",
              severity: (d.severity as string) || "unknown",
              status: "open",
              metric: (d.metric as string) || "",
              detected_at: event.timestamp,
            });
          } else if (event.type === "healing_started") {
            const existing = incidentMap.get(incidentId);
            if (existing) existing.status = "healing";
          } else if (event.type === "healing_completed" || event.type === "incident_resolved") {
            const existing = incidentMap.get(incidentId);
            if (existing) {
              existing.status = "resolved";
              existing.resolved_at = event.timestamp;
            }
          } else if (event.type === "healing_failed" || event.type === "incident_failed") {
            const existing = incidentMap.get(incidentId);
            if (existing) existing.status = "failed";
          }
        }

        const incidents = Array.from(incidentMap.values()).sort(
          (a, b) => new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime(),
        );

        if (incidents.length === 0) {
          await ctx.reply("No incidents recorded.");
          return;
        }

        const openIncidents = incidents.filter((i) => i.status === "open" || i.status === "healing");
        const recentResolved = incidents
          .filter((i) => i.status === "resolved" || i.status === "failed")
          .slice(0, 5);

        const lines: string[] = [];

        if (openIncidents.length > 0) {
          lines.push(`\u{1F534} ${md2Bold("Open Incidents")} \\(${escMd2(String(openIncidents.length))}\\)`);
          lines.push("");
          for (const inc of openIncidents) {
            const sevIcon = inc.severity === "critical" ? "\u{1F6A8}" : "\u26A0\uFE0F";
            const time = inc.detected_at.slice(11, 19);
            lines.push(`${sevIcon} ${md2Bold(escMd2(inc.description.slice(0, 60)))}`);
            lines.push(`   Severity: ${md2Code(inc.severity.toUpperCase())} \\| Status: ${md2Code(inc.status)} \\| ${md2Code(time)}`);
            if (inc.metric) lines.push(`   Metric: ${md2Code(inc.metric)}`);
            lines.push("");
          }
        } else {
          lines.push(`\u{1F7E2} ${md2Bold("No open incidents")}`);
          lines.push("");
        }

        if (recentResolved.length > 0) {
          lines.push(`\u{1F4CB} ${md2Bold("Recent Resolved")}`);
          lines.push("");
          for (const inc of recentResolved) {
            const icon = inc.status === "resolved" ? "\u2705" : "\u274C";
            const time = inc.detected_at.slice(11, 19);
            lines.push(`${icon} ${escMd2(inc.description.slice(0, 60))}`);
            lines.push(`   ${md2Code(inc.severity.toUpperCase())} \\| ${md2Code(inc.status)} \\| ${md2Code(time)}`);
            lines.push("");
          }
        }

        await safeSend(ctx, lines.join("\n"));
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // ── /chaos ──
    this.bot.command("chaos", async (ctx) => {
      const args = (ctx.match as string || "").trim().split(/\s+/).filter(Boolean);
      const subcommand = args[0]?.toLowerCase() || "";

      if (!this.chaosEngine) {
        await ctx.reply("Chaos engine is not available. Start vClaw in full or dev mode.");
        return;
      }

      try {
        switch (subcommand) {
          case "simulate": {
            const scenarioId = args[1];
            const target = args[2];
            if (!scenarioId) {
              await ctx.reply("Usage: /chaos simulate &lt;scenario&gt; [target]\n\nExample: /chaos simulate vm_kill 104", { parse_mode: "HTML" });
              return;
            }

            await ctx.reply("\u{1F52C} Simulating blast radius...");
            const params = this.buildChaosParams(scenarioId, target);
            const run = await this.chaosEngine.simulate(scenarioId, params);
            const lines = this.formatChaosSimulation(run);
            lines.push("");
            lines.push(`Run this test? Reply:\n/chaos run ${scenarioId}${target ? " " + target : ""}`);
            await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
            break;
          }

          case "run": {
            const scenarioId = args[1];
            const target = args[2];
            if (!scenarioId) {
              await ctx.reply("Usage: /chaos run &lt;scenario&gt; [target]\n\nExample: /chaos run vm_kill 104", { parse_mode: "HTML" });
              return;
            }

            // Show blast radius first and ask for approval
            const params = this.buildChaosParams(scenarioId, target);
            const simRun = await this.chaosEngine.simulate(scenarioId, params);
            const blastLines = this.formatChaosSimulation(simRun);
            blastLines.push("");
            blastLines.push("\u26A0\uFE0F <b>This will actually stop VM(s). Approve?</b>");

            const keyboard = new InlineKeyboard()
              .text("\u2705 Approve", `chaos_approve:${scenarioId}:${target || ""}`)
              .text("\u274C Cancel", "chaos_cancel");

            await ctx.reply(blastLines.join("\n"), {
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
            break;
          }

          case "status": {
            const activeRun = this.chaosEngine.getActiveRun();
            if (!activeRun) {
              await ctx.reply("No active chaos run.");
              return;
            }

            const elapsed = Math.round(
              (Date.now() - new Date(activeRun.started_at).getTime()) / 1000,
            );
            const lines = [
              "\u{1F3AF} <b>Active Chaos Run</b>",
              "",
              `Scenario: <b>${this.escHtml(activeRun.scenario.name)}</b>`,
              `Status: <code>${activeRun.status}</code>`,
              `Elapsed: ${elapsed}s / ${activeRun.simulation.predicted_recovery_time_s}s predicted`,
              `Affected VMs: ${activeRun.simulation.blast_radius.total_affected}`,
              `Risk Score: ${activeRun.simulation.risk_score}/100`,
            ];

            await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
            break;
          }

          case "history": {
            const history = this.chaosEngine.getHistory().slice(0, 5);
            if (history.length === 0) {
              await ctx.reply("No chaos runs recorded yet.");
              return;
            }

            const lines = ["\u{1F4CB} <b>Chaos Run History</b>", ""];

            for (const run of history) {
              const verdict = run.score?.verdict;
              const verdictIcon =
                verdict === "pass" ? "\u2705" : verdict === "fail" ? "\u274C" : "\u26A0\uFE0F";
              const time = run.started_at.slice(11, 19);
              lines.push(
                `${verdictIcon} <b>${this.escHtml(run.scenario.name)}</b>`,
              );
              lines.push(
                `   ${time} | Resilience: ${run.score?.resilience_pct ?? "?"}% | ` +
                  `${run.actual?.recovery_time_s ?? "?"}s / ${run.simulation.predicted_recovery_time_s}s | ` +
                  `<code>${(run.score?.verdict ?? run.status).toUpperCase()}</code>`,
              );
              lines.push("");
            }

            await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
            break;
          }

          default: {
            // Show help / available scenarios
            const scenarios = this.chaosEngine.listScenarios();
            const lines = [
              "\u{1F3AF} <b>Chaos Engineering</b>",
              "",
              "<b>Available scenarios:</b>",
            ];

            for (const s of scenarios) {
              lines.push(`  \u2022 <code>${s.id}</code> \u2014 ${this.escHtml(s.description.split(".")[0])}`);
            }

            lines.push("");
            lines.push("<b>Usage:</b>");
            lines.push("  /chaos simulate vm_kill 104");
            lines.push("  /chaos run vm_kill 104");
            lines.push("  /chaos status");
            lines.push("  /chaos history");

            await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
            break;
          }
        }
      } catch (err) {
        await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  // ── Chaos Helpers ──────────────────────────────────────

  /**
   * Convert a target string (vmid or node name) into the params object
   * expected by the ChaosEngine API.
   */
  private buildChaosParams(
    scenarioId: string,
    target?: string,
  ): Record<string, unknown> | undefined {
    if (!target) return undefined;

    switch (scenarioId) {
      case "vm_kill":
        return { vmid: parseInt(target, 10) };
      case "node_drain":
        return { node: target };
      case "multi_vm_kill":
        return { count: parseInt(target, 10) || 2 };
      default:
        // For random_vm_kill and others, target is optional
        return target ? { vmid: parseInt(target, 10) } : undefined;
    }
  }

  private formatChaosSimulation(run: ChaosRun): string[] {
    const sim = run.simulation;
    const br = sim.blast_radius;

    const lines = [
      "\u{1F4A5} <b>Blast Radius Analysis</b>",
      "",
      `Scenario: <b>${this.escHtml(run.scenario.name)}</b>`,
      `Severity: <code>${run.scenario.severity.toUpperCase()}</code>`,
      `Risk Score: <b>${sim.risk_score}/100</b>`,
      `Predicted Recovery: <b>${sim.predicted_recovery_time_s}s</b>`,
      "",
    ];

    const affected = br.affected_vms.filter((v) => v.will_be_affected);
    if (affected.length > 0) {
      lines.push(`<b>Affected VMs (${affected.length}):</b>`);
      for (const vm of affected) {
        const statusIcon = vm.status === "running" ? "\u{1F7E2}" : "\u{1F534}";
        lines.push(`  ${statusIcon} ${this.escHtml(vm.name)} (${vm.vmid}) on ${this.escHtml(vm.node)}`);
      }
    } else {
      lines.push("No VMs directly affected.");
    }

    if (br.critical_services_affected > 0) {
      lines.push("");
      lines.push(`\u26A0\uFE0F <b>Critical services affected:</b> ${br.critical_services_affected}`);
    }

    if (sim.recommendation) {
      lines.push("");
      lines.push(`\u{1F4AC} ${this.escHtml(sim.recommendation)}`);
    }

    return lines;
  }

  // ── Callback Query Handlers ─────────────────────────────

  private registerCallbackQueries(): void {
    // ── VM quick actions from /vms list ──
    this.bot.callbackQuery(/^vm_start:(\d+)$/, async (ctx) => {
      const vmid = parseInt(ctx.match![1], 10);
      const vm = await this.findVM(vmid);
      await ctx.answerCallbackQuery();
      await safeSendWithKeyboard(
        ctx,
        `Start ${md2Bold(vm?.name || "VM " + vmid)}?`,
        confirmKeyboard("start", vmid, vm?.name),
      );
    });

    this.bot.callbackQuery(/^vm_stop:(\d+)$/, async (ctx) => {
      const vmid = parseInt(ctx.match![1], 10);
      const vm = await this.findVM(vmid);
      await ctx.answerCallbackQuery();
      await safeSendWithKeyboard(
        ctx,
        `Stop ${md2Bold(vm?.name || "VM " + vmid)}?`,
        confirmKeyboard("stop", vmid, vm?.name),
      );
    });

    this.bot.callbackQuery(/^vm_restart:(\d+)$/, async (ctx) => {
      const vmid = parseInt(ctx.match![1], 10);
      const vm = await this.findVM(vmid);
      await ctx.answerCallbackQuery();
      await safeSendWithKeyboard(
        ctx,
        `Restart ${md2Bold(vm?.name || "VM " + vmid)}?`,
        confirmKeyboard("restart", vmid, vm?.name),
      );
    });

    this.bot.callbackQuery(/^vm_snap:(\d+)$/, async (ctx) => {
      const vmid = parseInt(ctx.match![1], 10);
      const vm = await this.findVM(vmid);
      await ctx.answerCallbackQuery();
      await safeSendWithKeyboard(
        ctx,
        `Snapshot ${md2Bold(vm?.name || "VM " + vmid)}?`,
        confirmKeyboard("snapshot", vmid, vm?.name),
      );
    });

    this.bot.callbackQuery(/^vm_detail:(\d+)$/, async (ctx) => {
      const vmid = parseInt(ctx.match![1], 10);
      await ctx.answerCallbackQuery();
      await this.sendVMDetail(ctx, vmid);
    });

    // ── Confirmed actions ──
    this.bot.callbackQuery(/^confirm:(\w+):(\d+)$/, async (ctx) => {
      const action = ctx.match![1];
      const vmid = parseInt(ctx.match![2], 10);
      await ctx.answerCallbackQuery({ text: `${action}ing...` });

      try {
        const vm = await this.findVM(vmid);
        const node = vm?.node || await this.getFirstNode();

        let result: { success: boolean; data?: unknown; error?: string };

        switch (action) {
          case "start":
            result = await this.toolRegistry.execute("start_vm", { node, vmid });
            break;
          case "stop":
            result = await this.toolRegistry.execute("stop_vm", { node, vmid });
            break;
          case "restart":
            result = await this.toolRegistry.execute("restart_vm", { node, vmid });
            break;
          case "snapshot":
            const snapName = `tg-snap-${Date.now()}`;
            result = await this.toolRegistry.execute("create_snapshot", {
              node,
              vmid,
              snapname: snapName,
              description: "Created via Telegram",
            });
            break;
          default:
            result = { success: false, error: `Unknown action: ${action}` };
        }

        if (result.success) {
          const icon = action === "stop" ? "\u23F9" : action === "restart" ? "\u{1F504}" : action === "snapshot" ? "\u{1F4F7}" : "\u25B6";
          await ctx.editMessageText(
            `${icon} ${action.charAt(0).toUpperCase() + action.slice(1)} — ${vm?.name || "VM " + vmid}: Success!`,
          );
        } else {
          await ctx.editMessageText(`\u274C Failed: ${result.error || "Unknown error"}`);
        }
      } catch (err) {
        await ctx.editMessageText(
          `\u274C Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.bot.callbackQuery("cancel_action", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await ctx.editMessageText("Action cancelled.");
    });

    // ── Plan-level approval ──
    this.bot.callbackQuery(/^plan_approve:(.+)$/, async (ctx) => {
      const id = ctx.match![1];
      const pending = this.pendingApprovals.get(id);

      if (!pending) {
        await ctx.answerCallbackQuery({ text: "No longer pending." });
        return;
      }

      pending.resolveApproval(true);
      this.pendingApprovals.delete(id);

      await ctx.answerCallbackQuery({ text: "Plan approved!" });
      await ctx.editMessageText(
        `\u2705 Plan ${id} — APPROVED\n\nExecuting steps...`,
      );
    });

    this.bot.callbackQuery(/^plan_deny:(.+)$/, async (ctx) => {
      const id = ctx.match![1];
      const pending = this.pendingApprovals.get(id);

      if (!pending) {
        await ctx.answerCallbackQuery({ text: "No longer pending." });
        return;
      }

      pending.resolveApproval(false);
      this.pendingApprovals.delete(id);

      await ctx.answerCallbackQuery({ text: "Plan denied." });
      await ctx.editMessageText(
        `\u274C Plan ${id} — DENIED`,
      );
    });

    // ── Step-level approval (for destructive actions) ──
    this.bot.callbackQuery(/^(?:approve|gov_approve):(.+)$/, async (ctx) => {
      const id = ctx.match![1];
      const pending = this.pendingApprovals.get(id);

      if (!pending) {
        await ctx.answerCallbackQuery({ text: "No longer pending." });
        return;
      }

      pending.resolveApproval(true);
      this.pendingApprovals.delete(id);

      await ctx.answerCallbackQuery({ text: "Approved!" });
      await ctx.editMessageText(
        `\u2705 ${id} — APPROVED`,
      );
    });

    this.bot.callbackQuery(/^(?:deny|gov_deny):(.+)$/, async (ctx) => {
      const id = ctx.match![1];
      const pending = this.pendingApprovals.get(id);

      if (!pending) {
        await ctx.answerCallbackQuery({ text: "No longer pending." });
        return;
      }

      pending.resolveApproval(false);
      this.pendingApprovals.delete(id);

      await ctx.answerCallbackQuery({ text: "Denied." });
      await ctx.editMessageText(
        `\u274C ${id} — DENIED`,
      );
    });

    // ── Chaos approval ──
    this.bot.callbackQuery(/^chaos_approve:([^:]+):(.*)$/, async (ctx) => {
      const scenarioId = ctx.match![1];
      const target = ctx.match![2] || undefined;

      await ctx.answerCallbackQuery({ text: "Executing chaos test..." });
      await ctx.editMessageText("\u{1F3AF} Chaos test approved. Executing...");

      if (!this.chaosEngine) {
        await ctx.reply("Chaos engine is not available.");
        return;
      }

      const chatId = ctx.chat?.id;
      if (!chatId) return;

      // Execute in the background so the bot stays responsive
      const params = this.buildChaosParams(scenarioId, target);
      this.chaosEngine.execute(scenarioId, params).then(async (run) => {
        const verdict = run.score?.verdict ?? "unknown";
        const verdictIcon = verdict === "pass" ? "\u2705" : verdict === "fail" ? "\u274C" : "\u26A0\uFE0F";
        const lines = [
          `${verdictIcon} <b>Chaos Test Complete</b>`,
          "",
          `Scenario: <b>${this.escHtml(run.scenario.name)}</b>`,
          `Verdict: <code>${verdict.toUpperCase()}</code>`,
          `Resilience: <b>${run.score?.resilience_pct ?? "?"}%</b>`,
          "",
          `<b>Predicted vs Actual:</b>`,
          `  Recovery: ${run.simulation.predicted_recovery_time_s}s predicted / ${run.actual?.recovery_time_s ?? "?"}s actual`,
          `  ${this.escHtml(run.score?.predicted_vs_actual_recovery ?? "")}`,
          "",
          `VMs Recovered: ${run.actual?.all_recovered ? "All" : "Partial"}`,
          `Incidents Created: ${run.actual?.incidents_created.length ?? 0}`,
        ];

        await this.bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
      }).catch(async (err) => {
        await this.bot.api.sendMessage(
          chatId,
          `\u274C Chaos test failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    this.bot.callbackQuery("chaos_cancel", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await ctx.editMessageText("Chaos test cancelled.");
    });
  }

  // ── Natural Language Handler ──────────────────────────────

  private registerTextHandler(): void {
    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return;

      // Use the full agent loop for natural language — this is vClaw's
      // superpower vs homelab-mcp's simple intent parsing
      await this.handleGoal(ctx, text, "build");
    });
  }

  // ── Goal Execution ────────────────────────────────────────

  private async handleGoal(
    ctx: Context,
    description: string,
    mode: AgentMode,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const goal: Goal = {
      id: randomUUID(),
      mode,
      description,
      raw_input: description,
      created_at: new Date().toISOString(),
    };

    const statusMsg = await ctx.reply(
      `\u{1F9E0} Working on: ${description}\n\n\u23F3 Planning...`,
    );

    this.progressMessages.set(goal.id, {
      chatId,
      messageId: statusMsg.message_id,
    });

    // Run the agent in the background so grammY stays free to process
    // callback queries (approval buttons, etc.) while the agent executes.
    this.agentCore.run(goal).then(async (result) => {
      this.progressMessages.delete(goal.id);

      // Show step outputs with smart formatting
      if (result.outputs.length > 0) {
        for (const output of result.outputs) {
          if (output.success && output.data !== undefined) {
            try {
              const formatted = formatOutputData(output.action, output.data);
              // Split into chunks if too long (Telegram 4096 char limit)
              if (formatted.length > 4000) {
                const chunks = formatted.match(/[\s\S]{1,3900}/g) || [formatted];
                for (const chunk of chunks) {
                  await this.bot.api.sendMessage(chatId, chunk);
                }
              } else {
                await this.bot.api.sendMessage(chatId, formatted);
              }
            } catch {
              await this.bot.api.sendMessage(chatId, `${output.action}: completed (output too large)`);
            }
          }
        }
      }

      // Summary — use plain text to avoid MarkdownV2 issues
      const summaryIcon = result.success ? "\u2705" : "\u274C";
      const summaryLabel = result.success ? "Done" : "Failed";
      let summary = `${summaryIcon} ${summaryLabel}\n\n${result.steps_completed} steps | ${result.replans} replans | ${result.duration_ms}ms`;

      if (result.errors.length > 0) {
        summary += "\n";
        for (const err of result.errors.slice(0, 3)) {
          summary += `\n\u274C ${err.slice(0, 100)}`;
        }
      }

      if (result.plan.steps.length > 1) {
        summary += "\n\nSteps:";
        for (const step of result.plan.steps) {
          const sIcon = stepStatusIcon(step.status);
          summary += `\n${sIcon} ${step.action} — ${step.description.slice(0, 60)}`;
        }
      }

      await this.bot.api.sendMessage(chatId, summary);
    }).catch(async (err) => {
      this.progressMessages.delete(goal.id);
      await this.bot.api.sendMessage(
        chatId,
        `\u274C Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // ── Investigation ─────────────────────────────────────────

  private async handleInvestigation(
    ctx: Context,
    trigger: string,
  ): Promise<void> {
    await ctx.reply(`\u{1F50D} Investigating: ${trigger}\n\n\u23F3 Please wait...`);

    try {
      const investigation = await this.agentCore.investigate(trigger);

      const lines = [
        `\u{1F50D} ${md2Bold("Investigation Report")}`,
        "",
      ];

      for (const finding of investigation.findings) {
        const icon =
          finding.severity === "critical"
            ? "\u{1F534}"
            : finding.severity === "warning"
              ? "\u{1F7E1}"
              : "\u{1F535}";
        lines.push(`${icon} ${md2Bold(finding.source)}`);
        lines.push(`   ${escMd2(finding.detail.slice(0, 150))}`);
        lines.push("");
      }

      lines.push(
        `${md2Bold("Root Cause:")} ${escMd2(investigation.root_cause)}`,
      );

      if (investigation.proposed_fix) {
        lines.push("");
        lines.push(`${md2Bold("Fix:")} ${escMd2(investigation.proposed_fix.description)}`);
        lines.push(
          `Confidence: ${escMd2(investigation.proposed_fix.confidence)} \\| ${escMd2(String(investigation.proposed_fix.steps.length))} steps`,
        );
      }

      await safeSend(ctx, lines.join("\n"));
    } catch (err) {
      await ctx.reply(
        `\u274C Investigation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Helper: Find VM ────────────────────────────────────────

  private async findVM(vmid: number): Promise<VMInfo | undefined> {
    try {
      const state = await this.toolRegistry.getClusterState();
      return state?.vms.find((v) => Number(v.id) === vmid);
    } catch {
      return undefined;
    }
  }

  private async getFirstNode(): Promise<string> {
    try {
      const state = await this.toolRegistry.getClusterState();
      return state?.nodes[0]?.name || "pve";
    } catch {
      return "pve";
    }
  }

  private async sendVMDetail(ctx: Context, vmid: number): Promise<void> {
    try {
      const vm = await this.findVM(vmid);
      if (!vm) {
        await ctx.reply(`VM ${vmid} not found.`);
        return;
      }
      const kb = vmActionsKeyboard(vmid, vm.status);
      await safeSendWithKeyboard(ctx, formatVMDetail(vm), kb);
    } catch (err) {
      await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Plan Approval ──────────────────────────────────────────

  private async requestApproval(
    chatId: number,
    plan: Plan,
    goal: Goal,
  ): Promise<boolean> {
    const keyboard = new InlineKeyboard()
      .text("\u2705 Approve", `approve:${plan.id}`)
      .text("\u274C Deny", `deny:${plan.id}`);

    const text = formatPlanMessage(plan) +
      "\n\n\u{1F6A8} " + md2Bold("Approval Required");

    let message;
    try {
      message = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
      });
    } catch {
      message = await this.bot.api.sendMessage(
        chatId,
        `Plan ${plan.id.slice(0, 8)} needs approval (${plan.steps.length} steps)`,
        { reply_markup: keyboard },
      );
    }

    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(plan.id, {
        planId: plan.id,
        plan,
        chatId,
        messageId: message.message_id,
        goal,
        resolveApproval: resolve,
      });
    });
  }

  // ── Event Bus Subscriptions ───────────────────────────────

  private subscribeToEvents(): void {
    this.eventBus.on("plan_created", async (event: AgentEvent) => {
      const data = event.data as {
        plan_id: string;
        goal: string;
        step_count: number;
      };

      for (const [, info] of this.progressMessages) {
        try {
          await this.bot.api.editMessageText(
            info.chatId,
            info.messageId,
            `\u{1F4CB} Plan created (${data.step_count} steps)\n\u23F3 Executing...`,
          );
        } catch {
          // Message edit can fail
        }
      }
    });

    this.bot.catch((err) => {
      console.error("[telegram] Bot error:", err);
    });

    this.eventBus.on("step_completed", async (event: AgentEvent) => {
      const data = event.data as {
        step_id: string;
        action: string;
        duration_ms: number;
      };

      for (const [, info] of this.progressMessages) {
        try {
          await this.bot.api.editMessageText(
            info.chatId,
            info.messageId,
            `\u2705 ${data.action} (${data.duration_ms}ms)\n\u23F3 Continuing...`,
          );
        } catch {}
      }
    });

    this.eventBus.on("step_failed", async (event: AgentEvent) => {
      const data = event.data as {
        step_id: string;
        action: string;
        error: string;
      };

      for (const [, info] of this.progressMessages) {
        try {
          await this.bot.api.editMessageText(
            info.chatId,
            info.messageId,
            `\u274C ${data.action} failed: ${(data.error || "").slice(0, 100)}`,
          );
        } catch {}
      }
    });

    this.eventBus.on("alert_fired", async (event: AgentEvent) => {
      const data = event.data as {
        severity: string;
        message: string;
        source: string;
      };

      const icon =
        data.severity === "critical"
          ? "\u{1F6A8}"
          : data.severity === "warning"
            ? "\u26A0\uFE0F"
            : "\u2139\uFE0F";

      const text = `${icon} Alert\n\nSeverity: ${(data.severity || "").toUpperCase()}\nSource: ${data.source || "unknown"}\n${data.message || ""}`;

      for (const userId of this.allowedUsers) {
        try {
          await this.bot.api.sendMessage(userId, text);
        } catch {}
      }
    });

    this.eventBus.on("circuit_breaker_tripped", async () => {
      const text =
        "\u{1F6A8} CIRCUIT BREAKER TRIPPED\n\nExecution halted due to consecutive failures. Manual intervention required.";

      for (const userId of this.allowedUsers) {
        try {
          await this.bot.api.sendMessage(userId, text);
        } catch {}
      }
    });

    // ── Healing & Incident Notifications ──────────────────

    this.eventBus.on("incident_opened", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) {
        console.warn("[telegram] No active chat for incident notification — skipping");
        return;
      }
      try {
        const d = event.data as Record<string, unknown>;
        const description = (d.description as string) || "Unknown anomaly";
        const severity = ((d.severity as string) || "unknown").toUpperCase();
        const metric = (d.metric as string) || "";
        const ts = event.timestamp.slice(11, 19);

        const text = [
          `<b>\ud83d\udd34 Incident Opened</b>`,
          ``,
          `${this.escHtml(description)}`,
          `Severity: <b>${this.escHtml(severity)}</b>`,
          metric ? `Metric: <code>${this.escHtml(metric)}</code>` : "",
          ``,
          `<i>${ts}</i>`,
        ].filter(Boolean).join("\n");

        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send incident_opened notification:", err);
      }
    });

    this.eventBus.on("healing_started", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) {
        console.warn("[telegram] No active chat for healing notification — skipping");
        return;
      }
      try {
        const d = event.data as Record<string, unknown>;
        const playbookId = (d.playbook_id as string) || "unknown";
        const description = (d.description as string) || "";
        const ts = event.timestamp.slice(11, 19);

        const text = [
          `<b>\ud83d\udd27 Self-Healing Started</b>`,
          ``,
          `Playbook: <code>${this.escHtml(playbookId)}</code>`,
          description ? `Goal: ${this.escHtml(description)}` : "",
          ``,
          `<i>${ts}</i>`,
        ].filter(Boolean).join("\n");

        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send healing_started notification:", err);
      }
    });

    this.eventBus.on("healing_completed", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) {
        console.warn("[telegram] No active chat for healing notification — skipping");
        return;
      }
      try {
        const d = event.data as Record<string, unknown>;
        const playbookId = (d.playbook_id as string) || "unknown";
        const stepsCompleted = d.steps_completed ?? "?";
        const durationMs = d.duration_ms as number | undefined;
        const durationStr = durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : "?";
        const ts = event.timestamp.slice(11, 19);

        const text = [
          `<b>\u2705 Healing Complete</b>`,
          ``,
          `Playbook: <code>${this.escHtml(playbookId)}</code>`,
          `${stepsCompleted} steps completed in ${durationStr}`,
          `Incident resolved`,
          ``,
          `<i>${ts}</i>`,
        ].join("\n");

        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send healing_completed notification:", err);
      }
    });

    this.eventBus.on("healing_failed", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) {
        console.warn("[telegram] No active chat for healing notification — skipping");
        return;
      }
      try {
        const d = event.data as Record<string, unknown>;
        const playbookId = (d.playbook_id as string) || "unknown";
        const errors = d.errors;
        const errStr = Array.isArray(errors)
          ? errors.map((e) => String(e)).join(", ")
          : errors
            ? String(errors)
            : "Unknown error";
        const ts = event.timestamp.slice(11, 19);

        const text = [
          `<b>\u274c Healing Failed</b>`,
          ``,
          `Playbook: <code>${this.escHtml(playbookId)}</code>`,
          `Errors: ${this.escHtml(errStr.slice(0, 300))}`,
          ``,
          `<i>${ts}</i>`,
        ].join("\n");

        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send healing_failed notification:", err);
      }
    });

    this.eventBus.on("healing_escalated", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) {
        console.warn("[telegram] No active chat for healing notification — skipping");
        return;
      }
      try {
        const d = event.data as Record<string, unknown>;
        const reason = (d.reason as string) || "Unknown reason";
        const ts = event.timestamp.slice(11, 19);

        const text = [
          `<b>\u26a0\ufe0f Escalated to Operator</b>`,
          ``,
          `Reason: ${this.escHtml(reason)}`,
          ``,
          `<i>${ts}</i>`,
        ].join("\n");

        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send healing_escalated notification:", err);
      }
    });

    this.eventBus.on("healing_paused", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) {
        console.warn("[telegram] No active chat for healing notification — skipping");
        return;
      }
      try {
        const d = event.data as Record<string, unknown>;
        const reason = (d.reason as string) || "Unknown reason";
        const consecutiveFailures = d.consecutive_failures ?? "?";
        const ts = event.timestamp.slice(11, 19);

        const text = [
          `<b>\ud83d\uded1 Self-Healing Paused</b>`,
          ``,
          `Circuit breaker tripped after ${consecutiveFailures} consecutive failures`,
          `Reason: ${this.escHtml(reason)}`,
          ``,
          `<i>${ts}</i>`,
        ].join("\n");

        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send healing_paused notification:", err);
      }
    });

    // ── Chaos Engineering Notifications ────────────────────

    this.eventBus.on("chaos_started", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) return;
      try {
        const d = event.data as Record<string, unknown>;
        const scenarioName = (d.scenario_name as string) || "Unknown";
        const totalAffected = d.total_affected ?? "?";
        const text = `\u{1F3AF} <b>Chaos test started:</b> ${this.escHtml(scenarioName)}\nAffected VMs: ${totalAffected}`;
        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send chaos_started notification:", err);
      }
    });

    this.eventBus.on("chaos_completed", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) return;
      try {
        const d = event.data as Record<string, unknown>;
        const verdict = (d.verdict as string) || "unknown";
        const resiliencePct = d.resilience_pct ?? "?";
        const verdictLabel = verdict.toUpperCase();
        const icon = verdict === "pass" ? "\u2705" : verdict === "fail" ? "\u274C" : "\u26A0\uFE0F";
        const text = `${icon} <b>Chaos test complete!</b> Resilience: ${resiliencePct}% \u2014 <code>${this.escHtml(verdictLabel)}</code>`;
        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send chaos_completed notification:", err);
      }
    });

    this.eventBus.on("chaos_failed", async (event: AgentEvent) => {
      const chatId = this.getChatId();
      if (!chatId) return;
      try {
        const d = event.data as Record<string, unknown>;
        const error = (d.error as string) || "Unknown error";
        const text = `\u274C <b>Chaos test failed:</b> ${this.escHtml(error)}`;
        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[telegram] Failed to send chaos_failed notification:", err);
      }
    });
  }
}
