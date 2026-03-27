import { randomUUID } from "node:crypto";
import type { Goal, AgentEventType } from "../types.js";
import type { AgentCore, AgentRunResult } from "../agent/core.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventBus } from "../agent/events.js";
import type { GovernanceEngine } from "../governance/index.js";
import { HealthMonitor } from "../monitoring/health.js";
import { AnomalyDetector } from "../monitoring/anomaly.js";
import type { Anomaly } from "../monitoring/anomaly.js";
import { PlaybookEngine, DEFAULT_PLAYBOOKS } from "./playbooks.js";
import type { Playbook } from "./playbooks.js";
import { IncidentManager } from "./incidents.js";
import type { Incident } from "./incidents.js";
import { callLLM } from "../agent/llm.js";

// ── Types ───────────────────────────────────────────────────

export interface HealingOrchestratorConfig {
  pollIntervalMs: number;
  healingEnabled: boolean;
  maxConcurrentHeals: number;
}

export interface HealingOrchestratorOptions {
  agentCore: AgentCore;
  toolRegistry: ToolRegistry;
  eventBus: EventBus;
  governance: GovernanceEngine;
  dataDir: string;
  config: HealingOrchestratorConfig;
}

interface ActiveHeal {
  id: string;
  anomalyKey: string;
  incidentId: string;
  goal: Goal;
  startedAt: string;
  promise: Promise<AgentRunResult>;
}

interface CircuitBreakerState {
  consecutiveFailures: number;
  paused: boolean;
  pausedAt?: string;
}

interface TickSummary {
  timestamp: string;
  anomaliesDetected: number;
  healingsStarted: number;
  healingsCompleted: number;
  healingsFailed: number;
  openIncidents: number;
  activeHeals: number;
  circuitBreakerPaused: boolean;
}

export interface OrchestratorStatus {
  running: boolean;
  healingEnabled: boolean;
  activeHeals: Array<{ id: string; anomalyKey: string; startedAt: string }>;
  openIncidents: Incident[];
  circuitBreaker: CircuitBreakerState;
  lastTick?: TickSummary;
}

const ESCALATION_THRESHOLD = 3;
const ESCALATION_WINDOW_MS = 30 * 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 3;

// ── Adapter to bridge MetricStore timestamp types ───────────
// health.ts MetricStore uses number timestamps, anomaly.ts detect() expects string timestamps
// We wrap the store to convert on the fly

function wrapStoreForDetector(store: import("../monitoring/health.js").MetricStore) {
  return {
    query(metric: string, labels: Record<string, string>, duration_minutes: number) {
      return store.query(metric, labels, duration_minutes).map((p) => ({
        timestamp: new Date(p.timestamp).toISOString(),
        value: p.value,
        labels: p.labels,
      }));
    },
    getLatest(metric: string, labels: Record<string, string>) {
      const p = store.getLatest(metric, labels);
      if (!p) return null;
      return {
        timestamp: new Date(p.timestamp).toISOString(),
        value: p.value,
        labels: p.labels,
      };
    },
  };
}

// ── Orchestrator ────────────────────────────────────────────

export class HealingOrchestrator {
  private agentCore: AgentCore;
  private eventBus: EventBus;
  private config: HealingOrchestratorConfig;

  private healthMonitor: HealthMonitor;
  private anomalyDetector: AnomalyDetector;
  private playbookEngine: PlaybookEngine;
  readonly incidentManager: IncidentManager;

  private activeHeals: Map<string, ActiveHeal> = new Map();
  private escalationHistory: Map<string, number[]> = new Map();
  /** Previous VM status snapshot: vmid -> 1 (running) or 0 (stopped) */
  private previousVmStatus: Map<string, number> = new Map();
  private circuitBreaker: CircuitBreakerState = {
    consecutiveFailures: 0,
    paused: false,
  };

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTick?: TickSummary;

