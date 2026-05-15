import { randomUUID } from "node:crypto";
import type { EventBus } from "../agent/events.js";
import type { Anomaly } from "../monitoring/anomaly.js";
import type { MetricStore } from "../monitoring/health.js";
import { AgentEventType } from "../types.js";
import { IncidentManager } from "./incidents.js";
import type { Incident } from "./incidents.js";
import type { TicketStore, TicketRecord } from "./ticket-store.js";

const ESCALATION_THRESHOLD = 3;
const ESCALATION_WINDOW_MS = 30 * 60 * 1000;

/** Callback fired after an Incident moves to `resolved` and the
 *  corresponding Ticket row is updated. The dashboard server hooks
 *  this to (a) generate a postmortem via the LLM and (b) broadcast a
 *  `ticket_resolved` SSE event. Kept generic so tests can stub it. */
export type TicketResolvedHook = (
  ticket: TicketRecord,
  incident: Incident,
) => void | Promise<void>;

/** Callback fired when a new Incident is opened, after the Ticket
 *  row is allocated. Dashboard server uses this to post a Block Kit
 *  `ticket_opened` alert and capture the resulting `thread_ts`. */
export type TicketOpenedHook = (
  ticket: TicketRecord,
  incident: Incident,
) => void | Promise<void>;

export class IncidentCoordinator {
  readonly incidentManager: IncidentManager;
  /** Optional Ticket layer. When attached, every open/resolve/fail also
   *  updates the corresponding ticket row + fires the appropriate
   *  hook. Left undefined for cli/mcp callers that don't need
   *  ticket-mode persistence. */
  ticketStore?: TicketStore;
  ticketOpenedHook?: TicketOpenedHook;
  ticketResolvedHook?: TicketResolvedHook;

  private readonly eventBus: EventBus;
  private readonly inFlightAnomalies: Set<string> = new Set();
  private readonly escalationHistory: Map<string, number[]> = new Map();
  private readonly previousVmStatus: Map<string, number> = new Map();

  constructor(eventBus: EventBus, dataDir: string) {
    this.eventBus = eventBus;
    this.incidentManager = new IncidentManager(eventBus, dataDir);
  }

  /** Wire in a TicketStore + the open/resolve hooks. Called once by
   *  the dashboard server during startup once it knows the
   *  data-dir + LLM config. The coordinator stays useable without
   *  tickets — callers that don't wire this in get the legacy
   *  incident-only behaviour. */
  attachTicketStore(
    store: TicketStore,
    hooks: { onOpened?: TicketOpenedHook; onResolved?: TicketResolvedHook } = {},
  ): void {
    this.ticketStore = store;
    this.ticketOpenedHook = hooks.onOpened;
    this.ticketResolvedHook = hooks.onResolved;
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
    const incident = this.incidentManager.open({
      type: anomaly.type,
      severity: anomaly.severity,
      metric: anomaly.metric,
      labels: anomaly.labels,
      value: anomaly.current_value,
      description: anomaly.message,
    });
    this.handleTicketForOpened(incident);
    return incident;
  }

  /** Allocate (or look up) the Ticket for `incident`, then fire the
   *  open-hook. Hook errors are swallowed — a busted Slack/dashboard
   *  must not block incident creation. */
  private handleTicketForOpened(incident: Incident): void {
    if (!this.ticketStore) return;
    let ticket: TicketRecord;
    try {
      ticket = this.ticketStore.ensureForIncident(incident);
    } catch (err) {
      console.error("[incident-coordinator] ticketStore.ensureForIncident failed:", err);
      return;
    }
    if (!this.ticketOpenedHook) return;
    void Promise.resolve()
      .then(() => this.ticketOpenedHook?.(ticket, incident))
      .catch((err) => {
        console.error("[incident-coordinator] ticketOpenedHook failed:", err);
      });
  }

