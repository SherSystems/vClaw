// ============================================================
// vClaw — Autopilot Daemon
// Continuous monitoring loop that polls cluster state, runs
// health checks, detects issues, and triggers self-healing
// actions through the governance pipeline.
// ============================================================

import { randomUUID } from "node:crypto";
import { AgentEventType } from "../types.js";
import type {
  Alert,
  AlertSeverity,
  HealthCheck,
  AutopilotRule,
  ClusterState,
  VMInfo,
  NodeInfo,
  AgentEvent,
} from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { GovernanceEngine } from "../governance/index.js";
import type { EventBus } from "../agent/events.js";
import { DEFAULT_RULES, evaluateRules, type RuleMatch } from "./rules.js";

// ── Configuration ───────────────────────────────────────────

export interface AutopilotConfig {
  /** Polling interval in milliseconds. Default: 30000 (30s) */
  pollIntervalMs: number;
  /** Whether the daemon is enabled. Default: true */
  enabled: boolean;
}

const DEFAULT_CONFIG: AutopilotConfig = {
  pollIntervalMs: 30_000,
  enabled: true,
};

// ── Restart Tracking ────────────────────────────────────────

interface RestartRecord {
  vmid: string | number;
  lastAttempt: number;
  attempts: number;
}

// ── AutopilotDaemon Class ───────────────────────────────────

export class AutopilotDaemon {
  private toolRegistry: ToolRegistry;
  private governance: GovernanceEngine;
  private eventBus: EventBus;
  private config: AutopilotConfig;