  constructor(options: HealingOrchestratorOptions) {
    this.agentCore = options.agentCore;
    this.eventBus = options.eventBus;
    this.config = options.config;

    this.healthMonitor = new HealthMonitor(options.toolRegistry, options.eventBus);
    this.anomalyDetector = new AnomalyDetector({
      thresholds: [
        { metric: "node_cpu_pct", labels: {}, warning: 80, critical: 90 },
        { metric: "node_mem_pct", labels: {}, warning: 75, critical: 85 },
        { metric: "node_disk_pct", labels: {}, warning: 80, critical: 90 },
        { metric: "vm_cpu_pct", labels: {}, warning: 85, critical: 95 },
        { metric: "vm_mem_pct", labels: {}, warning: 80, critical: 90 },
      ],
      trends: [
        { metric: "node_disk_pct", labels: {}, lookback_minutes: 60, threshold: 90, horizon_hours: 48 },
        { metric: "node_mem_pct", labels: {}, lookback_minutes: 30, threshold: 90, horizon_hours: 2 },
      ],
      flatlines: [],
    });
    this.playbookEngine = new PlaybookEngine(options.eventBus);
    this.incidentManager = new IncidentManager(options.eventBus, options.dataDir);

    for (const pb of DEFAULT_PLAYBOOKS) {
      this.playbookEngine.register(pb);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    console.log(`[healing] Starting orchestrator (poll: ${this.config.pollIntervalMs}ms, healing: ${this.config.healingEnabled})`);
    this.healthMonitor.start(this.config.pollIntervalMs);
    // Run first tick after a short delay to let metrics collect
    setTimeout(() => {
      this.tick().catch((err) => console.error(`[healing] First tick failed:`, err));
    }, 5000);

    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => console.error(`[healing] Tick failed:`, err));
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.healthMonitor.stop();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getStatus(): OrchestratorStatus {
    return {
      running: this.running,
      healingEnabled: this.config.healingEnabled,
      activeHeals: Array.from(this.activeHeals.values()).map((h) => ({
        id: h.id,
        anomalyKey: h.anomalyKey,
        startedAt: h.startedAt,
      })),
      openIncidents: this.incidentManager.getOpen(),
      circuitBreaker: { ...this.circuitBreaker },
      lastTick: this.lastTick,
    };
  }

  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }

  // ── Main Loop ───────────────────────────────────────────────

