// ============================================================
// RHODES — Proxmox Thin-Pool Proactive Monitor
//
// Polls `pvesm status` + `lvs` and emits warning events when
// thin-provisioned storage utilization crosses a configurable
// threshold (default 85%). Also flags snapshots older than
// `stale_after_days` (default 30) so the operator can prune
// before QEMU pauses any VMs.
//
// This is the *preventative* half of the STORAGE_EXHAUSTION_PAUSE
// event class. The reactive half lives in
// src/playbooks/proxmox-storage-pause.ts.
// ============================================================

import type { EventBus } from "../../agent/events.js";
import { AgentEventType } from "../../types.js";
import {
  parseLvs,
  parsePvesmStatus,
  parseQmList,
  parseQmListSnapshot,
  rankSnapshotsForDeletion,
  DEFAULT_STALE_SNAPSHOT_DAYS,
  type LvsEntry,
  type PvesmStatusEntry,
  type SnapshotCandidate,
} from "../../playbooks/proxmox-storage-pause.js";

// ── Config ──────────────────────────────────────────────────

export interface ThinPoolMonitorConfig {
  /** Poll interval in milliseconds. */
  poll_interval_ms: number;
  /** Storage utilization % at which we emit a warning event. */
  warn_pct: number;
  /** Snapshots older than this are reported in periodic findings. */
  stale_after_days: number;
  /** Suppress duplicate warnings for the same (node, pool) for this long. */
  alert_cooldown_ms: number;
}

const DEFAULT_POLL_SECS = 300;
const DEFAULT_WARN_PCT = 85;
const DEFAULT_ALERT_COOLDOWN_MIN = 30;

export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): ThinPoolMonitorConfig {
  const pollSecs = numFromEnv(
    env.RHODES_PROXMOX_THIN_POOL_POLL_SECS,
    DEFAULT_POLL_SECS,
  );
  const warnPct = numFromEnv(
    env.RHODES_PROXMOX_THIN_POOL_WARN_PCT,
    DEFAULT_WARN_PCT,
  );
  const staleDays = numFromEnv(
    env.RHODES_PROXMOX_STALE_SNAPSHOT_DAYS,
    DEFAULT_STALE_SNAPSHOT_DAYS,
  );
  const cooldownMin = numFromEnv(
    env.RHODES_PROXMOX_THIN_POOL_ALERT_COOLDOWN_MIN,
    DEFAULT_ALERT_COOLDOWN_MIN,
  );
  return {
    poll_interval_ms: pollSecs * 1000,
    warn_pct: warnPct,
    stale_after_days: staleDays,
    alert_cooldown_ms: cooldownMin * 60 * 1000,
  };
}

function numFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Sampler Contract ────────────────────────────────────────

export interface ThinPoolSampler {
  /** List of nodes to poll. */
  nodes(): Promise<string[]>;
  pvesmStatus(node: string): Promise<string>;
  lvs(node: string): Promise<string>;
  qmList(node: string): Promise<string>;
  qmListSnapshot(node: string, vmid: number): Promise<string>;
}

// ── Sample Output ───────────────────────────────────────────

export interface ThinPoolSample {
  node: string;
  taken_at: string;
  storages: PvesmStatusEntry[];
  thin_pools: LvsEntry[];
  hot_storages: PvesmStatusEntry[];
  hot_pools: LvsEntry[];
  stale_snapshots: SnapshotCandidate[];
}

export interface ThinPoolReport {
  samples: ThinPoolSample[];
  generated_at: string;
}

// ── Monitor ─────────────────────────────────────────────────

export class ThinPoolMonitor {
  private readonly config: ThinPoolMonitorConfig;
  private readonly sampler: ThinPoolSampler;
  private readonly bus?: EventBus;
  private readonly lastAlertAt: Map<string, number> = new Map();
  private timer?: ReturnType<typeof setInterval>;
  private lastReport: ThinPoolReport = {
    samples: [],
    generated_at: new Date(0).toISOString(),
  };

  constructor(
    sampler: ThinPoolSampler,
    config: Partial<ThinPoolMonitorConfig> = {},
    eventBus?: EventBus,
  ) {
    this.sampler = sampler;
    const base = configFromEnv();
    this.config = { ...base, ...config };
    this.bus = eventBus;
  }

  getConfig(): ThinPoolMonitorConfig {
    return this.config;
  }

  getLastReport(): ThinPoolReport {
    return this.lastReport;
  }

