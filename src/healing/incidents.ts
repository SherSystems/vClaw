import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "../agent/events.js";

// ── Types ───────────────────────────────────────────────────

export interface ActionRecord {
  action: string;
  timestamp: string;
  success: boolean;
  details?: string;
}

export interface Incident {
  id: string;
  anomaly_type: string;
  severity: "warning" | "critical";
  metric: string;
  labels: Record<string, string>;
  detected_at: string;
  resolved_at?: string;
  status: "open" | "healing" | "resolved" | "failed";
  trigger_value: number;
  description: string;
  playbook_id?: string;
  actions_taken: ActionRecord[];
  resolution?: string;
  duration_ms?: number;
  root_cause?: string;
  pattern_id?: string;
}

export interface IncidentPattern {
  id: string;
  description: string;
  occurrences: number;
  last_seen: string;
  avg_resolution_ms: number;
  successful_playbook?: string;
  labels_pattern: Record<string, string>;
}

export interface Anomaly {
  type: string;
  severity: "warning" | "critical";
  metric: string;
  labels: Record<string, string>;
  value: number;
  description: string;
}

export interface TimelineEntry {
  timestamp: string;
  event: "detected" | "action" | "resolved" | "failed";
  detail: string;
  success?: boolean;
}

// ── Constants ───────────────────────────────────────────────

const MAX_INCIDENTS = 1000;
const INCIDENTS_FILE = "incidents.json";
const PATTERNS_FILE = "patterns.json";

// ── IncidentManager ─────────────────────────────────────────

export class IncidentManager {
  private incidents: Map<string, Incident> = new Map();
  private patterns: Map<string, IncidentPattern> = new Map();
  private bus: EventBus;
  private dataDir: string;

