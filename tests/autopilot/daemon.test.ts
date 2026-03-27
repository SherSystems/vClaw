import { describe, it, expect, vi, beforeEach } from "vitest";
import { AutopilotDaemon } from "../../src/autopilot/daemon.js";
import { EventBus } from "../../src/agent/events.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import type { GovernanceEngine } from "../../src/governance/index.js";
import type { ClusterState, NodeInfo, VMInfo, StorageInfo } from "../../src/types.js";

// ── Helpers ──────────────────────────────────────────────────

function makeNode(overrides?: Partial<NodeInfo>): NodeInfo {
  return {
    id: "node1",
    name: "pve1",
    status: "online",
    cpu_cores: 8,
    cpu_usage_pct: 20,
    ram_total_mb: 32768,
    ram_used_mb: 8000,
    disk_total_gb: 500,
    disk_used_gb: 100,
    disk_usage_pct: 20,
    uptime_s: 86400,
    ...overrides,
  };
}

function makeVm(overrides?: Partial<VMInfo>): VMInfo {
  return {
    id: 100,
    name: "test-vm",
    node: "pve1",
    status: "running",
    cpu_cores: 2,
    ram_mb: 2048,
    disk_gb: 32,
    ...overrides,
  };
}

function makeStorage(overrides?: Partial<StorageInfo>): StorageInfo {
  return {
    id: "local-lvm",
    node: "pve1",
    type: "lvmthin",
    total_gb: 500,
    used_gb: 100,
    available_gb: 400,
    content: ["images", "rootdir"],
    ...overrides,
  };
}

