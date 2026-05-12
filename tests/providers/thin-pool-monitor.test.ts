import { describe, it, expect, vi } from "vitest";
import {
  ThinPoolMonitor,
  configFromEnv,
  type ThinPoolSampler,
} from "../../src/providers/proxmox/thin-pool-monitor.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";

const PVESM_HOT = `
Name             Type     Status           Total            Used       Available        %
local            dir      active        100000000        10000000        90000000   10.00%
local-lvm        lvmthin  active       1000000000       900000000       100000000   90.00%
`;

const PVESM_COOL = `
Name             Type     Status           Total            Used       Available        %
local-lvm        lvmthin  active       1000000000       100000000       900000000   10.00%
`;

const LVS_HOT = [
  "data,pve,twi-aotz--,1099511627776,92.00,15.00,,",
  "vm-201-disk-0,pve,Vwi-aotz--,137438953472,,,data,",
].join("\n");

const LVS_COOL = [
  "data,pve,twi-aotz--,1099511627776,15.00,4.00,,",
  "vm-201-disk-0,pve,Vwi-aotz--,137438953472,,,data,",
].join("\n");

const QM_LIST = `VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID
201  esxi paused 16384 128.00 -
`;

const SNAPSHOTS_STALE = `\`-> autosnap_2026-01-01_03_00_00 old
 \`-> current You are here!
`;

function makeSampler(overrides: Partial<ThinPoolSampler> = {}): ThinPoolSampler {
  return {
    nodes: vi.fn().mockResolvedValue(["pve1"]),
    pvesmStatus: vi.fn().mockResolvedValue(PVESM_COOL),
    lvs: vi.fn().mockResolvedValue(LVS_COOL),
    qmList: vi.fn().mockResolvedValue(QM_LIST),
    qmListSnapshot: vi.fn().mockResolvedValue(SNAPSHOTS_STALE),
    ...overrides,
  };
}

describe("configFromEnv", () => {
  it("respects env overrides", () => {
    const cfg = configFromEnv({
      RHODES_PROXMOX_THIN_POOL_POLL_SECS: "60",
      RHODES_PROXMOX_THIN_POOL_WARN_PCT: "70",
      RHODES_PROXMOX_STALE_SNAPSHOT_DAYS: "14",
    });
    expect(cfg.poll_interval_ms).toBe(60_000);
    expect(cfg.warn_pct).toBe(70);
    expect(cfg.stale_after_days).toBe(14);
  });

  it("uses defaults when env missing", () => {
    const cfg = configFromEnv({});
    expect(cfg.poll_interval_ms).toBe(300_000);
    expect(cfg.warn_pct).toBe(85);
    expect(cfg.stale_after_days).toBe(30);
  });

  it("ignores invalid env values", () => {
    const cfg = configFromEnv({
      RHODES_PROXMOX_THIN_POOL_WARN_PCT: "abc",
    });
    expect(cfg.warn_pct).toBe(85);
  });
});

describe("ThinPoolMonitor", () => {
  it("does NOT alert when utilization is below threshold", async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on(AgentEventType.ThinPoolWarning, (e) => events.push(e));

    const monitor = new ThinPoolMonitor(makeSampler(), { warn_pct: 85 }, bus);
    await monitor.sampleAll();
    expect(events).toHaveLength(0);
  });

  it("alerts when thin pool Data% crosses warn threshold", async () => {
    const bus = new EventBus();
    const events: { type: string; data: Record<string, unknown> }[] = [];
    bus.on(AgentEventType.ThinPoolWarning, (e) =>
      events.push({ type: e.type, data: e.data }),
    );

    const monitor = new ThinPoolMonitor(
      makeSampler({
        pvesmStatus: vi.fn().mockResolvedValue(PVESM_HOT),
        lvs: vi.fn().mockResolvedValue(LVS_HOT),
      }),
      { warn_pct: 85, alert_cooldown_ms: 0 },
      bus,
    );
    await monitor.sampleAll();
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.some(
        (e) => (e.data as { thin_pool?: string }).thin_pool === "data",
      ),
    ).toBe(true);
  });

  it("suppresses duplicate alerts within cooldown window", async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on(AgentEventType.ThinPoolWarning, (e) => events.push(e));

    const monitor = new ThinPoolMonitor(
      makeSampler({
        pvesmStatus: vi.fn().mockResolvedValue(PVESM_HOT),
        lvs: vi.fn().mockResolvedValue(LVS_HOT),
      }),
      { warn_pct: 85, alert_cooldown_ms: 60_000 },
      bus,
    );
    await monitor.sampleAll();
    const after1 = events.length;
    await monitor.sampleAll();
    expect(events.length).toBe(after1); // no duplicates
  });

  it("emits stale snapshot events when hot pool detected", async () => {
    const bus = new EventBus();
    const stales: unknown[] = [];
    bus.on(AgentEventType.StaleSnapshotDetected, (e) => stales.push(e));

    const monitor = new ThinPoolMonitor(
      makeSampler({
        pvesmStatus: vi.fn().mockResolvedValue(PVESM_HOT),
        lvs: vi.fn().mockResolvedValue(LVS_HOT),
      }),
      {
        warn_pct: 85,
        stale_after_days: 30,
        alert_cooldown_ms: 0,
      },
      bus,
    );
    await monitor.sampleAll();
    expect(stales.length).toBeGreaterThan(0);
  });

  it("does not throw when sampler.lvs fails for one node", async () => {
    const bus = new EventBus();
    const monitor = new ThinPoolMonitor(
      makeSampler({
        nodes: vi.fn().mockResolvedValue(["pve1", "pve2"]),
        lvs: vi
          .fn()
          .mockResolvedValueOnce(LVS_COOL)
          .mockRejectedValueOnce(new Error("ssh timeout")),
      }),
      {},
      bus,
    );
    const report = await monitor.sampleAll();
    expect(report.samples.length).toBeGreaterThanOrEqual(1);
  });
});