  private rules: AutopilotRule[];
  private previousState: ClusterState | null = null;
  private alerts: Alert[] = [];
  private healthChecks: HealthCheck[] = [];
  private restartRecords: Map<string | number, RestartRecord> = new Map();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    toolRegistry: ToolRegistry,
    governance: GovernanceEngine,
    eventBus: EventBus,
    config?: Partial<AutopilotConfig>,
  ) {
    this.toolRegistry = toolRegistry;
    this.governance = governance;
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rules = DEFAULT_RULES.map((r) => ({ ...r }));
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Start the polling loop.
   */
  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      console.log("[autopilot] Daemon is disabled, not starting.");
      return;
    }

    this.running = true;
    console.log(
      `[autopilot] Starting daemon with ${this.config.pollIntervalMs}ms poll interval.`,
    );

    // Run first poll immediately
    void this.poll();

    // Schedule subsequent polls
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log("[autopilot] Daemon stopped.");
  }

  /**
   * Get all alerts (most recent first).
   */
  getAlerts(): Alert[] {
    return [...this.alerts].reverse();
  }

  /**
   * Get the most recent health check results.
   */
  getHealthChecks(): HealthCheck[] {
    return [...this.healthChecks];
  }

  // ── Core Poll Loop ────────────────────────────────────────

  private async poll(): Promise<void> {
    const now = new Date();

    let currentState: ClusterState | null;
    try {
      currentState = await this.toolRegistry.getClusterState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[autopilot] Failed to fetch cluster state: ${msg}`);
      this.fireAlert(
        "critical",
        "autopilot",
        `Failed to fetch cluster state: ${msg}`,
      );
      return;
    }

    if (!currentState) {
      console.warn("[autopilot] No cluster adapter connected, skipping poll.");
      return;
    }

    try {
      // Run health checks
      this.runHealthChecks(currentState, now);

      // Evaluate rules
      const matches = evaluateRules(
        this.rules,
        currentState,
        this.previousState,
        now,
      );

      // Process rule matches
      for (const match of matches) {
        await this.handleRuleMatch(match, now);
      }

      // Store state for next comparison
      this.previousState = currentState;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[autopilot] Poll execution failed: ${msg}`);
      this.fireAlert(
        "warning",
        "autopilot/poll",
        `Poll execution failed: ${msg}`,
      );
    }
  }

  // ── Health Checks ─────────────────────────────────────────

  private runHealthChecks(state: ClusterState, now: Date): void {
    const checks: HealthCheck[] = [];
    const timestamp = now.toISOString();

    // Check each node
    for (const node of state.nodes) {
      checks.push(this.checkNodeHealth(node, timestamp));
    }

    // Check each VM
    for (const vm of state.vms) {
      checks.push(this.checkVmHealth(vm, timestamp));
    }

    // Check storage
    for (const storage of state.storage) {
      const usedPct =
        storage.total_gb > 0
          ? (storage.used_gb / storage.total_gb) * 100
          : 0;

      let status: HealthCheck["status"] = "healthy";
      let message = `${usedPct.toFixed(1)}% used (${storage.available_gb.toFixed(1)} GB free)`;

      if (usedPct > 95) {
        status = "unhealthy";
        message = `CRITICAL: ${usedPct.toFixed(1)}% used — only ${storage.available_gb.toFixed(1)} GB free`;
      } else if (usedPct > 85) {
        status = "degraded";
        message = `WARNING: ${usedPct.toFixed(1)}% used — ${storage.available_gb.toFixed(1)} GB free`;
      }

      checks.push({
        target: `storage/${storage.id}@${storage.node}`,
        type: "resource_threshold",
        status,
        message,
        timestamp,
      });
    }

    this.healthChecks = checks;

    // Emit health check event
    const unhealthyCount = checks.filter((c) => c.status === "unhealthy").length;
    const degradedCount = checks.filter((c) => c.status === "degraded").length;

    this.eventBus.emit({
      type: AgentEventType.HealthCheck,
      timestamp,
      data: {
        total: checks.length,
        healthy: checks.filter((c) => c.status === "healthy").length,
        degraded: degradedCount,
        unhealthy: unhealthyCount,
      },
    });
  }

  private checkNodeHealth(node: NodeInfo, timestamp: string): HealthCheck {
    if (node.status === "offline") {
      return {
        target: `node/${node.name}`,
        type: "connectivity",
        status: "unhealthy",
        message: "Node is offline",
        timestamp,
      };
    }

    const ramPct =
      node.ram_total_mb > 0
        ? (node.ram_used_mb / node.ram_total_mb) * 100
        : 0;

    if (ramPct > 95) {
      return {
        target: `node/${node.name}`,
        type: "resource_threshold",
        status: "unhealthy",
        message: `RAM critically high at ${ramPct.toFixed(1)}%`,
        timestamp,
      };
    }

    if (ramPct > 90 || node.cpu_usage_pct > 90) {
      return {
        target: `node/${node.name}`,
        type: "resource_threshold",
        status: "degraded",
        message: `Resources elevated — RAM: ${ramPct.toFixed(1)}%, CPU: ${node.cpu_usage_pct.toFixed(1)}%`,
        timestamp,
      };
    }

    return {
      target: `node/${node.name}`,
      type: "resource_threshold",
      status: "healthy",
      message: `RAM: ${ramPct.toFixed(1)}%, CPU: ${node.cpu_usage_pct.toFixed(1)}%`,
      timestamp,
    };
  }

  private checkVmHealth(vm: VMInfo, timestamp: string): HealthCheck {
    if (vm.status === "unknown") {
      return {
        target: `vm/${vm.name} (${vm.id})`,
        type: "vm_status",
        status: "unhealthy",
        message: "VM status is unknown",
        timestamp,
      };
    }

    if (vm.status === "paused") {
      return {
        target: `vm/${vm.name} (${vm.id})`,
        type: "vm_status",
        status: "degraded",
        message: "VM is paused",
        timestamp,
      };
    }

    return {
      target: `vm/${vm.name} (${vm.id})`,
      type: "vm_status",
      status: "healthy",
      message: `VM is ${vm.status}`,
      timestamp,
    };
  }

  // ── Rule Match Handling ───────────────────────────────────

  private async handleRuleMatch(match: RuleMatch, now: Date): Promise<void> {
    const { rule, trigger, action, params } = match;

    console.log(`[autopilot] Rule "${rule.name}" triggered: ${trigger}`);

    // Update last_triggered_at on the rule
    rule.last_triggered_at = now.toISOString();

    if (action === "alert") {
      // Fire an alert
      const severity = (params.severity as AlertSeverity) ?? "warning";
      this.fireAlert(severity, `rule/${rule.id}`, trigger);
      return;
    }

    if (action === "start_vm") {
      await this.handleVmRestart(match, now);
      return;
    }

    // Unknown action — log it
    console.warn(
      `[autopilot] Unknown rule action "${action}" for rule "${rule.id}".`,
    );
  }

  private async handleVmRestart(
    match: RuleMatch,
    now: Date,
  ): Promise<void> {
    const vmid = match.params.vmid as string | number;
    const vmName = match.params.vm_name as string;

    // Check restart cooldown and attempt limits
    const record = this.restartRecords.get(vmid);
    if (record) {
      const cooldownMs = match.rule.cooldown_s * 1000;
      if (now.getTime() - record.lastAttempt < cooldownMs) {
        console.log(
          `[autopilot] Skipping restart for VM ${vmid} — still in cooldown.`,
        );
        return;
      }
      if (record.attempts >= 3) {
        console.warn(
          `[autopilot] VM ${vmid} has exceeded max restart attempts (3). Firing alert instead.`,
        );
        this.fireAlert(
          "critical",
          `autopilot/vm_restart`,
          `VM "${vmName}" (${vmid}) has been restarted 3 times and keeps stopping. Manual intervention required.`,
        );
        return;
      }
    }

    // Check governance
    const decision = await this.governance.evaluate(
      "start_vm",
      { vmid, node: match.params.node },
      "watch",
      this.toolRegistry.getAllTools(),
    );

    if (!decision.allowed) {
      console.log(
        `[autopilot] Governance blocked restart of VM ${vmid}: ${decision.reason}`,
      );
      this.fireAlert(
        "warning",
        "autopilot/governance",
        `Auto-restart of VM "${vmName}" (${vmid}) blocked by governance: ${decision.reason}`,
      );
      return;
    }

    // Execute the restart
    console.log(`[autopilot] Auto-restarting VM "${vmName}" (${vmid})...`);

    const result = await this.toolRegistry.execute("start_vm", {
      vmid,
      node: match.params.node,
    });

    // Track the attempt
    const updatedRecord: RestartRecord = {
      vmid,
      lastAttempt: now.getTime(),
      attempts: (record?.attempts ?? 0) + 1,
    };
    this.restartRecords.set(vmid, updatedRecord);

    if (result.success) {
      this.fireAlert(
        "info",
        "autopilot/vm_restart",
        `VM "${vmName}" (${vmid}) auto-restarted successfully (attempt ${updatedRecord.attempts}).`,
        true,
      );
    } else {
      this.fireAlert(
        "warning",
        "autopilot/vm_restart",
        `Failed to auto-restart VM "${vmName}" (${vmid}): ${result.error}`,
      );
    }
  }

  // ── Alert Management ──────────────────────────────────────

  private fireAlert(
    severity: AlertSeverity,
    source: string,
    message: string,
    autoHealed = false,
  ): void {
    const alert: Alert = {
      id: randomUUID(),
      severity,
      source,
      message,
      timestamp: new Date().toISOString(),
      acknowledged: false,
      resolved: autoHealed,
      auto_healed: autoHealed,
    };

    this.alerts.push(alert);

    // Cap stored alerts at 500
    if (this.alerts.length > 500) {
      this.alerts = this.alerts.slice(-500);
    }

    console.log(`[autopilot] Alert [${severity}] ${source}: ${message}`);

    // Forward to EventBus for Dashboard consumption
    this.eventBus.emit({
      type: AgentEventType.AlertFired,
      timestamp: alert.timestamp,
      data: {
        alert_id: alert.id,
        severity: alert.severity,
        source: alert.source,
        message: alert.message,
        auto_healed: alert.auto_healed,
      },
    });
  }
}