function makeClusterState(overrides?: Partial<ClusterState>): ClusterState {
  return {
    adapter: "test",
    nodes: [],
    vms: [],
    containers: [],
    storage: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function createMockToolRegistry(
  state: ClusterState | null = makeClusterState(),
): ToolRegistry {
  return {
    getClusterState: vi.fn().mockResolvedValue(state),
    execute: vi.fn().mockResolvedValue({ success: true }),
    getAllTools: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistry;
}

function createMockGovernance(): GovernanceEngine {
  return {
    evaluate: vi.fn().mockResolvedValue({ allowed: true, reason: "auto" }),
    circuitBreaker: { isTripped: vi.fn().mockReturnValue(false) },
  } as unknown as GovernanceEngine;
}

// ── Tests ────────────────────────────────────────────────────

describe("AutopilotDaemon", () => {
  let eventBus: EventBus;
  let toolRegistry: ToolRegistry;
  let governance: GovernanceEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    toolRegistry = createMockToolRegistry();
    governance = createMockGovernance();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── start / stop ─────────────────────────────────────────

  describe("start / stop", () => {
    it("start() begins the polling loop", () => {
      const daemon = new AutopilotDaemon(toolRegistry, governance, eventBus);
      daemon.start();
      // Should have called getClusterState once (immediate first poll)
      expect(toolRegistry.getClusterState).toHaveBeenCalled();
      daemon.stop();
    });

    it("stop() stops the daemon", () => {
      const daemon = new AutopilotDaemon(toolRegistry, governance, eventBus);
      daemon.start();
      daemon.stop();
      // Calling stop again is safe (idempotent)
      daemon.stop();
    });

    it("does not start when config.enabled is false", () => {
      const daemon = new AutopilotDaemon(toolRegistry, governance, eventBus, {
        enabled: false,
      });
      daemon.start();
      expect(toolRegistry.getClusterState).not.toHaveBeenCalled();
    });

    it("start() is idempotent when called twice", () => {
      const daemon = new AutopilotDaemon(toolRegistry, governance, eventBus);
      daemon.start();
      daemon.start();
      // Only one immediate poll should have fired
      expect(toolRegistry.getClusterState).toHaveBeenCalledTimes(1);
      daemon.stop();
    });
  });

  // ── getAlerts ────────────────────────────────────────────

  describe("getAlerts()", () => {
    it("returns an empty array initially", () => {
      const daemon = new AutopilotDaemon(toolRegistry, governance, eventBus);
      expect(daemon.getAlerts()).toEqual([]);
    });

    it("returns alerts in reverse order (most recent first)", async () => {
      // Trigger alerts by having getClusterState fail
      const failingRegistry = {
        ...createMockToolRegistry(),
        getClusterState: vi
          .fn()
          .mockRejectedValueOnce(new Error("fail-1"))
          .mockRejectedValueOnce(new Error("fail-2"))
          .mockResolvedValue(makeClusterState()),
      } as unknown as ToolRegistry;

      const daemon = new AutopilotDaemon(failingRegistry, governance, eventBus, {
        pollIntervalMs: 1000,
      });
      daemon.start();

      // Wait for first poll
      await vi.advanceTimersByTimeAsync(0);
      // Wait for second poll
      await vi.advanceTimersByTimeAsync(1000);

      daemon.stop();

      const alerts = daemon.getAlerts();
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      // Most recent first: the second alert's message should mention fail-2
      expect(alerts[0].message).toContain("fail-2");
      expect(alerts[1].message).toContain("fail-1");
    });
  });

  // ── getHealthChecks ──────────────────────────────────────

  describe("getHealthChecks()", () => {
    it("returns an empty array before any poll", () => {
      const daemon = new AutopilotDaemon(toolRegistry, governance, eventBus);
      expect(daemon.getHealthChecks()).toEqual([]);
    });

    it("returns health check results after a poll", async () => {
      const registry = createMockToolRegistry(
        makeClusterState({
          nodes: [makeNode()],
          vms: [makeVm()],
          storage: [makeStorage()],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      const checks = daemon.getHealthChecks();
      expect(checks.length).toBe(3); // 1 node + 1 VM + 1 storage
    });
  });

  // ── Health check: healthy node ───────────────────────────

  describe("health checks - node status", () => {
    it("marks an online node with low resources as healthy", async () => {
      const registry = createMockToolRegistry(
        makeClusterState({
          nodes: [makeNode({ cpu_usage_pct: 20, ram_used_mb: 8000, ram_total_mb: 32768 })],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      const checks = daemon.getHealthChecks();
      const nodeCheck = checks.find((c) => c.target.startsWith("node/"));
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck!.status).toBe("healthy");
    });

    it("marks an offline node as unhealthy", async () => {
      const registry = createMockToolRegistry(
        makeClusterState({
          nodes: [makeNode({ status: "offline" })],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      const checks = daemon.getHealthChecks();
      const nodeCheck = checks.find((c) => c.target.startsWith("node/"));
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck!.status).toBe("unhealthy");
      expect(nodeCheck!.message).toContain("offline");
    });

    it("marks a node with high RAM or CPU as degraded", async () => {
      // RAM at ~91.5% and CPU at 30% -> triggers the >90 ram branch -> degraded
      const registry = createMockToolRegistry(
        makeClusterState({
          nodes: [makeNode({ ram_used_mb: 30000, ram_total_mb: 32768, cpu_usage_pct: 30 })],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      const checks = daemon.getHealthChecks();
      const nodeCheck = checks.find((c) => c.target.startsWith("node/"));
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck!.status).toBe("degraded");
    });
  });

  // ── Health check: VM status ──────────────────────────────

  describe("health checks - VM status", () => {
    it("marks a VM with unknown status as unhealthy", async () => {
      const registry = createMockToolRegistry(
        makeClusterState({
          vms: [makeVm({ status: "unknown" })],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      const checks = daemon.getHealthChecks();
      const vmCheck = checks.find((c) => c.target.startsWith("vm/"));
      expect(vmCheck).toBeDefined();
      expect(vmCheck!.status).toBe("unhealthy");
    });

    it("marks a paused VM as degraded", async () => {
      const registry = createMockToolRegistry(
        makeClusterState({
          vms: [makeVm({ status: "paused" })],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      const checks = daemon.getHealthChecks();
      const vmCheck = checks.find((c) => c.target.startsWith("vm/"));
      expect(vmCheck).toBeDefined();
      expect(vmCheck!.status).toBe("degraded");
    });
  });

  // ── Health check: storage ────────────────────────────────

  describe("health checks - storage", () => {
    it("marks storage above 95% as unhealthy", async () => {
      const registry = createMockToolRegistry(
        makeClusterState({
          storage: [makeStorage({ total_gb: 500, used_gb: 490, available_gb: 10 })],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      const checks = daemon.getHealthChecks();
      const storageCheck = checks.find((c) => c.target.startsWith("storage/"));
      expect(storageCheck).toBeDefined();
      expect(storageCheck!.status).toBe("unhealthy");
    });

    it("marks storage above 85% as degraded", async () => {
      const registry = createMockToolRegistry(
        makeClusterState({
          storage: [makeStorage({ total_gb: 500, used_gb: 450, available_gb: 50 })],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      const checks = daemon.getHealthChecks();
      const storageCheck = checks.find((c) => c.target.startsWith("storage/"));
      expect(storageCheck).toBeDefined();
      expect(storageCheck!.status).toBe("degraded");
    });
  });

  // ── Health check emits event ─────────────────────────────

  describe("health check events", () => {
    it("emits a health_check event with counts", async () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      eventBus.on("health_check", (e) => events.push(e));

      const registry = createMockToolRegistry(
        makeClusterState({
          nodes: [makeNode(), makeNode({ id: "node2", name: "pve2", status: "offline" })],
          vms: [makeVm()],
          storage: [makeStorage()],
        }),
      );

      const daemon = new AutopilotDaemon(registry, governance, eventBus);
      daemon.start();
      await vi.advanceTimersByTimeAsync(0);
      daemon.stop();

      expect(events).toHaveLength(1);
      const data = events[0].data;
      expect(data.total).toBe(4); // 2 nodes + 1 VM + 1 storage
      expect(data.unhealthy).toBe(1); // offline node
      expect(typeof data.healthy).toBe("number");
      expect(typeof data.degraded).toBe("number");
    });
  });
});
