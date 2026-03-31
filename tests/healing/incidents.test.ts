import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  IncidentManager,
  type Anomaly,
} from "../../src/healing/incidents.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";
import { rmSync } from "node:fs";

// ── Helpers ────────────────────────────────────────────────

let tmpDir: string;

function freshDir(): string {
  tmpDir = `/tmp/vclaw-test-incidents-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return tmpDir;
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    type: "threshold",
    severity: "critical",
    metric: "node_memory_pct",
    labels: { node: "pve1" },
    value: 95,
    description: "Node memory at 95%",
    ...overrides,
  };
}

// ── IncidentManager ────────────────────────────────────────

describe("IncidentManager", () => {
  let bus: EventBus;
  let manager: IncidentManager;
  let dataDir: string;

  beforeEach(() => {
    bus = new EventBus();
    dataDir = freshDir();
    manager = new IncidentManager(bus, dataDir);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ── open() ────────────────────────────────────────────────

  describe("open()", () => {
    it("creates an incident with correct fields", () => {
      const anomaly = makeAnomaly();
      const incident = manager.open(anomaly);

      expect(incident.id).toBeDefined();
      expect(incident.anomaly_type).toBe("threshold");
      expect(incident.severity).toBe("critical");
      expect(incident.metric).toBe("node_memory_pct");
      expect(incident.labels).toEqual({ node: "pve1" });
      expect(incident.trigger_value).toBe(95);
      expect(incident.description).toBe("Node memory at 95%");
      expect(incident.detected_at).toBeDefined();
      expect(incident.actions_taken).toEqual([]);
    });

    it('status is "open" without playbookId', () => {
      const incident = manager.open(makeAnomaly());
      expect(incident.status).toBe("open");
    });

    it('status is "healing" with playbookId', () => {
      const incident = manager.open(makeAnomaly(), "pb-123");
      expect(incident.status).toBe("healing");
      expect(incident.playbook_id).toBe("pb-123");
    });

    it('emits "incident_opened" event', () => {
      const events: unknown[] = [];
      bus.on(AgentEventType.IncidentOpened, (e) => events.push(e));

      const incident = manager.open(makeAnomaly());

      expect(events).toHaveLength(1);
      expect((events[0] as any).data.incident_id).toBe(incident.id);
      expect((events[0] as any).data.severity).toBe("critical");
    });

    it("incident is retrievable via getById()", () => {
      const incident = manager.open(makeAnomaly());
      const retrieved = manager.getById(incident.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(incident.id);
    });
  });

  // ── recordAction() ────────────────────────────────────────

  describe("recordAction()", () => {
    it("adds action to actions_taken array", () => {
      const incident = manager.open(makeAnomaly());
      manager.recordAction(incident.id, "restart_vm", true, "VM restarted");

      const updated = manager.getById(incident.id)!;
      expect(updated.actions_taken).toHaveLength(1);
      expect(updated.actions_taken[0].action).toBe("restart_vm");
      expect(updated.actions_taken[0].success).toBe(true);
      expect(updated.actions_taken[0].details).toBe("VM restarted");
    });

    it('changes status from "open" to "healing"', () => {
      const incident = manager.open(makeAnomaly());
      expect(incident.status).toBe("open");

      manager.recordAction(incident.id, "restart_vm", true);

      const updated = manager.getById(incident.id)!;
      expect(updated.status).toBe("healing");
    });

    it('emits "incident_action" event', () => {
      const events: unknown[] = [];
      bus.on(AgentEventType.IncidentAction, (e) => events.push(e));

      const incident = manager.open(makeAnomaly());
      manager.recordAction(incident.id, "restart_vm", true, "done");

      expect(events).toHaveLength(1);
      expect((events[0] as any).data.incident_id).toBe(incident.id);
      expect((events[0] as any).data.action).toBe("restart_vm");
    });
  });

  // ── resolve() ─────────────────────────────────────────────

  describe("resolve()", () => {
    it("sets status to resolved with resolved_at, resolution, duration_ms", () => {
      const incident = manager.open(makeAnomaly());
      manager.resolve(incident.id, "Memory freed by migration");

      const resolved = manager.getById(incident.id)!;
      expect(resolved.status).toBe("resolved");
      expect(resolved.resolved_at).toBeDefined();
      expect(resolved.resolution).toBe("Memory freed by migration");
      expect(resolved.duration_ms).toBeTypeOf("number");
      expect(resolved.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('emits "incident_resolved" event', () => {
      const events: unknown[] = [];
      bus.on(AgentEventType.IncidentResolved, (e) => events.push(e));

      const incident = manager.open(makeAnomaly());
      manager.resolve(incident.id, "Fixed");

      expect(events).toHaveLength(1);
      expect((events[0] as any).data.incident_id).toBe(incident.id);
      expect((events[0] as any).data.resolution).toBe("Fixed");
    });
  });

  // ── fail() ────────────────────────────────────────────────

  describe("fail()", () => {
    it('sets status to "failed"', () => {
      const incident = manager.open(makeAnomaly());
      manager.fail(incident.id, "Migration failed");

      const failed = manager.getById(incident.id)!;
      expect(failed.status).toBe("failed");
      expect(failed.resolution).toBe("Migration failed");
      expect(failed.duration_ms).toBeTypeOf("number");
    });

    it('emits "incident_failed" event', () => {
      const events: unknown[] = [];
      bus.on(AgentEventType.IncidentFailed, (e) => events.push(e));

      const incident = manager.open(makeAnomaly());
      manager.fail(incident.id, "Could not migrate");

      expect(events).toHaveLength(1);
      expect((events[0] as any).data.incident_id).toBe(incident.id);
      expect((events[0] as any).data.reason).toBe("Could not migrate");
    });
  });

  // ── getOpen() ─────────────────────────────────────────────

  describe("getOpen()", () => {
    it("returns only open and healing incidents", () => {
      const i1 = manager.open(makeAnomaly());
      const i2 = manager.open(makeAnomaly(), "pb-1"); // healing
      const i3 = manager.open(makeAnomaly());
      manager.resolve(i3.id, "done");
      const i4 = manager.open(makeAnomaly());
      manager.fail(i4.id, "nope");

      const openList = manager.getOpen();
      const openIds = openList.map((i) => i.id);

      expect(openIds).toContain(i1.id);
      expect(openIds).toContain(i2.id);
      expect(openIds).not.toContain(i3.id);
      expect(openIds).not.toContain(i4.id);
    });
  });

  // ── getRecent() ───────────────────────────────────────────

  describe("getRecent()", () => {
    it("returns most recent N incidents sorted by detected_at DESC", () => {
      vi.useFakeTimers();
      try {
        const i1 = manager.open(makeAnomaly());
        vi.advanceTimersByTime(1000);
        const i2 = manager.open(makeAnomaly());
        vi.advanceTimersByTime(1000);
        const i3 = manager.open(makeAnomaly());

        const recent = manager.getRecent(2);
        expect(recent).toHaveLength(2);
        expect(recent[0].id).toBe(i3.id);
        expect(recent[1].id).toBe(i2.id);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── findSimilar() ─────────────────────────────────────────

  describe("findSimilar()", () => {
    it("finds incidents with same metric, anomaly_type, and overlapping labels", () => {
      manager.open(
        makeAnomaly({ metric: "node_memory_pct", type: "threshold", labels: { node: "pve1" } }),
      );
      manager.open(
        makeAnomaly({ metric: "node_memory_pct", type: "threshold", labels: { node: "pve2" } }),
      );
      manager.open(
        makeAnomaly({ metric: "disk_usage_pct", type: "threshold", labels: { node: "pve1" } }),
      );

      const similar = manager.findSimilar(
        makeAnomaly({ metric: "node_memory_pct", type: "threshold", labels: { node: "pve1" } }),
      );

      // Should match first (same node label) but not third (different metric)
      // Second has different label value so no overlap on node
      expect(similar.length).toBeGreaterThanOrEqual(1);
      expect(similar.every((i) => i.metric === "node_memory_pct")).toBe(true);
      expect(similar.every((i) => i.anomaly_type === "threshold")).toBe(true);
    });

    it("does not find incidents with different metric", () => {
      manager.open(makeAnomaly({ metric: "disk_usage_pct" }));

      const similar = manager.findSimilar(makeAnomaly({ metric: "node_memory_pct" }));
      expect(similar).toHaveLength(0);
    });
  });

  // ── getTimeline() ─────────────────────────────────────────

  describe("getTimeline()", () => {
    it("returns timeline entries in chronological order", () => {
      vi.useFakeTimers();
      try {
        const incident = manager.open(makeAnomaly());
        vi.advanceTimersByTime(1000);
        manager.recordAction(incident.id, "restart_vm", true, "Restarted");
        vi.advanceTimersByTime(1000);
        manager.resolve(incident.id, "All good");

        const timeline = manager.getTimeline(incident.id);
        expect(timeline).toHaveLength(3);
        expect(timeline[0].event).toBe("detected");
        expect(timeline[1].event).toBe("action");
        expect(timeline[2].event).toBe("resolved");

        // Verify chronological order
        for (let i = 1; i < timeline.length; i++) {
          expect(
            new Date(timeline[i].timestamp).getTime(),
          ).toBeGreaterThanOrEqual(
            new Date(timeline[i - 1].timestamp).getTime(),
          );
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("includes detected, action, and resolved events", () => {
      const incident = manager.open(makeAnomaly());
      manager.recordAction(incident.id, "migrate_vm", true, "Migrated");
      manager.resolve(incident.id, "Done");

      const timeline = manager.getTimeline(incident.id);
      const eventTypes = timeline.map((t) => t.event);

      expect(eventTypes).toContain("detected");
      expect(eventTypes).toContain("action");
      expect(eventTypes).toContain("resolved");
    });

    it("includes failed event when incident failed", () => {
      const incident = manager.open(makeAnomaly());
      manager.fail(incident.id, "Could not heal");

      const timeline = manager.getTimeline(incident.id);
      const eventTypes = timeline.map((t) => t.event);
      expect(eventTypes).toContain("failed");
    });
  });

  // ── learnPatterns() ───────────────────────────────────────

  describe("learnPatterns()", () => {
    it("groups resolved incidents by type/metric/labelKeys", () => {
      const a1 = manager.open(
        makeAnomaly({ type: "threshold", metric: "node_memory_pct", labels: { node: "pve1" } }),
        "pb-mem",
      );
      manager.resolve(a1.id, "Fixed");

      const a2 = manager.open(
        makeAnomaly({ type: "threshold", metric: "node_memory_pct", labels: { node: "pve2" } }),
        "pb-mem",
      );
      manager.resolve(a2.id, "Fixed");

      const patterns = manager.learnPatterns();
      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const memPattern = patterns.find((p) =>
        p.description.includes("node_memory_pct"),
      );
      expect(memPattern).toBeDefined();
      expect(memPattern!.occurrences).toBe(2);
    });

    it("creates patterns only when 2+ incidents in a group", () => {
      const i1 = manager.open(makeAnomaly());
      manager.resolve(i1.id, "Fixed");

      const patterns = manager.learnPatterns();
      expect(patterns).toHaveLength(0);
    });

    it("pattern includes avg_resolution_ms and successful_playbook", () => {
      vi.useFakeTimers();
      try {
        const i1 = manager.open(
          makeAnomaly({ type: "threshold", metric: "node_memory_pct", labels: { node: "pve1" } }),
          "pb-mem",
        );
        vi.advanceTimersByTime(5000);
        manager.resolve(i1.id, "Fixed");

        const i2 = manager.open(
          makeAnomaly({ type: "threshold", metric: "node_memory_pct", labels: { node: "pve1" } }),
          "pb-mem",
        );
        vi.advanceTimersByTime(3000);
        manager.resolve(i2.id, "Fixed");

        const patterns = manager.learnPatterns();
        expect(patterns).toHaveLength(1);
        expect(patterns[0].avg_resolution_ms).toBeGreaterThan(0);
        expect(patterns[0].successful_playbook).toBe("pb-mem");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── suggestPlaybook() ─────────────────────────────────────

  describe("suggestPlaybook()", () => {
    it("returns playbook ID from matching pattern", () => {
      // Create 2 resolved incidents to build a pattern
      const i1 = manager.open(
        makeAnomaly({ type: "threshold", metric: "node_memory_pct", labels: { node: "pve1" } }),
        "pb-mem",
      );
      manager.resolve(i1.id, "Fixed");

      const i2 = manager.open(
        makeAnomaly({ type: "threshold", metric: "node_memory_pct", labels: { node: "pve1" } }),
        "pb-mem",
      );
      manager.resolve(i2.id, "Fixed");

      manager.learnPatterns();

      const suggestion = manager.suggestPlaybook(
        makeAnomaly({ type: "threshold", metric: "node_memory_pct", labels: { node: "pve1" } }),
      );
      expect(suggestion).toBe("pb-mem");
    });

    it("returns undefined when no pattern matches", () => {
      const suggestion = manager.suggestPlaybook(
        makeAnomaly({ type: "spike", metric: "unknown_metric" }),
      );
      expect(suggestion).toBeUndefined();
    });
  });

  // ── Persistence ───────────────────────────────────────────

  describe("persistence", () => {
    it("incidents survive across constructor calls with same dataDir", () => {
      const incident = manager.open(makeAnomaly());
      manager.recordAction(incident.id, "restart_vm", true);
      manager.resolve(incident.id, "Fixed");

      // Create a new manager with the same dataDir
      const bus2 = new EventBus();
      const manager2 = new IncidentManager(bus2, dataDir);

      const loaded = manager2.getById(incident.id);
      expect(loaded).toBeDefined();
      expect(loaded!.status).toBe("resolved");
      expect(loaded!.actions_taken).toHaveLength(1);
      expect(loaded!.resolution).toBe("Fixed");
    });
  });

  // ── Pruning ───────────────────────────────────────────────

  describe("pruning", () => {
    it("prunes to MAX_INCIDENTS (1000) when exceeded", () => {
      // Open 1005 incidents
      for (let i = 0; i < 1005; i++) {
        manager.open(
          makeAnomaly({ description: `Incident ${i}` }),
        );
      }

      // After pruning, the manager should have at most 1000 incidents
      const recent = manager.getRecent(2000);
      expect(recent.length).toBeLessThanOrEqual(1000);
    });
  });
});