  constructor(bus: EventBus, dataDir: string) {
    this.bus = bus;
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  open(anomaly: Anomaly, playbookId?: string): Incident {
    const now = new Date().toISOString();
    const incident: Incident = {
      id: randomUUID(),
      anomaly_type: anomaly.type,
      severity: anomaly.severity,
      metric: anomaly.metric,
      labels: { ...anomaly.labels },
      detected_at: now,
      status: playbookId ? "healing" : "open",
      trigger_value: anomaly.value,
      description: anomaly.description,
      playbook_id: playbookId,
      actions_taken: [],
    };

    this.incidents.set(incident.id, incident);
    this.prune();
    this.persist();

    this.bus.emit({
      type: "incident_opened",
      timestamp: now,
      data: {
        incident_id: incident.id,
        anomaly_type: incident.anomaly_type,
        severity: incident.severity,
        metric: incident.metric,
        labels: incident.labels,
        trigger_value: incident.trigger_value,
        description: incident.description,
        playbook_id: playbookId,
      },
    });

    return incident;
  }

  recordAction(
    incidentId: string,
    action: string,
    success: boolean,
    details?: string,
  ): void {
    const incident = this.requireIncident(incidentId);
    const now = new Date().toISOString();

    const record: ActionRecord = { action, timestamp: now, success, details };
    incident.actions_taken.push(record);

    if (incident.status === "open") {
      incident.status = "healing";
    }

    this.persist();

    this.bus.emit({
      type: "incident_action",
      timestamp: now,
      data: {
        incident_id: incidentId,
        action,
        success,
        details,
      },
    });
  }

  resolve(incidentId: string, resolution: string): void {
    const incident = this.requireIncident(incidentId);
    const now = new Date().toISOString();

    incident.status = "resolved";
    incident.resolved_at = now;
    incident.resolution = resolution;
    incident.duration_ms =
      new Date(now).getTime() - new Date(incident.detected_at).getTime();

    this.persist();

    this.bus.emit({
      type: "incident_resolved",
      timestamp: now,
      data: {
        incident_id: incidentId,
        resolution,
        duration_ms: incident.duration_ms,
        actions_count: incident.actions_taken.length,
      },
    });
  }

  fail(incidentId: string, reason: string): void {
    const incident = this.requireIncident(incidentId);
    const now = new Date().toISOString();

    incident.status = "failed";
    incident.resolved_at = now;
    incident.resolution = reason;
    incident.duration_ms =
      new Date(now).getTime() - new Date(incident.detected_at).getTime();

    this.persist();

    this.bus.emit({
      type: "incident_failed",
      timestamp: now,
      data: {
        incident_id: incidentId,
        reason,
        duration_ms: incident.duration_ms,
        actions_count: incident.actions_taken.length,
      },
    });
  }

  getOpen(): Incident[] {
    return this.allIncidents().filter(
      (i) => i.status === "open" || i.status === "healing",
    );
  }

  getRecent(count: number): Incident[] {
    return this.allIncidents()
      .sort(
        (a, b) =>
          new Date(b.detected_at).getTime() -
          new Date(a.detected_at).getTime(),
      )
      .slice(0, count);
  }

  getById(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  findSimilar(anomaly: Anomaly): Incident[] {
    return this.allIncidents().filter((i) => {
      if (i.metric !== anomaly.metric || i.anomaly_type !== anomaly.type) {
        return false;
      }
      return this.labelsOverlap(i.labels, anomaly.labels);
    });
  }

  // ── Pattern Learning ────────────────────────────────────────

  learnPatterns(): IncidentPattern[] {
    const resolved = this.allIncidents().filter(
      (i) => i.status === "resolved",
    );

    const groups = new Map<string, Incident[]>();
    for (const incident of resolved) {
      const key = this.patternKey(incident);
      const group = groups.get(key) ?? [];
      group.push(incident);
      groups.set(key, group);
    }

    const learned: IncidentPattern[] = [];
    for (const [key, incidents] of groups) {
      if (incidents.length < 2) continue;

      const durations = incidents
        .map((i) => i.duration_ms)
        .filter((d): d is number => d !== undefined);
      const avgDuration =
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0;

      const playbookCounts = new Map<string, number>();
      for (const i of incidents) {
        if (i.playbook_id) {
          playbookCounts.set(
            i.playbook_id,
            (playbookCounts.get(i.playbook_id) ?? 0) + 1,
          );
        }
      }

      let bestPlaybook: string | undefined;
      let bestCount = 0;
      for (const [pbId, count] of playbookCounts) {
        if (count > bestCount) {
          bestPlaybook = pbId;
          bestCount = count;
        }
      }

      const latest = incidents.sort(
        (a, b) =>
          new Date(b.detected_at).getTime() -
          new Date(a.detected_at).getTime(),
      )[0];

      const commonLabels = this.commonLabels(incidents);

      const existing = this.findPatternByKey(key);
      const pattern: IncidentPattern = {
        id: existing?.id ?? randomUUID(),
        description: `${incidents[0].anomaly_type} on ${incidents[0].metric}`,
        occurrences: incidents.length,
        last_seen: latest.detected_at,
        avg_resolution_ms: Math.round(avgDuration),
        successful_playbook: bestPlaybook,
        labels_pattern: commonLabels,
      };

      this.patterns.set(pattern.id, pattern);
      learned.push(pattern);

      for (const i of incidents) {
        i.pattern_id = pattern.id;
      }
    }

    this.persistPatterns();
    this.persist();
    return learned;
  }

  suggestPlaybook(anomaly: Anomaly): string | undefined {
    for (const pattern of this.patterns.values()) {
      if (!pattern.successful_playbook) continue;
      const descParts = pattern.description.split(" on ");
      if (descParts.length < 2) continue;
      const [pType, pMetric] = descParts;
      if (pType !== anomaly.type || pMetric !== anomaly.metric) continue;
      if (this.labelsOverlap(pattern.labels_pattern, anomaly.labels)) {
        return pattern.successful_playbook;
      }
    }
    return undefined;
  }

  getPatterns(): IncidentPattern[] {
    return [...this.patterns.values()];
  }

  // ── Timeline ──────────────────────────────────────────────

  getTimeline(incidentId: string): TimelineEntry[] {
    const incident = this.requireIncident(incidentId);
    const entries: TimelineEntry[] = [];

    entries.push({
      timestamp: incident.detected_at,
      event: "detected",
      detail: incident.description,
    });

    for (const action of incident.actions_taken) {
      entries.push({
        timestamp: action.timestamp,
        event: "action",
        detail: action.details ?? action.action,
        success: action.success,
      });
    }

    if (incident.status === "resolved" && incident.resolved_at) {
      entries.push({
        timestamp: incident.resolved_at,
        event: "resolved",
        detail: incident.resolution ?? "Resolved",
      });
    } else if (incident.status === "failed" && incident.resolved_at) {
      entries.push({
        timestamp: incident.resolved_at,
        event: "failed",
        detail: incident.resolution ?? "Failed",
      });
    }

    return entries.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  // ── Internal ──────────────────────────────────────────────

  private requireIncident(id: string): Incident {
    const incident = this.incidents.get(id);
    if (!incident) {
      throw new Error(`Incident not found: ${id}`);
    }
    return incident;
  }

  private allIncidents(): Incident[] {
    return [...this.incidents.values()];
  }

  private patternKey(incident: Incident): string {
    const labelKeys = Object.keys(incident.labels).sort().join(",");
    return `${incident.anomaly_type}::${incident.metric}::${labelKeys}`;
  }

  private findPatternByKey(key: string): IncidentPattern | undefined {
    const [type, metric] = key.split("::");
    for (const p of this.patterns.values()) {
      if (p.description === `${type} on ${metric}`) return p;
    }
    return undefined;
  }

  private labelsOverlap(
    a: Record<string, string>,
    b: Record<string, string>,
  ): boolean {
    const keysA = Object.keys(a);
    if (keysA.length === 0) return true;
    return keysA.some((k) => b[k] !== undefined && b[k] === a[k]);
  }

  private commonLabels(incidents: Incident[]): Record<string, string> {
    if (incidents.length === 0) return {};
    const first = incidents[0].labels;
    const common: Record<string, string> = {};
    for (const [k, v] of Object.entries(first)) {
      if (incidents.every((i) => i.labels[k] === v)) {
        common[k] = v;
      }
    }
    return common;
  }

  private prune(): void {
    if (this.incidents.size <= MAX_INCIDENTS) return;

    const sorted = this.allIncidents().sort(
      (a, b) =>
        new Date(a.detected_at).getTime() - new Date(b.detected_at).getTime(),
    );

    const toRemove = sorted.slice(0, sorted.length - MAX_INCIDENTS);
    for (const incident of toRemove) {
      this.incidents.delete(incident.id);
    }
  }

  // ── Persistence ───────────────────────────────────────────

  private persist(): void {
    const path = join(this.dataDir, INCIDENTS_FILE);
    try {
      const data = JSON.stringify(this.allIncidents(), null, 2);
      writeFileSync(path, data, "utf-8");
    } catch (err) {
      console.error("Failed to persist incidents:", err);
    }
  }

  private persistPatterns(): void {
    const path = join(this.dataDir, PATTERNS_FILE);
    try {
      const data = JSON.stringify([...this.patterns.values()], null, 2);
      writeFileSync(path, data, "utf-8");
    } catch (err) {
      console.error("Failed to persist patterns:", err);
    }
  }

  private load(): void {
    this.loadIncidents();
    this.loadPatterns();
  }

  private loadIncidents(): void {
    const path = join(this.dataDir, INCIDENTS_FILE);
    try {
      const raw = readFileSync(path, "utf-8");
      const items: Incident[] = JSON.parse(raw);
      for (const item of items) {
        this.incidents.set(item.id, item);
      }
    } catch {
      // No existing file or corrupt — start fresh
    }
  }

  private loadPatterns(): void {
    const path = join(this.dataDir, PATTERNS_FILE);
    try {
      const raw = readFileSync(path, "utf-8");
      const items: IncidentPattern[] = JSON.parse(raw);
      for (const item of items) {
        this.patterns.set(item.id, item);
      }
    } catch {
      // No existing file or corrupt — start fresh
    }
  }
}
