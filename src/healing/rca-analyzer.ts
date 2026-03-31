import { callLLM } from "../agent/llm.js";
import type { EventBus } from "../agent/events.js";
import type { AgentCore } from "../agent/core.js";
import type { Anomaly } from "../monitoring/anomaly.js";
import type { MetricStore } from "../monitoring/health.js";
import { AgentEventType } from "../types.js";
import type { IncidentManager, Incident } from "./incidents.js";

interface RCAResult {
  root_cause: string;
  confidence: string;
  contributing_factors: string[];
  recommended_action: string;
}

const DEFAULT_RCA_TIMEOUT_MS = 30_000;

export class RCAAnalyzer {
  private readonly agentCore: AgentCore;
  private readonly eventBus: EventBus;
  private readonly incidentManager: IncidentManager;
  private readonly timeoutMs: number;

  constructor(options: {
    agentCore: AgentCore;
    eventBus: EventBus;
    incidentManager: IncidentManager;
    timeoutMs?: number;
  }) {
    this.agentCore = options.agentCore;
    this.eventBus = options.eventBus;
    this.incidentManager = options.incidentManager;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RCA_TIMEOUT_MS;
  }

  async analyze(anomaly: Anomaly, incident: Incident, store: MetricStore): Promise<void> {
    try {
      const metricPoints = store.query(anomaly.metric, anomaly.labels, 30);
      const metricSummary = metricPoints.length > 0
        ? metricPoints
            .map((point) => `[${new Date(point.timestamp).toISOString()}] ${point.value.toFixed(2)}`)
            .join("\n")
        : "No metric data available for the last 30 minutes.";

      const recentEvents = this.eventBus.getHistory(20);
      const eventsSummary = recentEvents.length > 0
        ? recentEvents
            .map((event) => `[${event.timestamp}] ${event.type}: ${JSON.stringify(event.data)}`)
            .join("\n")
        : "No recent events.";

      const response = await this.withTimeout(
        callLLM({
          system: this.buildSystemPrompt(),
          user: this.buildUserMessage(anomaly, metricSummary, eventsSummary),
          config: this.agentCore.aiConfig,
          maxTokens: 1024,
        }),
        this.timeoutMs,
        `RCA request timed out after ${this.timeoutMs}ms`,
      );

      const rca = this.parseResponse(response);

      this.incidentManager.recordAction(
        incident.id,
        `AI Root Cause Analysis: ${rca.root_cause}`,
        true,
        `Confidence: ${rca.confidence}` +
          (rca.contributing_factors.length > 0 ? ` | Factors: ${rca.contributing_factors.join(", ")}` : "") +
          (rca.recommended_action ? ` | Recommendation: ${rca.recommended_action}` : ""),
      );

      this.emitEvent(AgentEventType.IncidentRca, {
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[healing] RCA analysis error for incident ${incident.id}: ${message}`);
    }
  }

  private buildSystemPrompt(): string {
    return `You are an infrastructure root cause analysis (RCA) engine for an infrastructure environment managed by vClaw.
Given an anomaly, recent metric history, and recent system events, determine the most likely root cause.

Respond with a JSON object:
{
  "root_cause": "A concise explanation of the root cause (1-3 sentences)",
  "confidence": "low" | "medium" | "high",
  "contributing_factors": ["factor1", "factor2"],
  "recommended_action": "What should be done to prevent recurrence"
}`;
  }

  private buildUserMessage(anomaly: Anomaly, metricSummary: string, eventsSummary: string): string {
    return `Anomaly detected:
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
  }

  private parseResponse(response: string): RCAResult {
    try {
      return JSON.parse(response) as RCAResult;
    } catch {
      return {
        root_cause: response.slice(0, 500),
        confidence: "low",
        contributing_factors: [],
        recommended_action: "Review manually",
      };
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private emitEvent(type: AgentEventType, data: Record<string, unknown>): void {
    this.eventBus.emit({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}
