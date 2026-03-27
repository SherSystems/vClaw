import { randomUUID } from "node:crypto";
import type { Goal, AgentEvent, AgentEventType } from "../types.js";
import type { EventBus } from "../agent/events.js";

// ── Anomaly ─────────────────────────────────────────────────

export interface Anomaly {
  id: string;
  type: "threshold" | "trend" | "spike" | "flatline" | "state_change";
  severity: "warning" | "critical";
  metric: string;
  labels: Record<string, string>;
  current_value: number;
  message: string;
  detected_at: string;
}

// ── Playbook Types ──────────────────────────────────────────

export interface AnomalyTrigger {
  metric: string;
  type: "threshold" | "trend" | "spike" | "flatline";
  severity?: "warning" | "critical";
  labels?: Record<string, string>;
}

export interface HealingAction {
  type:
    | "restart_vm"
    | "migrate_vm"
    | "expand_disk"
    | "cleanup_snapshots"
    | "rebalance_cluster"
    | "custom_goal";
  params: Record<string, unknown>;
  description: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  trigger: AnomalyTrigger;
  actions: HealingAction[];
  cooldown_minutes: number;
  requires_approval: boolean;
  max_retries: number;
}

// ── Execution Record ────────────────────────────────────────

interface ExecutionRecord {
  playbook_id: string;
  anomaly_id: string;
  success: boolean;
  executed_at: string;
}

// ── Playbook Engine ─────────────────────────────────────────

export class PlaybookEngine {
  private playbooks: Map<string, Playbook> = new Map();
  private executions: ExecutionRecord[] = [];
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  register(playbook: Playbook): void {
    this.playbooks.set(playbook.id, playbook);
  }

  unregister(playbookId: string): void {
    this.playbooks.delete(playbookId);
  }

  getAll(): Playbook[] {
    return [...this.playbooks.values()];
  }

  get(playbookId: string): Playbook | undefined {
    return this.playbooks.get(playbookId);
  }

  match(anomaly: Anomaly): Playbook[] {
    const matched: Playbook[] = [];

    for (const playbook of this.playbooks.values()) {
      if (!this.triggerMatches(playbook.trigger, anomaly)) continue;
      if (this.isOnCooldown(playbook.id)) {
        this.emitEvent("playbook_cooldown", {
          playbook_id: playbook.id,
          playbook_name: playbook.name,
          anomaly_id: anomaly.id,
        });
        continue;
      }
      matched.push(playbook);
    }

    if (matched.length > 0) {
      this.emitEvent("playbook_matched", {
        playbook_ids: matched.map((p) => p.id),
        playbook_names: matched.map((p) => p.name),
        anomaly_id: anomaly.id,
        anomaly_metric: anomaly.metric,
        anomaly_severity: anomaly.severity,
      });
    }

    return matched;
  }

  toGoal(playbook: Playbook, anomaly: Anomaly): Goal {
    const description = this.buildGoalDescription(playbook, anomaly);

    return {
      id: randomUUID(),
      mode: playbook.requires_approval ? "build" : "watch",
      description,
      raw_input: JSON.stringify({
        source: "self-healing",
        playbook_id: playbook.id,
        anomaly_id: anomaly.id,
        actions: playbook.actions,
        anomaly_labels: anomaly.labels,
        anomaly_value: anomaly.current_value,
      }),
      created_at: new Date().toISOString(),
    };
  }

  recordExecution(
    playbookId: string,
    anomalyId: string,
    success: boolean,
  ): void {
    this.executions.push({
      playbook_id: playbookId,
      anomaly_id: anomalyId,
      success,
      executed_at: new Date().toISOString(),
    });

    this.emitEvent("playbook_executed", {
      playbook_id: playbookId,
      anomaly_id: anomalyId,
      success,
    });
  }

  isOnCooldown(playbookId: string): boolean {
    const playbook = this.playbooks.get(playbookId);
    if (!playbook) return false;

    const lastExecution = this.findLastExecution(playbookId);
    if (!lastExecution) return false;

    const cooldownMs = playbook.cooldown_minutes * 60 * 1000;
    const elapsed = Date.now() - new Date(lastExecution.executed_at).getTime();
    return elapsed < cooldownMs;
  }

  getExecutionHistory(playbookId?: string): ExecutionRecord[] {
    if (!playbookId) return [...this.executions];
    return this.executions.filter((e) => e.playbook_id === playbookId);
  }

  // ── Private ─────────────────────────────────────────────────

  private triggerMatches(trigger: AnomalyTrigger, anomaly: Anomaly): boolean {
    if (trigger.metric !== anomaly.metric) return false;
    if (trigger.type !== anomaly.type) return false;
    if (trigger.severity && trigger.severity !== anomaly.severity) return false;

    if (trigger.labels) {
      for (const [key, value] of Object.entries(trigger.labels)) {
        if (anomaly.labels[key] !== value) return false;
      }
    }

    return true;
  }

  private findLastExecution(playbookId: string): ExecutionRecord | undefined {
    for (let i = this.executions.length - 1; i >= 0; i--) {
      if (this.executions[i].playbook_id === playbookId) {
        return this.executions[i];
      }
    }
    return undefined;
  }

