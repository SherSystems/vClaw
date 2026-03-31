import type { AgentCore } from "../agent/core.js";
import type { EventBus } from "../agent/events.js";
import type { GovernanceEngine } from "../governance/index.js";
import { AnomalyDetector } from "../monitoring/anomaly.js";
import type { Anomaly } from "../monitoring/anomaly.js";
import { HealthMonitor } from "../monitoring/health.js";
import type { ToolRegistry } from "../tools/registry.js";
import { IncidentCoordinator } from "./incident-coordinator.js";
import type { Incident } from "./incidents.js";
import { PlaybookEngine, DEFAULT_PLAYBOOKS } from "./playbooks.js";
import { RCAAnalyzer } from "./rca-analyzer.js";
import { HealingEngine } from "./healing-engine.js";
import type { TickSummary, HealingEngineStatus } from "./healing-engine.js";

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

export type OrchestratorStatus = HealingEngineStatus;

export class HealingOrchestrator {
  readonly incidentManager: IncidentCoordinator["incidentManager"];

  private readonly healthMonitor: HealthMonitor;
  private readonly anomalyDetector: AnomalyDetector;
  private readonly playbookEngine: PlaybookEngine;
  private readonly incidentCoordinator: IncidentCoordinator;
  private readonly rcaAnalyzer: RCAAnalyzer;
  private readonly engine: HealingEngine;

  constructor(options: HealingOrchestratorOptions) {
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
    for (const playbook of DEFAULT_PLAYBOOKS) {
      this.playbookEngine.register(playbook);
    }

    this.incidentCoordinator = new IncidentCoordinator(options.eventBus, options.dataDir);
    this.incidentManager = this.incidentCoordinator.incidentManager;

    this.rcaAnalyzer = new RCAAnalyzer({
      agentCore: options.agentCore,
      eventBus: options.eventBus,
      incidentManager: this.incidentManager,
    });

    this.engine = new HealingEngine(
      options.eventBus,
      this.healthMonitor,
      this.anomalyDetector,
      this.incidentCoordinator,
      options.config,
      {
        agentCore: options.agentCore,
        playbookEngine: this.playbookEngine,
        rcaAnalyzer: this.rcaAnalyzer,
      },
    );
  }

  start(): void {
    this.engine.start();
  }

  stop(): void {
    this.engine.stop();
  }

  getStatus(): OrchestratorStatus {
    return this.engine.getStatus();
  }

  getHealthMonitor(): HealthMonitor {
    return this.healthMonitor;
  }

  // Compatibility wrappers used by tests that reach private internals.
  private async tick(): Promise<void> {
    await this.engine.tick();
  }

  private async handleAnomaly(anomaly: Anomaly, summary: TickSummary): Promise<void> {
    await this.engine.handleAnomaly(anomaly, summary);
  }

  private get openIncidents(): Incident[] {
    return this.incidentManager.getOpen();
  }
}
