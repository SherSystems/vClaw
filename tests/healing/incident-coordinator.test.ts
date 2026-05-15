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
    const dataDir = `/tmp/rhodes-incident-coordinator-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  it("does not flap-fire state-change anomalies when a stale series sits alongside a fresh one", async () => {
    // Regression: a single VM with two series in retention (e.g.
    // labels.runtime_status="stopped" stale, labels.runtime_status="running"
    // fresh) used to flap previousVmStatus between 1 and 0 every tick
    // because both samples were iterated. Coalescing by (vmid, node) →
    // pick freshest fixes the loop. Caught during v0.5.0 Jellyfin live
    // demo on 2026-05-15 (RHODES-2026-004..007+ DM spam).
    const { coordinator } = makeCoordinator();
    const store = new MetricStore();

    // First, a stale stopped sample (the "old" series).
    store.record("vm_status", 0, {
      vmid: "101",
      node: "pranavlab",
      name: "JellyFinServer",
      runtime_status: "stopped",
    });
    // Slight delay so the running sample's timestamp strictly beats the
    // stopped one — coalesce relies on `>` not `>=`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Fresh running sample (separate series because runtime_status differs).
    store.record("vm_status", 1, {
      vmid: "101",
      node: "pranavlab",
      name: "JellyFinServer",
      runtime_status: "running",
    });

    // First tick: VM coalesces to running (freshest = value 1). No
    // transition, no anomaly. previousVmStatus["101|pranavlab|JellyFinServer"]
    // = 1.
    expect(coordinator.detectVmStateChanges(store)).toHaveLength(0);

    // Subsequent ticks with no new samples — must stay quiet, NOT flap
    // back to 0 because of the still-present stale stopped series.
    for (let i = 0; i < 5; i++) {
      expect(coordinator.detectVmStateChanges(store)).toHaveLength(0);
    }
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

  it("resolves state_change incident when latest sample shows healthy runtime_status", () => {
    const { eventBus, coordinator } = makeCoordinator();
    const events: { type: string; data: Record<string, unknown> }[] = [];
    eventBus.on(AgentEventType.AlertResolved, (event) =>
      events.push(event as { type: string; data: Record<string, unknown> }),
    );

    const store = new MetricStore();
    // Seed the store with the bad state first (this is what boot-eval saw).
    store.record("vm_status", 1, {
      vmid: "210",
      node: "pve1",
      name: "ninja-bot",
      runtime_status: "paused_io_error",
      reason: "paused_io_error",
    });

    // Synthesize the boot-eval anomaly from the bad-state sample and open
    // an incident from it — matches the real `evaluateInitialState` flow.
    const [boot] = coordinator.evaluateInitialState(store);
    expect(boot).toBeDefined();
    expect(boot.type).toBe("state_change");
    expect(boot.labels.reason).toBe("paused_io_error");
    const incident = coordinator.openIncident(boot);
    expect(incident.status).toBe("open");

    // The numeric-threshold recovery path would never fire for this
    // incident because vm_status's value is just a 1/0 marker, not a
    // metric. Now the VM recovers to running — push a fresh sample.
    store.record("vm_status", 1, {
      vmid: "210",
      node: "pve1",
      name: "ninja-bot",
      runtime_status: "running",
    });

    coordinator.resolveRecoveredIncidents(store, new Set());

    const updated = coordinator.incidentManager.getById(incident.id);
    expect(updated?.status).toBe("resolved");
    expect(updated?.resolution).toContain("ninja-bot");
    expect(updated?.resolution).toContain("paused_io_error");
    expect(updated?.resolution).toContain("running");
    expect(updated?.resolution).toContain("state recovered");

    expect(events).toHaveLength(1);
    expect(events[0].data.incident_id).toBe(incident.id);
    expect(events[0].data.runtime_status_before).toBe("paused_io_error");
    expect(events[0].data.runtime_status_after).toBe("running");
  });

  it("resolves running→stopped (threshold-typed) incident when latest sample shows runtime_status=running", () => {
    // Regression: the live state-change detector emits anomaly_type
    // "threshold" (not "state_change") for running→stopped, and for
    // a cleanly-stopped VM `labels.reason` is absent — only
    // `labels.runtime_status: "stopped"` is set. Both used to make
    // resolveRecoveredIncidents skip these incidents and leave the
    // dashboard stuck in HEALING forever. See v0.5.0 Jellyfin demo
    // 2026-05-15.
    const { eventBus, coordinator } = makeCoordinator();
    const events: { type: string; data: Record<string, unknown> }[] = [];
    eventBus.on(AgentEventType.AlertResolved, (event) =>
      events.push(event as { type: string; data: Record<string, unknown> }),
    );

    const store = new MetricStore();
    // Live running→stopped transition: value=0, runtime_status="stopped",
    // NO reason label (matches what health.ts emits for plain stopped).
    store.record("vm_status", 0, {
      vmid: "101",
      node: "pranavlab",
      name: "JellyFinServer",
      runtime_status: "stopped",
    });
    const incident = coordinator.openIncident({
      id: "anomaly-stopped",
      type: "threshold",
      severity: "critical",
      metric: "vm_status",
      labels: {
        vmid: "101",
        node: "pranavlab",
        name: "JellyFinServer",
        runtime_status: "stopped",
      },
      current_value: 0,
      message: "VM JellyFinServer on pranavlab stopped unexpectedly",
      detected_at: new Date().toISOString(),
    });
    expect(incident.status).toBe("open");
    expect(incident.anomaly_type).toBe("threshold");

    // VM comes back to running.
    store.record("vm_status", 1, {
      vmid: "101",
      node: "pranavlab",
      name: "JellyFinServer",
      runtime_status: "running",
    });

    coordinator.resolveRecoveredIncidents(store, new Set());

    const updated = coordinator.incidentManager.getById(incident.id);
    expect(updated?.status).toBe("resolved");
    expect(updated?.resolution).toContain("JellyFinServer");
    expect(updated?.resolution).toContain("stopped");
    expect(updated?.resolution).toContain("running");
    expect(updated?.resolution).toContain("state recovered");

    expect(events).toHaveLength(1);
    expect(events[0].data.runtime_status_before).toBe("stopped");
    expect(events[0].data.runtime_status_after).toBe("running");
  });

  it("keeps state_change incident open when latest sample still shows the bad runtime_status", () => {
    const { eventBus, coordinator } = makeCoordinator();
    const events: unknown[] = [];
    eventBus.on(AgentEventType.AlertResolved, (event) => events.push(event));

    const store = new MetricStore();
    store.record("vm_status", 1, {
      vmid: "210",
      node: "pve1",
      name: "ninja-bot",
      runtime_status: "paused_io_error",
      reason: "paused_io_error",
    });
    const [boot] = coordinator.evaluateInitialState(store);
    const incident = coordinator.openIncident(boot);

    // Same bad state on the next poll → still paused.
    store.record("vm_status", 1, {
      vmid: "210",
      node: "pve1",
      name: "ninja-bot",
      runtime_status: "paused_io_error",
      reason: "paused_io_error",
    });

    coordinator.resolveRecoveredIncidents(store, new Set());

    expect(coordinator.incidentManager.getById(incident.id)?.status).toBe(
      "open",
    );
    expect(events).toHaveLength(0);
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
