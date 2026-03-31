import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentEventType } from "../../src/types.js";

const { metricStoreRecordMock } = vi.hoisted(() => ({
  metricStoreRecordMock: vi.fn(),
}));

vi.mock("../../src/monitoring/metric-store.js", () => ({
  metricStore: {
    record: metricStoreRecordMock,
  },
}));

import { HealthMonitor } from "../../src/monitoring/health.js";

const GiB = 1024 * 1024 * 1024;

describe("HealthMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("collects node/vm metrics, persists node resources, and emits health summary", async () => {
    const execute = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      switch (tool) {
        case "list_nodes":
          return {
            success: true,
            data: [
              {
                node: "pve1",
                status: "online",
                cpu: 0.5,
                maxcpu: 8,
                maxmem: 16 * GiB,
                mem: 8 * GiB,
                uptime: 3600,
              },
              {
                node: "pve2",
                status: "offline",
                cpu: 0.75,
                maxcpu: 4,
                maxmem: 8 * GiB,
                mem: 2 * GiB,
                uptime: 120,
              },
            ],
          };
        case "get_node_stats":
          if (args.node === "pve1") {
            return {
              success: true,
              data: {
                swap: { total: 2 * GiB, used: 1 * GiB },
                rootfs: { total: 100 * GiB, used: 40 * GiB },
                loadavg: [1.2, 0.8, 0.5],
              },
            };
          }
          return { success: false, data: null };
        case "list_vms":
          return {
            success: true,
            data: [
              { vmid: 101, node: "pve1", name: "web", status: "running" },
              { vmid: 102, node: "pve1", name: "db", status: "stopped" },
              { vmid: 103, node: "pve2", name: "cache", status: "paused" },
            ],
          };
        case "get_vm_status":
          if (args.node === "pve1" && args.vmid === 101) {
            return {
              success: true,
              data: {
                cpu: 0.25,
                maxmem: 4 * GiB,
                mem: 2 * GiB,
                diskread: 123,
                diskwrite: 456,
                netin: 789,
                netout: 1000,
                uptime: 88,
              },
            };
          }
          return { success: false, data: null };
        default:
          throw new Error(`Unexpected tool call: ${tool}`);
      }
    });

    const monitor = new HealthMonitor(
      { execute } as any,
      { emit: vi.fn() } as any,
    );
    const emit = (monitor as any).events.emit as ReturnType<typeof vi.fn>;

    await monitor.collect();

    expect(execute).toHaveBeenCalledWith("list_nodes", {});
    expect(execute).toHaveBeenCalledWith("list_vms", {});
    expect(execute).toHaveBeenCalledWith("get_node_stats", { node: "pve1" });
    expect(execute).toHaveBeenCalledWith("get_vm_status", { node: "pve1", vmid: 101 });

    expect(metricStoreRecordMock).toHaveBeenCalledWith("pve1", "node_cpu_pct", 50);
    expect(metricStoreRecordMock).toHaveBeenCalledWith("pve2", "node_cpu_pct", 75);
    expect(metricStoreRecordMock).toHaveBeenCalledWith("pve1", "node_mem_pct", 50);
    expect(metricStoreRecordMock).toHaveBeenCalledWith("pve1", "node_disk_pct", 40);

    expect(emit).toHaveBeenCalledTimes(2);
    const emittedEvents = emit.mock.calls.map((c) => c[0]);
    const metricEvent = emittedEvents.find(
      (e) => e.type === AgentEventType.MetricRecorded,
    );
    const healthEvent = emittedEvents.find(
      (e) => e.type === AgentEventType.HealthCheck,
    );

    expect(metricEvent).toBeDefined();
    expect((metricEvent as any).data.count).toBe(21);
    expect(((metricEvent as any).data.metrics as unknown[]).length).toBe(21);

    expect(healthEvent).toBeDefined();
    expect((healthEvent as any).data.nodes).toEqual({
      total: 2,
      online: 1,
      offline: 1,
    });
    expect((healthEvent as any).data.vms).toEqual({
      total: 3,
      running: 1,
      stopped: 1,
      paused: 1,
    });
    expect((healthEvent as any).data.unhealthy_nodes).toEqual(["pve2"]);
    expect((healthEvent as any).data.resources).toMatchObject({
      cpu_cores_total: 12,
      cpu_usage_pct: 50,
      ram_total_mb: 24576,
      ram_used_mb: 10240,
      ram_usage_pct: 41.67,
      disk_total_gb: 100,
      disk_used_gb: 40,
      disk_usage_pct: 40,
    });
  });

  it("emits only health summary when provider listing tools fail", async () => {
    const execute = vi.fn(async (tool: string) => {
      if (tool === "list_nodes" || tool === "list_vms") {
        return { success: false, data: null };
      }
      throw new Error(`Unexpected tool call: ${tool}`);
    });

    const monitor = new HealthMonitor(
      { execute } as any,
      { emit: vi.fn() } as any,
    );
    const emit = (monitor as any).events.emit as ReturnType<typeof vi.fn>;

    await monitor.collect();

    expect(metricStoreRecordMock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: AgentEventType.HealthCheck }),
    );
  });

  it("continues collection when node/vm detail fetches throw", async () => {
    const execute = vi.fn(async (tool: string) => {
      if (tool === "list_nodes") {
        return {
          success: true,
          data: [{ node: "pve1", status: "online", cpu: 0.2, maxcpu: 2, maxmem: GiB, mem: GiB / 2 }],
        };
      }
      if (tool === "get_node_stats") {
        throw new Error("node detail timeout");
      }
      if (tool === "list_vms") {
        return {
          success: true,
          data: [{ vmid: 200, node: "pve1", status: "running" }],
        };
      }
      if (tool === "get_vm_status") {
        throw new Error("vm detail timeout");
      }
      throw new Error(`Unexpected tool call: ${tool}`);
    });

    const monitor = new HealthMonitor(
      { execute } as any,
      { emit: vi.fn() } as any,
    );
    const emit = (monitor as any).events.emit as ReturnType<typeof vi.fn>;

    await monitor.collect();

    const metricEvent = emit.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === AgentEventType.MetricRecorded);

    expect(metricEvent).toBeDefined();
    expect((metricEvent as any).data.count).toBe(4);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: AgentEventType.HealthCheck }),
    );
  });

  it("start() avoids double-start and stop() halts interval collection", async () => {
    vi.useFakeTimers();

    const monitor = new HealthMonitor(
      { execute: vi.fn() } as any,
      { emit: vi.fn() } as any,
    );
    const collectSpy = vi.spyOn(monitor, "collect").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});

    monitor.start(1000);
    monitor.start(1000);

    await Promise.resolve();
    expect(collectSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2500);
    expect(collectSpy).toHaveBeenCalledTimes(3);

    monitor.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(collectSpy).toHaveBeenCalledTimes(3);
  });

  it("logs start-loop errors when collect rejects", async () => {
    vi.useFakeTimers();

    const monitor = new HealthMonitor(
      { execute: vi.fn() } as any,
      { emit: vi.fn() } as any,
    );
    vi.spyOn(monitor, "collect").mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    monitor.start(500);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(errorSpy).toHaveBeenCalledWith(
      "[health] Initial collect failed:",
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[health] Collect failed:",
      expect.any(Error),
    );

    monitor.stop();
  });
});
