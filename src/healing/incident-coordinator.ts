import { randomUUID } from "node:crypto";
import type { EventBus } from "../agent/events.js";
import type { Anomaly } from "../monitoring/anomaly.js";
import type { MetricStore } from "../monitoring/health.js";
import { AgentEventType } from "../types.js";
import { IncidentManager } from "./incidents.js";
import type { Incident } from "./incidents.js";

const ESCALATION_THRESHOLD = 3;
const ESCALATION_WINDOW_MS = 30 * 60 * 1000;

export class IncidentCoordinator {
  readonly incidentManager: IncidentManager;

  private readonly eventBus: EventBus;
  private readonly inFlightAnomalies: Set<string> = new Set();
  private readonly escalationHistory: Map<string, number[]> = new Map();
  private readonly previousVmStatus: Map<string, number> = new Map();

  constructor(eventBus: EventBus, dataDir: string) {
    this.eventBus = eventBus;
    this.incidentManager = new IncidentManager(eventBus, dataDir);
  }

  beginAnomaly(anomaly: Anomaly): { key: string; acquired: boolean } {
    const key = this.anomalyKey(anomaly);
    if (this.inFlightAnomalies.has(key)) {
      return { key, acquired: false };
    }
    this.inFlightAnomalies.add(key);
    return { key, acquired: true };
  }

  endAnomaly(key: string): void {
    this.inFlightAnomalies.delete(key);
  }

  findOpenIncident(anomaly: Anomaly): Incident | undefined {
    return this.incidentManager.getOpen().find(
      (incident) =>
        incident.metric === anomaly.metric &&
        incident.anomaly_type === anomaly.type &&
        this.labelsMatch(incident.labels, anomaly.labels),
    );
  }

  openIncident(anomaly: Anomaly): Incident {
    return this.incidentManager.open({
      type: anomaly.type,
      severity: anomaly.severity,
      metric: anomaly.metric,
      labels: anomaly.labels,
      value: anomaly.current_value,
      description: anomaly.message,
    });
  }

  shouldEscalate(key: string): boolean {
    const history = this.escalationHistory.get(key);
    if (!history) return false;
    const now = Date.now();
    const recent = history.filter((timestamp) => now - timestamp < ESCALATION_WINDOW_MS);
    return recent.length >= ESCALATION_THRESHOLD;
  }

  recordEscalation(key: string): void {
    const now = Date.now();
    const history = this.escalationHistory.get(key) ?? [];
    history.push(now);

    const cutoff = now - ESCALATION_WINDOW_MS;
    this.escalationHistory.set(
      key,
      history.filter((timestamp) => timestamp >= cutoff),
    );
  }

  detectVmStateChanges(store: MetricStore): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const allVmStatus = store.getAllLatest("vm_status");

    for (const { value, labels } of allVmStatus) {
      const vmKey = `${labels.vmid}|${labels.node}|${labels.name || ""}`;
      const previousValue = this.previousVmStatus.get(vmKey);

      if (previousValue === 1 && value === 0) {
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

  /**
   * Boot-time state evaluation pass. Playbooks normally trigger on
   * state *transitions* (e.g. running → paused_io_error). If the bad
   * state predates RHODES — Jellyfin's vm-101 was already paused with
   * io-error when RHODES started on 2026-05-12 — there's no transition
   * to observe, and the storage-pause playbook never fires.
   *
   * This pass walks every observed VM and synthesizes
   * `discovered_state_change` anomalies for VMs that are already in a
   * bad state when we boot. The synthetic anomalies have type
   * `state_change` so they match the same playbook triggers that
   * real transitions match (e.g. the storage-pause playbook keys on
   * `metric: vm_status, type: state_change, labels.reason:
   * paused_io_error`).
   *
   * Returns one anomaly per VM in a bad state. Returns an empty array
   * when everything observed is healthy. Safe to call on a populated
   * store — it does NOT seed `previousVmStatus`, so the subsequent
   * tick still sees the same baseline and won't double-fire.
   */
  evaluateInitialState(store: MetricStore): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const allVmStatus = store.getAllLatest("vm_status");
    const detectedAt = new Date().toISOString();

    for (const { value, labels } of allVmStatus) {
      const reason = labels.reason || labels.runtime_status;
      if (!reason) continue;

      // We synthesize an anomaly for any non-running runtime state that
      // has a known reason. The most important case is paused_io_error
      // (the Jellyfin incident); locked / paused_other are also worth
      // surfacing because they predate RHODES and would otherwise be
      // invisible on dashboards until a transition.
      const badStates = ["paused_io_error", "paused_other", "locked", "error"];
      if (!badStates.includes(labels.runtime_status ?? reason)) continue;

      anomalies.push({
        id: randomUUID(),
        type: "state_change",
        severity: reason === "paused_io_error" ? "critical" : "warning",
        metric: "vm_status",
        labels,
        current_value: value,
        message: `VM ${labels.name || labels.vmid} on ${labels.node} was already in ${labels.runtime_status ?? reason} state at RHODES boot — synthesizing discovered_state_change`,
        detected_at: detectedAt,
      });
    }

    return anomalies;
  }

  resolveRecoveredIncidents(store: MetricStore, activeIncidentIds: Set<string>): void {
    for (const incident of this.incidentManager.getOpen()) {
      if (activeIncidentIds.has(incident.id)) {
        continue;
      }

      const latest = store.getLatest(incident.metric, incident.labels);
      if (!latest) {
        continue;
      }

      if (latest.value < incident.trigger_value * 0.7) {
        this.incidentManager.resolve(
          incident.id,
          `Metrics returned to normal (${latest.value.toFixed(1)} < ${incident.trigger_value.toFixed(1)})`,
        );

        this.emitEvent(AgentEventType.AlertResolved, {
          incident_id: incident.id,
          metric: incident.metric,
          current_value: latest.value,
        });
      }
    }
  }

  private anomalyKey(anomaly: Anomaly): string {
    const labelString = Object.entries(anomaly.labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(",");

    return `${anomaly.type}:${anomaly.metric}:{${labelString}}`;
  }

  private labelsMatch(left: Record<string, string>, right: Record<string, string>): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => left[key] === right[key]);
  }

  private emitEvent(type: AgentEventType, data: Record<string, unknown>): void {
    this.eventBus.emit({
      type,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}