  start(): void {
    if (this.timer) return;
    // Fire one sample immediately so callers don't wait an interval.
    void this.sampleAll().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.sampleAll().catch(() => undefined);
    }, this.config.poll_interval_ms);
    // Don't keep the event loop alive solely for polling.
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Drive a single poll across all nodes — primarily a hook for tests. */
  async sampleAll(): Promise<ThinPoolReport> {
    const nodes = await this.sampler.nodes();
    const samples: ThinPoolSample[] = [];
    for (const node of nodes) {
      try {
        const sample = await this.sampleNode(node);
        samples.push(sample);
        this.emitForSample(sample);
      } catch (err) {
        // Don't let one bad node take down the loop.
        if (this.bus) {
          this.bus.emit({
            type: AgentEventType.ProbeFailed,
            timestamp: new Date().toISOString(),
            data: {
              probe: "proxmox.thin_pool_monitor",
              node,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }
    const report: ThinPoolReport = {
      samples,
      generated_at: new Date().toISOString(),
    };
    this.lastReport = report;
    return report;
  }

  async sampleNode(node: string): Promise<ThinPoolSample> {
    const pvesmOut = await this.sampler.pvesmStatus(node);
    const lvsOut = await this.sampler.lvs(node);
    const storages = parsePvesmStatus(pvesmOut);
    const lvs = parseLvs(lvsOut);
    const thin_pools = lvs.filter((l) => l.attr.startsWith("t"));

    const hot_storages = storages.filter(
      (s) => s.used_pct >= this.config.warn_pct,
    );
    const hot_pools = thin_pools.filter(
      (l) => l.data_pct !== undefined && l.data_pct >= this.config.warn_pct,
    );

    let stale_snapshots: SnapshotCandidate[] = [];
    if (hot_pools.length > 0 || hot_storages.length > 0) {
      stale_snapshots = await this.collectStaleSnapshots(node);
    }

    return {
      node,
      taken_at: new Date().toISOString(),
      storages,
      thin_pools,
      hot_storages,
      hot_pools,
      stale_snapshots,
    };
  }

  private async collectStaleSnapshots(
    node: string,
  ): Promise<SnapshotCandidate[]> {
    const qmListOut = await this.sampler.qmList(node);
    const vms = parseQmList(qmListOut);
    const collected: SnapshotCandidate[] = [];
    const now = new Date();
    for (const vm of vms) {
      try {
        const out = await this.sampler.qmListSnapshot(node, vm.vmid);
        const parsed = rankSnapshotsForDeletion(
          parseQmListSnapshot(vm.vmid, out),
          { stale_after_days: this.config.stale_after_days, now },
        );
        // Only keep entries flagged as stale or crash-recovery.
        for (const s of parsed) {
          if (s.reasons.length > 0) collected.push(s);
        }
      } catch {
        // Skip — VM may have been deleted mid-poll.
      }
    }
    return collected;
  }

  private emitForSample(sample: ThinPoolSample): void {
    if (!this.bus) return;
    const now = Date.now();

    for (const pool of sample.hot_pools) {
      const key = `${sample.node}:lv:${pool.lv}`;
      if (!this.shouldEmit(key, now)) continue;
      this.bus.emit({
        type: AgentEventType.ThinPoolWarning,
        timestamp: new Date().toISOString(),
        data: {
          node: sample.node,
          thin_pool: pool.lv,
          vg: pool.vg,
          data_pct: pool.data_pct,
          meta_pct: pool.meta_pct,
          warn_pct: this.config.warn_pct,
          size_bytes: pool.size_bytes,
        },
      });
      this.lastAlertAt.set(key, now);
    }

    for (const storage of sample.hot_storages) {
      const key = `${sample.node}:storage:${storage.storage}`;
      if (!this.shouldEmit(key, now)) continue;
      this.bus.emit({
        type: AgentEventType.ThinPoolWarning,
        timestamp: new Date().toISOString(),
        data: {
          node: sample.node,
          storage: storage.storage,
          used_pct: storage.used_pct,
          warn_pct: this.config.warn_pct,
          total_bytes: storage.total_bytes,
          used_bytes: storage.used_bytes,
        },
      });
      this.lastAlertAt.set(key, now);
    }

    for (const snap of sample.stale_snapshots) {
      const key = `${sample.node}:snap:${snap.vmid}:${snap.name}`;
      if (!this.shouldEmit(key, now)) continue;
      this.bus.emit({
        type: AgentEventType.StaleSnapshotDetected,
        timestamp: new Date().toISOString(),
        data: {
          node: sample.node,
          vmid: snap.vmid,
          snapshot: snap.name,
          reasons: snap.reasons,
          created_at: snap.created_at,
        },
      });
      this.lastAlertAt.set(key, now);
    }
  }

  private shouldEmit(key: string, now: number): boolean {
    const last = this.lastAlertAt.get(key);
    if (last === undefined) return true;
    return now - last >= this.config.alert_cooldown_ms;
  }
}
