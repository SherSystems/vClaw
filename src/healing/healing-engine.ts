import { randomUUID } from "node:crypto";
import { AgentEventType } from "../types.js";
import type { Goal } from "../types.js";
import type { AgentCore, AgentRunResult } from "../agent/core.js";
import type { EventBus } from "../agent/events.js";
import { AnomalyDetector } from "../monitoring/anomaly.js";
import type { Anomaly } from "../monitoring/anomaly.js";
import { HealthMonitor } from "../monitoring/health.js";
import { PlaybookEngine } from "./playbooks.js";
import type { Playbook } from "./playbooks.js";
import { IncidentCoordinator } from "./incident-coordinator.js";
import type { Incident } from "./incidents.js";
import { RCAAnalyzer } from "./rca-analyzer.js";

const ESCALATION_THRESHOLD = 3;
const ESCALATION_WINDOW_MINUTES = 30;
const CIRCUIT_BREAKER_THRESHOLD = 3;

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

export interface TickSummary {
  timestamp: string;
  anomaliesDetected: number;
  healingsStarted: number;
  healingsCompleted: number;
  healingsFailed: number;
  openIncidents: number;
  activeHeals: number;
  circuitBreakerPaused: boolean;
}

export interface HealingEngineConfig {
  pollIntervalMs: number;
  healingEnabled: boolean;
  maxConcurrentHeals: number;
}

export interface HealingEngineStatus {
  running: boolean;
  healingEnabled: boolean;
  activeHeals: Array<{ id: string; anomalyKey: string; startedAt: string }>;
  openIncidents: Incident[];
  circuitBreaker: CircuitBreakerState;
  lastTick?: TickSummary;
}

class HealingExecutor {
  private readonly activeHeals: Map<string, ActiveHeal> = new Map();
  private readonly circuitBreaker: CircuitBreakerState = {
    consecutiveFailures: 0,
    paused: false,
  };

  constructor(
    private readonly agentCore: AgentCore,
    private readonly eventBus: EventBus,
    private readonly playbookEngine: PlaybookEngine,
    private readonly incidentCoordinator: IncidentCoordinator,
    private readonly rcaAnalyzer: RCAAnalyzer,
    private readonly healthMonitor: HealthMonitor,
    private readonly config: HealingEngineConfig,
  ) {}

  getStatusParts(): {
    activeHeals: Array<{ id: string; anomalyKey: string; startedAt: string }>;
    circuitBreaker: CircuitBreakerState;
  } {
    return {
      activeHeals: Array.from(this.activeHeals.values()).map((heal) => ({
        id: heal.id,
        anomalyKey: heal.anomalyKey,
        startedAt: heal.startedAt,
      })),
      circuitBreaker: { ...this.circuitBreaker },
    };
  }

  getActiveIncidentIds(): Set<string> {
    return new Set(Array.from(this.activeHeals.values()).map((heal) => heal.incidentId));
  }

  get activeHealCount(): number {
    return this.activeHeals.size;
  }

  get circuitPaused(): boolean {
    return this.circuitBreaker.paused;
  }