  /** Sync the Ticket row to the incident's current state and fire the
   *  resolve-hook. Called from the resolveRecoveredIncidents path
   *  immediately after `incidentManager.resolve`. */
  private handleTicketForResolved(incident: Incident): void {
    if (!this.ticketStore) return;
    let ticket: TicketRecord;
    try {
      ticket = this.ticketStore.syncFromIncident(incident);
    } catch (err) {
      console.error("[incident-coordinator] ticketStore.syncFromIncident failed:", err);
      return;
    }
    if (!this.ticketResolvedHook) return;
    void Promise.resolve()
      .then(() => this.ticketResolvedHook?.(ticket, incident))
      .catch((err) => {
        console.error("[incident-coordinator] ticketResolvedHook failed:", err);
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
    const healthyRuntimeStates = new Set(["running", "ok"]);
    const badRuntimeStates = new Set([
      "paused_io_error",
      "paused_other",
      "locked",
      "error",
    ]);

    for (const incident of this.incidentManager.getOpen()) {
      if (activeIncidentIds.has(incident.id)) {
        continue;
      }

      // ── State-change recovery path ────────────────────────────
      //
      // For vm_status state-change incidents (e.g. boot-eval synthesized
      // a discovered_state_change for a VM already paused with io-error),
      // the numeric threshold check below never fires: the recorded
      // value is just a marker (always 1 for "vm exists", 0 for stopped)
      // and `incident.trigger_value * 0.7` is never crossed. So those
      // incidents stay open forever even after the VM returns to
      // `running`. Detect that case and resolve when the latest sample
      // for the same vmid+node has a healthy runtime_status.
      const incidentReason = incident.labels.reason;
      const isStateChangeIncident =
        incident.metric === "vm_status" &&
        incident.anomaly_type === "state_change" &&
        incidentReason !== undefined &&
        badRuntimeStates.has(incidentReason);

      if (isStateChangeIncident) {
        const vmid = incident.labels.vmid;
        const node = incident.labels.node;
        if (!vmid || !node) continue;

        // Find the latest vm_status samples for this VM. We can't use
        // labels-exact getLatest() because the recovered sample no
        // longer carries `reason` / the bad runtime_status, so its
        // series key is different. Instead scan all latest-per-series
        // entries and pick the ones matching vmid+node. A VM with a
        // healthy current sample is considered recovered regardless of
        // whether the stale bad-state series is still in the 24h
        // retention window.
        const allLatest = store.getAllLatest("vm_status");
        const samplesForVm = allLatest.filter(
          (entry) => entry.labels.vmid === vmid && entry.labels.node === node,
        );
        if (samplesForVm.length === 0) continue;

        const healthySample = samplesForVm.find((entry) => {
          const rs = entry.labels.runtime_status;
          return rs !== undefined && healthyRuntimeStates.has(rs);
        });
        if (!healthySample) continue;
        const latestRuntimeStatus = healthySample.labels.runtime_status!;

        if (healthyRuntimeStates.has(latestRuntimeStatus)) {
          const before =
            incident.labels.runtime_status_before ??
            incident.labels.runtime_status ??
            incidentReason;
          const displayName = incident.labels.name || incident.labels.vmid;
          this.incidentManager.resolve(
            incident.id,
            `VM ${displayName} state recovered: ${before} → ${latestRuntimeStatus}`,
          );
          const fresh = this.incidentManager.getById(incident.id);
          if (fresh) this.handleTicketForResolved(fresh);

          this.emitEvent(AgentEventType.AlertResolved, {
            incident_id: incident.id,
            metric: incident.metric,
            current_value: healthySample.value,
            runtime_status_before: before,
            runtime_status_after: latestRuntimeStatus,
          });
        }
        continue;
      }

      // ── Numeric-threshold recovery path ───────────────────────
      const latest = store.getLatest(incident.metric, incident.labels);
      if (!latest) {
        continue;
      }

      if (latest.value < incident.trigger_value * 0.7) {
        this.incidentManager.resolve(
          incident.id,
          `Metrics returned to normal (${latest.value.toFixed(1)} < ${incident.trigger_value.toFixed(1)})`,
        );
        const fresh = this.incidentManager.getById(incident.id);
        if (fresh) this.handleTicketForResolved(fresh);

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