  private buildGoalDescription(playbook: Playbook, anomaly: Anomaly): string {
    const labels = anomaly.labels;

    switch (playbook.id) {
      case "vm_unresponsive":
        return `Restart VM ${labels.vmid || "unknown"} on ${labels.node || "unknown"} — it stopped responding`;

      case "node_memory_critical":
        return `Migrate lightest VM off ${labels.node || "unknown"} — node memory at ${anomaly.current_value}%`;

      case "disk_space_critical":
        return `Free disk space on ${labels.storage || labels.node || "unknown"} — usage at ${anomaly.current_value}%, clean snapshots and expand if needed`;

      case "node_cpu_overload":
        return `Rebalance load on ${labels.node || "unknown"} — CPU sustained at ${anomaly.current_value}%, migrate heaviest VM to least-loaded node`;

      case "vm_crashed":
        return `Recover crashed VM ${labels.vmid || "unknown"} on ${labels.node || "unknown"} — unexpected stop detected`;

      case "predictive_disk_full":
        return `Prevent disk full on ${labels.storage || labels.node || "unknown"} — trend predicts full within 48 hours, cleanup snapshots`;

      default:
        return `Execute healing playbook "${playbook.name}" — ${anomaly.message}`;
    }
  }

  private emitEvent(
    type: string,
    data: Record<string, unknown>,
  ): void {
    this.eventBus.emit({
      type: type as AgentEventType,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}

// ── Default Playbooks ───────────────────────────────────────

export const DEFAULT_PLAYBOOKS: Playbook[] = [
  {
    id: "vm_unresponsive",
    name: "VM Unresponsive",
    description:
      "Restarts a VM that has stopped responding and verifies recovery",
    trigger: {
      metric: "vm_status",
      type: "flatline",
      severity: "critical",
    },
    actions: [
      {
        type: "restart_vm",
        params: { force: false, wait_for_agent: true, timeout_s: 120 },
        description: "Gracefully restart the unresponsive VM",
      },
      {
        type: "custom_goal",
        params: { goal: "Verify VM is running and network-reachable" },
        description: "Confirm the VM recovered successfully",
      },
    ],
    cooldown_minutes: 15,
    requires_approval: false,
    max_retries: 2,
  },
  {
    id: "node_memory_critical",
    name: "Node Memory Critical",
    description:
      "Migrates the lightest VM to the least-loaded node when memory exceeds 90%",
    trigger: {
      metric: "node_memory_pct",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "migrate_vm",
        params: {
          select: "lightest_by_ram",
          target: "least_loaded_node",
          live: true,
        },
        description:
          "Live-migrate the lightest VM to the least-loaded node",
      },
    ],
    cooldown_minutes: 30,
    requires_approval: false,
    max_retries: 1,
  },
  {
    id: "disk_space_critical",
    name: "Disk Space Critical",
    description:
      "Cleans old snapshots first, then expands storage if still critical",
    trigger: {
      metric: "disk_usage_pct",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "cleanup_snapshots",
        params: { older_than_days: 7, keep_minimum: 1 },
        description: "Remove snapshots older than 7 days, keeping at least one",
      },
      {
        type: "expand_disk",
        params: { increment_gb: 20, max_total_gb: 500 },
        description: "Expand storage by 20 GB if cleanup was insufficient",
      },
    ],
    cooldown_minutes: 60,
    requires_approval: true,
    max_retries: 1,
  },
  {
    id: "node_cpu_overload",
    name: "Node CPU Overload",
    description:
      "Migrates the heaviest VM to the least-loaded node when CPU exceeds 90% sustained",
    trigger: {
      metric: "node_cpu_pct",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "migrate_vm",
        params: {
          select: "heaviest_by_cpu",
          target: "least_loaded_node",
          live: true,
        },
        description:
          "Live-migrate the heaviest VM to the least-loaded node",
      },
    ],
    cooldown_minutes: 30,
    requires_approval: false,
    max_retries: 1,
  },
  {
    id: "vm_crashed",
    name: "VM Crashed",
    description:
      "Restarts a VM that stopped unexpectedly and fires an alert",
    trigger: {
      metric: "vm_status",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "restart_vm",
        params: { force: true, wait_for_agent: true, timeout_s: 180 },
        description: "Force-start the crashed VM",
      },
      {
        type: "custom_goal",
        params: {
          goal: "Alert operator that VM crashed and was auto-restarted",
        },
        description: "Send crash notification to the operator",
      },
    ],
    cooldown_minutes: 10,
    requires_approval: false,
    max_retries: 3,
  },
  {
    id: "predictive_disk_full",
    name: "Predictive Disk Full",
    description:
      "Proactively cleans snapshots when trend analysis predicts disk full within 48 hours",
    trigger: {
      metric: "disk_usage_pct",
      type: "trend",
      severity: "warning",
    },
    actions: [
      {
        type: "custom_goal",
        params: {
          goal: "Alert operator: disk projected to be full within 48 hours",
        },
        description: "Warn operator about impending disk capacity issue",
      },
      {
        type: "cleanup_snapshots",
        params: { older_than_days: 3, keep_minimum: 2 },
        description:
          "Preemptively remove snapshots older than 3 days, keeping at least two",
      },
    ],
    cooldown_minutes: 360,
    requires_approval: false,
    max_retries: 1,
  },
];