  async handleAnomaly(anomaly: Anomaly, summary: TickSummary): Promise<void> {
    const { key, acquired } = this.incidentCoordinator.beginAnomaly(anomaly);
    if (!acquired) return;

    try {
      if (this.incidentCoordinator.findOpenIncident(anomaly)) return;

      const incident = this.incidentCoordinator.openIncident(anomaly);

      if (!this.config.healingEnabled || this.circuitBreaker.paused) return;

      if (this.incidentCoordinator.shouldEscalate(key)) {
        this.emitEvent(AgentEventType.HealingEscalated, {
          anomalyKey: key,
          incident_id: incident.id,
          reason: `Anomaly triggered ${ESCALATION_THRESHOLD}+ times in ${ESCALATION_WINDOW_MINUTES} minutes`,
        });
        return;
      }

      const suggestedId = this.incidentCoordinator.incidentManager.suggestPlaybook({
        type: anomaly.type,
        severity: anomaly.severity,
        metric: anomaly.metric,
        labels: anomaly.labels,
        value: anomaly.current_value,
        description: anomaly.message,
      });
      const playbook = (suggestedId ? this.playbookEngine.get(suggestedId) : undefined)
        ?? this.playbookEngine.match(anomaly)[0];
      if (!playbook) return;

      if (playbook.requires_approval) {
        this.emitEvent(AgentEventType.HealingEscalated, {
          anomalyKey: key,
          incident_id: incident.id,
          playbook_id: playbook.id,
          reason: `Playbook "${playbook.name}" requires approval — escalating to operator`,
        });
        return;
      }

      if (this.activeHeals.size >= this.config.maxConcurrentHeals) return;

      this.rcaAnalyzer.analyze(anomaly, incident, this.healthMonitor.store).catch((err) => {
        console.error(
          `[healing] RCA analysis failed for incident ${incident.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      await this.executeHealing(anomaly, incident, playbook, summary, key);
    } finally {
      this.incidentCoordinator.endAnomaly(key);
    }
  }

  private async executeHealing(
    anomaly: Anomaly,
    incident: Incident,
    playbook: Playbook,
    summary: TickSummary,
    anomalyKey: string,
  ): Promise<void> {
    const healId = randomUUID();
    const goal = this.playbookEngine.toGoal(playbook, anomaly);
    const startedAt = new Date().toISOString();

    this.incidentCoordinator.recordEscalation(anomalyKey);
    this.emitEvent(AgentEventType.HealingStarted, {
      heal_id: healId,
      incident_id: incident.id,
      playbook_id: playbook.id,
      goal_id: goal.id,
      description: goal.description,
    });

    this.incidentCoordinator.incidentManager.recordAction(
      incident.id,
      `Executing playbook "${playbook.name}"`,
      true,
      `Goal: ${goal.description}`,
    );

    summary.healingsStarted++;

    const promise = this.agentCore.run(goal);
    this.activeHeals.set(healId, { id: healId, anomalyKey, incidentId: incident.id, goal, startedAt, promise });

    try {
      const result = await promise;
      this.activeHeals.delete(healId);

      if (!result.success) {
        this.onHealingFailed(healId, incident, playbook, anomaly, result.errors, summary);
        return;
      }

      this.circuitBreaker.consecutiveFailures = 0;
      summary.healingsCompleted++;

      this.incidentCoordinator.incidentManager.recordAction(
        incident.id,
        `Playbook "${playbook.name}" succeeded`,
        true,
        `${result.steps_completed} steps completed in ${result.duration_ms}ms`,
      );
      this.incidentCoordinator.incidentManager.resolve(
        incident.id,
        `Healed by playbook "${playbook.name}" — ${result.steps_completed} steps completed`,
      );
      this.playbookEngine.recordExecution(playbook.id, anomaly.id, true);

      this.emitEvent(AgentEventType.HealingCompleted, {
        heal_id: healId,
        incident_id: incident.id,
        playbook_id: playbook.id,
        steps_completed: result.steps_completed,
        duration_ms: result.duration_ms,
      });
    } catch (err) {
      this.activeHeals.delete(healId);
      const message = err instanceof Error ? err.message : String(err);
      this.onHealingFailed(healId, incident, playbook, anomaly, [message], summary);
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

    const errorMessage = errors.join("; ");
    this.incidentCoordinator.incidentManager.recordAction(
      incident.id,
      `Playbook "${playbook.name}" failed`,
      false,
      errorMessage,
    );
    this.incidentCoordinator.incidentManager.fail(incident.id, `Healing failed: ${errorMessage}`);
    this.playbookEngine.recordExecution(playbook.id, anomaly.id, false);

    this.emitEvent(AgentEventType.HealingFailed, {
      heal_id: healId,
      incident_id: incident.id,
      playbook_id: playbook.id,
      errors,
    });

    if (this.circuitBreaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreaker.paused = true;
      this.circuitBreaker.pausedAt = new Date().toISOString();

      this.emitEvent(AgentEventType.HealingPaused, {
        reason: `${CIRCUIT_BREAKER_THRESHOLD} consecutive healing failures`,
        consecutive_failures: this.circuitBreaker.consecutiveFailures,
      });
    }
  }

  private emitEvent(type: AgentEventType, data: Record<string, unknown>): void {
    this.eventBus.emit({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}

export class HealingEngine {
  private readonly executor: HealingExecutor;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTick?: TickSummary;

  constructor(
    private readonly eventBus: EventBus,
    private readonly healthMonitor: HealthMonitor,
    private readonly anomalyDetector: AnomalyDetector,
    private readonly incidentCoordinator: IncidentCoordinator,
    private readonly config: HealingEngineConfig,
    executorDeps: {
      agentCore: AgentCore;
      playbookEngine: PlaybookEngine;
      rcaAnalyzer: RCAAnalyzer;
    },
  ) {
    this.executor = new HealingExecutor(
      executorDeps.agentCore,
      eventBus,
      executorDeps.playbookEngine,
      incidentCoordinator,
      executorDeps.rcaAnalyzer,
      healthMonitor,
      config,
    );
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    console.log(`[healing] Starting orchestrator (poll: ${this.config.pollIntervalMs}ms, healing: ${this.config.healingEnabled})`);
    this.healthMonitor.start(this.config.pollIntervalMs);

    setTimeout(() => {
      this.tick().catch((err) => console.error("[healing] First tick failed:", err));
    }, 5000);

    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => console.error("[healing] Tick failed:", err));
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

  getStatus(): HealingEngineStatus {
    const status = this.executor.getStatusParts();
    return {
      running: this.running,
      healingEnabled: this.config.healingEnabled,
      activeHeals: status.activeHeals,
      openIncidents: this.incidentCoordinator.incidentManager.getOpen(),
      circuitBreaker: status.circuitBreaker,
      lastTick: this.lastTick,
    };
  }

  async tick(): Promise<void> {
    const summary: TickSummary = {
      timestamp: new Date().toISOString(),
      anomaliesDetected: 0,
      healingsStarted: 0,
      healingsCompleted: 0,
      healingsFailed: 0,
      openIncidents: 0,
      activeHeals: this.executor.activeHealCount,
      circuitBreakerPaused: this.executor.circuitPaused,
    };

    try {
      const anomalies = this.anomalyDetector.detect(wrapStoreForDetector(this.healthMonitor));
      const vmCrashAnomalies = this.incidentCoordinator.detectVmStateChanges(this.healthMonitor.store);
      anomalies.push(...vmCrashAnomalies);

      summary.anomaliesDetected = anomalies.length;

      for (const anomaly of anomalies) {
        await this.executor.handleAnomaly(anomaly, summary);
      }

      this.incidentCoordinator.resolveRecoveredIncidents(
        this.healthMonitor.store,
        this.executor.getActiveIncidentIds(),
      );

      summary.openIncidents = this.incidentCoordinator.incidentManager.getOpen().length;
      summary.activeHeals = this.executor.activeHealCount;
      summary.circuitBreakerPaused = this.executor.circuitPaused;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[healing] Tick error: ${message}`);
    }

    this.lastTick = summary;
    this.eventBus.emit({
      type: AgentEventType.HealingTick,
      timestamp: new Date().toISOString(),
      data: { ...summary },
    });
  }

  async handleAnomaly(anomaly: Anomaly, summary: TickSummary): Promise<void> {
    await this.executor.handleAnomaly(anomaly, summary);
  }
}

function wrapStoreForDetector(healthMonitor: HealthMonitor): {
  query(metric: string, labels: Record<string, string>, duration_minutes: number): Array<{ timestamp: string; value: number; labels: Record<string, string> }>;
  getLatest(metric: string, labels: Record<string, string>): { timestamp: string; value: number; labels: Record<string, string> } | null;
} {
  return {
    query: (metric, labels, duration_minutes) =>
      healthMonitor.store.query(metric, labels, duration_minutes).map((point) => ({
        timestamp: new Date(point.timestamp).toISOString(),
        value: point.value,
        labels: point.labels,
      })),
    getLatest: (metric, labels) => {
      const point = healthMonitor.store.getLatest(metric, labels);
      if (!point) return null;
      return {
        timestamp: new Date(point.timestamp).toISOString(),
        value: point.value,
        labels: point.labels,
      };
    },
  };
}