  private async tick(): Promise<void> {
    const summary: TickSummary = {
      timestamp: new Date().toISOString(),
      anomaliesDetected: 0,
      healingsStarted: 0,
      healingsCompleted: 0,
      healingsFailed: 0,
      openIncidents: 0,
      activeHeals: this.activeHeals.size,
      circuitBreakerPaused: this.circuitBreaker.paused,
    };

    try {
      // Detect metric-based anomalies (threshold, trend, spike)
      const wrappedStore = wrapStoreForDetector(this.healthMonitor.store);
      const seriesCount = this.healthMonitor.store.seriesCount;
      const vmSnapshots = this.previousVmStatus.size;
      const anomalies = this.anomalyDetector.detect(wrappedStore);

      // Detect VM state changes (running → stopped = crash)
      const vmCrashAnomalies = this.detectVmStateChanges();
      anomalies.push(...vmCrashAnomalies);

      summary.anomaliesDetected = anomalies.length;

      console.log(`[healing] tick: ${seriesCount} series, ${vmSnapshots} VMs tracked, ${anomalies.length} anomalies, ${vmCrashAnomalies.length} state changes`);

      for (const anomaly of anomalies) {
        await this.handleAnomaly(anomaly, summary);
      }

      this.checkResolvedIncidents();

      summary.openIncidents = this.incidentManager.getOpen().length;
      summary.activeHeals = this.activeHeals.size;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[healing] Tick error: ${msg}`);
    }

    this.lastTick = summary;
    this.emitEvent("healing_tick", { ...summary });
  }

  // ── Anomaly Handling ────────────────────────────────────────

  private async handleAnomaly(anomaly: Anomaly, summary: TickSummary): Promise<void> {
    const key = this.anomalyKey(anomaly);

    // Check if there's already an open incident for this anomaly
    const openIncidents = this.incidentManager.getOpen();
    const existing = openIncidents.find((i) =>
      i.metric === anomaly.metric &&
      i.anomaly_type === anomaly.type &&
      this.labelsMatch(i.labels, anomaly.labels)
    );
    if (existing) return; // Already tracking this

    // Open a new incident
    console.log(`[healing] Anomaly detected: ${anomaly.message} (type=${anomaly.type}, metric=${anomaly.metric})`);
    const incident = this.incidentManager.open(
      {
        type: anomaly.type,
        severity: anomaly.severity,
        metric: anomaly.metric,
        labels: anomaly.labels,
        value: anomaly.current_value,
        description: anomaly.message,
      },
    );
    console.log(`[healing] Incident opened: ${incident.id}`);

    if (!this.config.healingEnabled) { console.log(`[healing] Healing disabled, skipping`); return; }
    if (this.circuitBreaker.paused) { console.log(`[healing] Circuit breaker paused, skipping`); return; }

    // Check escalation
    if (this.shouldEscalate(key)) {
      this.emitEvent("healing_escalated", {
        anomalyKey: key,
        incident_id: incident.id,
        reason: `Anomaly triggered ${ESCALATION_THRESHOLD}+ times in ${ESCALATION_WINDOW_MS / 60000} minutes`,
      });
      return;
    }

    // Try to find a matching playbook
    // First check learned patterns
    const suggestedId = this.incidentManager.suggestPlaybook({
      type: anomaly.type,
      severity: anomaly.severity,
      metric: anomaly.metric,
      labels: anomaly.labels,
      value: anomaly.current_value,
      description: anomaly.message,
    });
    let playbook: Playbook | undefined;
    if (suggestedId) {
      playbook = this.playbookEngine.get(suggestedId);
    }

    if (!playbook) {
      const matches = this.playbookEngine.match(anomaly);
      console.log(`[healing] Playbook match: ${matches.length} matches for type=${anomaly.type} metric=${anomaly.metric}`);
      playbook = matches[0]; // Take the first match
    }

    if (!playbook) { console.log(`[healing] No playbook matched, incident stays open`); return; }
    console.log(`[healing] Using playbook: ${playbook.id} (${playbook.name})`);

    // Block destructive playbooks
    if (playbook.requires_approval) {
      this.emitEvent("healing_escalated", {
        anomalyKey: key,
        incident_id: incident.id,
        playbook_id: playbook.id,
        reason: `Playbook "${playbook.name}" requires approval — escalating to operator`,
      });
      return;
    }

    if (this.activeHeals.size >= this.config.maxConcurrentHeals) return;

    // Fire-and-forget: run AI root cause analysis in the background
    this.analyzeRootCause(anomaly, incident).catch((err) => {
      console.error(`[healing] RCA analysis failed for incident ${incident.id}:`, err instanceof Error ? err.message : String(err));
    });

    await this.executeHealing(anomaly, incident, playbook, summary);
  }

  // ── Healing Execution ───────────────────────────────────────

  private async executeHealing(
    anomaly: Anomaly,
    incident: Incident,
    playbook: Playbook,
    summary: TickSummary,
  ): Promise<void> {
    const healId = randomUUID();
    const now = new Date().toISOString();
    const key = this.anomalyKey(anomaly);

    const goal = this.playbookEngine.toGoal(playbook, anomaly);

    this.recordEscalation(key);

    this.emitEvent("healing_started", {
      heal_id: healId,
      incident_id: incident.id,
      playbook_id: playbook.id,
      goal_id: goal.id,
      description: goal.description,
    });

    this.incidentManager.recordAction(
      incident.id,
      `Executing playbook "${playbook.name}"`,
      true,
      `Goal: ${goal.description}`,
    );

    summary.healingsStarted++;

    const promise = this.agentCore.run(goal);
    this.activeHeals.set(healId, {
      id: healId,
      anomalyKey: key,
      incidentId: incident.id,
      goal,
      startedAt: now,
      promise,
    });

    try {
      const result = await promise;
      this.activeHeals.delete(healId);

      if (result.success) {
        this.circuitBreaker.consecutiveFailures = 0;
        summary.healingsCompleted++;

        this.incidentManager.recordAction(
          incident.id,
          `Playbook "${playbook.name}" succeeded`,
          true,
          `${result.steps_completed} steps completed in ${result.duration_ms}ms`,
        );
        this.incidentManager.resolve(
          incident.id,
          `Healed by playbook "${playbook.name}" — ${result.steps_completed} steps completed`,
        );
        this.playbookEngine.recordExecution(playbook.id, anomaly.id, true);

        this.emitEvent("healing_completed", {
          heal_id: healId,
          incident_id: incident.id,
          playbook_id: playbook.id,
          steps_completed: result.steps_completed,
          duration_ms: result.duration_ms,
        });
      } else {
        this.onHealingFailed(healId, incident, playbook, anomaly, result.errors, summary);
      }
    } catch (err) {
      this.activeHeals.delete(healId);
      const msg = err instanceof Error ? err.message : String(err);
      this.onHealingFailed(healId, incident, playbook, anomaly, [msg], summary);
    }
  }

  private onHealingFailed(
    healId: string,
    incident: Incident,
    playbook: Playbook,
    anomaly: Anomaly,
    errors: string[],
    summary: TickSummary,
  ): void {
    this.circuitBreaker.consecutiveFailures++;
    summary.healingsFailed++;

    const errStr = errors.join("; ");

    this.incidentManager.recordAction(
      incident.id,
      `Playbook "${playbook.name}" failed`,
      false,
      errStr,
    );
    this.incidentManager.fail(incident.id, `Healing failed: ${errStr}`);
    this.playbookEngine.recordExecution(playbook.id, anomaly.id, false);

    this.emitEvent("healing_failed", {
      heal_id: healId,
      incident_id: incident.id,
      playbook_id: playbook.id,
      errors,
    });

    if (this.circuitBreaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreaker.paused = true;
      this.circuitBreaker.pausedAt = new Date().toISOString();

      this.emitEvent("healing_paused", {
        reason: `${CIRCUIT_BREAKER_THRESHOLD} consecutive healing failures`,
        consecutive_failures: this.circuitBreaker.consecutiveFailures,
      });
    }
  }

  // ── Resolution Check ───────────────────────────────────────

  private checkResolvedIncidents(): void {
    const open = this.incidentManager.getOpen();

    for (const incident of open) {
      // Skip incidents with active heals
      const hasActiveHeal = Array.from(this.activeHeals.values()).some(
        (h) => h.incidentId === incident.id,
      );
      if (hasActiveHeal) continue;

      // Check if the metric is back to normal
      const wrappedStore = wrapStoreForDetector(this.healthMonitor.store);
      const latest = wrappedStore.getLatest(incident.metric, incident.labels);
      if (!latest) continue;

      // Simple check: if current value is below 70% of trigger value, consider resolved
      if (latest.value < incident.trigger_value * 0.7) {
        this.incidentManager.resolve(
          incident.id,
          `Metrics returned to normal (${latest.value.toFixed(1)} < ${incident.trigger_value.toFixed(1)})`,
        );
        this.emitEvent("alert_resolved" as AgentEventType, {
          incident_id: incident.id,
          metric: incident.metric,
          current_value: latest.value,
        });
      }
    }
  }

  // ── Escalation Tracking ───────────────────────────────────

  private recordEscalation(key: string): void {
    const now = Date.now();
    let history = this.escalationHistory.get(key);
    if (!history) {
      history = [];
      this.escalationHistory.set(key, history);
    }
    history.push(now);
    // Prune old entries
    const cutoff = now - ESCALATION_WINDOW_MS;
    this.escalationHistory.set(key, history.filter((t) => t >= cutoff));
  }

  private shouldEscalate(key: string): boolean {
    const history = this.escalationHistory.get(key);
    if (!history) return false;
    const now = Date.now();
    const recent = history.filter((t) => now - t < ESCALATION_WINDOW_MS);
    return recent.length >= ESCALATION_THRESHOLD;
  }

  // ── VM State Change Detection ──────────────────────────────

  private detectVmStateChanges(): Anomaly[] {
    const anomalies: Anomaly[] = [];

    // Get current status of all VMs from the metric store
    const allVmStatus = this.healthMonitor.store.getAllLatest("vm_status");

    for (const { value, labels } of allVmStatus) {
      const vmKey = `${labels.vmid}|${labels.node}|${labels.name || ""}`;
      const prevValue = this.previousVmStatus.get(vmKey);

      // Was running (1) last tick, now stopped (0) = unexpected stop
      if (prevValue === 1 && value === 0) {
        anomalies.push({
          id: randomUUID(),
          type: "threshold",
          severity: "critical",
          metric: "vm_status",
          labels,
          current_value: 0,
          message: `VM ${labels.name || labels.vmid} on ${labels.node} stopped unexpectedly`,
          detected_at: new Date().toISOString(),
        });
      }

      this.previousVmStatus.set(vmKey, value);
    }

    return anomalies;
  }

  // ── AI Root Cause Analysis ─────────────────────────────────

  private async analyzeRootCause(anomaly: Anomaly, incident: Incident): Promise<void> {
    try {
      // Gather recent metrics for the affected resource (last 30 minutes)
      const metricPoints = this.healthMonitor.store.query(
        anomaly.metric,
        anomaly.labels,
        30,
      );
      const metricSummary = metricPoints.length > 0
        ? metricPoints.map((p) => `[${new Date(p.timestamp).toISOString()}] ${p.value.toFixed(2)}`).join("\n")
        : "No metric data available for the last 30 minutes.";

      // Gather recent events
      const recentEvents = this.eventBus.getHistory(20);
      const eventsSummary = recentEvents.length > 0
        ? recentEvents
            .map((e) => `[${e.timestamp}] ${e.type}: ${JSON.stringify(e.data)}`)
            .join("\n")
        : "No recent events.";

      const systemPrompt = `You are an infrastructure root cause analysis (RCA) engine for an infrastructure environment managed by vClaw.
Given an anomaly, recent metric history, and recent system events, determine the most likely root cause.

Respond with a JSON object:
{
  "root_cause": "A concise explanation of the root cause (1-3 sentences)",
  "confidence": "low" | "medium" | "high",
  "contributing_factors": ["factor1", "factor2"],
  "recommended_action": "What should be done to prevent recurrence"
}`;

      const userMessage = `Anomaly detected:
- Type: ${anomaly.type}
- Severity: ${anomaly.severity}
- Metric: ${anomaly.metric}
- Labels: ${JSON.stringify(anomaly.labels)}
- Current Value: ${anomaly.current_value}
- Message: ${anomaly.message}
- Detected At: ${anomaly.detected_at}

Recent metric history (${anomaly.metric}, last 30 min):
${metricSummary}

Recent system events:
${eventsSummary}`;

      const response = await callLLM({
        system: systemPrompt,
        user: userMessage,
        config: this.agentCore.aiConfig,
        maxTokens: 1024,
      });

      let rca: {
        root_cause: string;
        confidence: string;
        contributing_factors: string[];
        recommended_action: string;
      };
      try {
        rca = JSON.parse(response);
      } catch {
        // If LLM returned plain text, use it as the root cause
        rca = {
          root_cause: response.slice(0, 500),
          confidence: "low",
          contributing_factors: [],
          recommended_action: "Review manually",
        };
      }

      // Record the RCA as an incident action
      this.incidentManager.recordAction(
        incident.id,
        `AI Root Cause Analysis: ${rca.root_cause}`,
        true,
        `Confidence: ${rca.confidence}` +
          (rca.contributing_factors.length > 0 ? ` | Factors: ${rca.contributing_factors.join(", ")}` : "") +
          (rca.recommended_action ? ` | Recommendation: ${rca.recommended_action}` : ""),
      );

      // Emit the RCA event
      this.emitEvent("incident_rca", {
        incident_id: incident.id,
        metric: anomaly.metric,
        severity: anomaly.severity,
        root_cause: rca.root_cause,
        confidence: rca.confidence,
        contributing_factors: rca.contributing_factors,
        recommended_action: rca.recommended_action,
      });

      console.log(`[healing] RCA complete for incident ${incident.id}: ${rca.root_cause.slice(0, 100)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[healing] RCA analysis error for incident ${incident.id}: ${msg}`);
      // Non-fatal: don't re-throw, just log
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private anomalyKey(anomaly: Anomaly): string {
    const labelStr = Object.entries(anomaly.labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${anomaly.type}:${anomaly.metric}:{${labelStr}}`;
  }

  private labelsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => a[k] === b[k]);
  }

  private emitEvent(type: AgentEventType, data: Record<string, unknown>): void {
    this.eventBus.emit({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}
