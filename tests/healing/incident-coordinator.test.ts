import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/agent/events.js";
import { IncidentCoordinator } from "../../src/healing/incident-coordinator.js";
import { MetricStore } from "../../src/monitoring/health.js";
import type { Anomaly } from "../../src/monitoring/anomaly.js";
import { AgentEventType } from "../../src/types.js";

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "anomaly-1",
    type: "threshold",
    severity: "critical",
    metric: "node_cpu_pct",
    labels: { node: "pve1" },
    current_value: 95,
    message: "Node CPU too high",
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("IncidentCoordinator", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeCoordinator() {
    const dataDir = `/tmp/vclaw-incident-coordinator-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempDirs.push(dataDir);
    const eventBus = new EventBus();
    const coordinator = new IncidentCoordinator(eventBus, dataDir);
    return { eventBus, coordinator };
  }

  it("deduplicates in-flight anomalies until released", () => {
    const { coordinator } = makeCoordinator();
    const anomaly = makeAnomaly();

    const first = coordinator.beginAnomaly(anomaly);
    const second = coordinator.beginAnomaly(anomaly);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.key).toBe(first.key);

    coordinator.endAnomaly(first.key);
    const third = coordinator.beginAnomaly(anomaly);
    expect(third.acquired).toBe(true);
  });

  it("tracks escalation threshold within a rolling 30 minute window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T00:00:00.000Z"));
    const { coordinator } = makeCoordinator();
    const key = coordinator.beginAnomaly(makeAnomaly()).key;

    coordinator.recordEscalation(key);
    coordinator.recordEscalation(key);
    expect(coordinator.shouldEscalate(key)).toBe(false);

    coordinator.recordEscalation(key);
    expect(coordinator.shouldEscalate(key)).toBe(true);

    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(coordinator.shouldEscalate(key)).toBe(false);
  });

  it("detects VM running-to-stopped transitions and uses vmid fallback in message", () => {
    const { coordinator } = makeCoordinator();
    const store = new MetricStore();

    store.record("vm_status", 1, { vmid: "200", node: "pve2" });
    expect(coordinator.detectVmStateChanges(store)).toHaveLength(0);

    store.record("vm_status", 0, { vmid: "200", node: "pve2" });
    const detected = coordinator.detectVmStateChanges(store);
    expect(detected).toHaveLength(1);
    expect(detected[0].metric).toBe("vm_status");
    expect(detected[0].message).toContain("VM 200 on pve2 stopped unexpectedly");

    store.record("vm_status", 0, { vmid: "200", node: "pve2" });
    expect(coordinator.detectVmStateChanges(store)).toHaveLength(0);
  });

  it("resolves only recovered incidents and emits alert_resolved events", () => {
    const { eventBus, coordinator } = makeCoordinator();
    const events: unknown[] = [];
    eventBus.on(AgentEventType.AlertResolved, (event) => events.push(event));

    const active = coordinator.openIncident(
      makeAnomaly({ id: "a-active", labels: { node: "active" }, current_value: 100 }),
    );
    const missing = coordinator.openIncident(
      makeAnomaly({ id: "a-missing", labels: { node: "missing" }, current_value: 100 }),
    );
    const stable = coordinator.openIncident(
      makeAnomaly({ id: "a-stable", labels: { node: "stable" }, current_value: 100 }),
    );
    const recovered = coordinator.openIncident(
      makeAnomaly({ id: "a-recovered", labels: { node: "recovered" }, current_value: 100 }),
    );

    const store = new MetricStore();
    store.record("node_cpu_pct", 90, { node: "stable" });
    store.record("node_cpu_pct", 50, { node: "recovered" });

    coordinator.resolveRecoveredIncidents(store, new Set([active.id]));

    expect(coordinator.incidentManager.getById(active.id)?.status).toBe("open");
    expect(coordinator.incidentManager.getById(missing.id)?.status).toBe("open");
    expect(coordinator.incidentManager.getById(stable.id)?.status).toBe("open");
    expect(coordinator.incidentManager.getById(recovered.id)?.status).toBe("resolved");
    expect(events).toHaveLength(1);
    expect((events[0] as { data: { incident_id: string } }).data.incident_id).toBe(recovered.id);
  });

  it("matches open incidents only when labels fully match", () => {
    const { coordinator } = makeCoordinator();
    coordinator.openIncident(
      makeAnomaly({ id: "existing", metric: "vm_status", labels: { node: "pve1", vmid: "101" } }),
    );

    expect(
      coordinator.findOpenIncident(
        makeAnomaly({ metric: "vm_status", labels: { node: "pve1", vmid: "101" } }),
      ),
    ).toBeDefined();

    expect(
      coordinator.findOpenIncident(
        makeAnomaly({ metric: "vm_status", labels: { node: "pve1", vmid: "101", name: "web-01" } }),
      ),
    ).toBeUndefined();

    expect(
      coordinator.findOpenIncident(
        makeAnomaly({ metric: "vm_status", labels: { node: "pve1", vmid: "999" } }),
      ),
    ).toBeUndefined();
  });
});
