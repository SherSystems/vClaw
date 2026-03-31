import type { ToolRegistry } from "../tools/registry.js";
import type { EventBus } from "../agent/events.js";
import { AgentEventType } from "../types.js";
import { metricStore } from "./metric-store.js";
// ── Exported Types ──────────────────────────────────────────

export interface DataPoint {
  timestamp: number;
  value: number;
  labels: Record<string, string>;
}

export interface HealthMetric {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export interface ClusterHealthSummary {
  timestamp: string;
  nodes: {
    total: number;
    online: number;
    offline: number;
  };
  vms: {
    total: number;
    running: number;
    stopped: number;
    paused: number;
  };
  resources: {
    cpu_cores_total: number;
    cpu_usage_pct: number;
    ram_total_mb: number;
    ram_used_mb: number;
    ram_usage_pct: number;
    disk_total_gb: number;
    disk_used_gb: number;
    disk_usage_pct: number;
  };
  unhealthy_nodes: string[];
}

// ── Metric Store ────────────────────────────────────────────

const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESOLUTION_MS = 60 * 1000; // 1 minute

function seriesKey(metric: string, labels: Record<string, string>): string {
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
  return `${metric}{${sorted}}`;
}

export class MetricStore {
  private series: Map<string, DataPoint[]> = new Map();

  record(metric: string, value: number, labels: Record<string, string>): void {
    const key = seriesKey(metric, labels);
    let points = this.series.get(key);
    if (!points) {
      points = [];
      this.series.set(key, points);
    }

    const now = Date.now();

    if (points.length > 0) {
      const last = points[points.length - 1];
      if (now - last.timestamp < RESOLUTION_MS) {
        last.value = value;
        return;
      }
    }

    points.push({ timestamp: now, value, labels });
    this.prune(key, points, now);
  }

  query(
    metric: string,
    labels: Record<string, string>,
    duration_minutes: number
  ): DataPoint[] {
    const key = seriesKey(metric, labels);
    const points = this.series.get(key);
    if (!points) return [];

    const cutoff = Date.now() - duration_minutes * 60 * 1000;
    return points.filter((p) => p.timestamp >= cutoff);
  }

  getLatest(
    metric: string,
    labels: Record<string, string>
  ): DataPoint | null {
    const key = seriesKey(metric, labels);
    const points = this.series.get(key);
    if (!points || points.length === 0) return null;
    return points[points.length - 1];
  }

  get seriesCount(): number {
    return this.series.size;
  }

  /** Return the latest value for every series matching a metric name prefix */
  getAllLatest(metric: string): Array<{ value: number; labels: Record<string, string> }> {
    const prefix = `${metric}{`;
    const results: Array<{ value: number; labels: Record<string, string> }> = [];
    for (const [key, points] of this.series) {
      if (key.startsWith(prefix) && points.length > 0) {
        const last = points[points.length - 1];
        results.push({ value: last.value, labels: last.labels });
      }
    }
    return results;
  }

  private prune(key: string, points: DataPoint[], now: number): void {
    const cutoff = now - RETENTION_MS;
    let i = 0;
    while (i < points.length && points[i].timestamp < cutoff) i++;
    if (i > 0) {
      points.splice(0, i);
      if (points.length === 0) this.series.delete(key);
    }
  }
}

// ── Health Monitor ──────────────────────────────────────────

export class HealthMonitor {
  readonly store: MetricStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cpuWeightedSum = 0;
  private cpuCoresSum = 0;

  constructor(
    private registry: ToolRegistry,
    private events: EventBus
  ) {
    this.store = new MetricStore();
  }

  start(intervalMs: number = 60_000): void {
    if (this.running) return;
    this.running = true;
    console.log(`[health] Starting health monitor (interval: ${intervalMs}ms)`);
    this.collect().catch((err) => console.error(`[health] Initial collect failed:`, err));
    this.timer = setInterval(() => {
      this.collect().catch((err) => console.error(`[health] Collect failed:`, err));
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async collect(): Promise<void> {
    this.cpuWeightedSum = 0;
    this.cpuCoresSum = 0;

    const batch: HealthMetric[] = [];
    const summary: ClusterHealthSummary = {
      timestamp: new Date().toISOString(),
      nodes: { total: 0, online: 0, offline: 0 },
      vms: { total: 0, running: 0, stopped: 0, paused: 0 },
      resources: {
        cpu_cores_total: 0,
        cpu_usage_pct: 0,
        ram_total_mb: 0,
        ram_used_mb: 0,
        ram_usage_pct: 0,
        disk_total_gb: 0,
        disk_used_gb: 0,
        disk_usage_pct: 0,
      },
      unhealthy_nodes: [],
    };

    try {
      const nodes = await this.collectNodes(batch, summary);
      await this.collectVMs(batch, summary, nodes);
      this.finalizeSummary(summary);

      console.log(`[health] collected: ${summary.nodes.online}/${summary.nodes.total} nodes, ${summary.vms.running} running / ${summary.vms.stopped} stopped VMs, ${batch.length} metrics`);

      this.emitBatch(batch);
      this.emitHealthCheck(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[health] collection failed: ${msg}`);
    }
  }

  // ── Node Collection ─────────────────────────────────────

  private async collectNodes(
    batch: HealthMetric[],
    summary: ClusterHealthSummary
  ): Promise<string[]> {
    const onlineNodes: string[] = [];

    const listResult = await this.registry.execute("list_nodes", {});
    if (!listResult.success || !Array.isArray(listResult.data)) {
      return onlineNodes;
    }

    const nodes = listResult.data as Array<Record<string, unknown>>;
    summary.nodes.total = nodes.length;

    for (const node of nodes) {
      const name = node.node as string;
      const status = node.status as string;
      const labels = { node: name };

      if (status === "online") {
        summary.nodes.online++;
        onlineNodes.push(name);
      } else {
        summary.nodes.offline++;
        summary.unhealthy_nodes.push(name);
      }

      const cpuPct = typeof node.cpu === "number" ? node.cpu * 100 : 0;
      const cores = (node.maxcpu as number) || 0;
      const maxMem = (node.maxmem as number) || 0;
      const usedMem = (node.mem as number) || 0;
      const memPct = maxMem > 0 ? (usedMem / maxMem) * 100 : 0;

      summary.resources.cpu_cores_total += cores;
      summary.resources.ram_total_mb += Math.round(maxMem / 1024 / 1024);
      summary.resources.ram_used_mb += Math.round(usedMem / 1024 / 1024);

      if (status === "online" && cores > 0) {
        this.cpuWeightedSum += cpuPct * cores;
        this.cpuCoresSum += cores;
      }

      this.recordAndBatch(batch, "node_cpu_pct", cpuPct, labels);
      this.recordAndBatch(batch, "node_mem_pct", memPct, labels);
      this.recordAndBatch(batch, "node_uptime_s", (node.uptime as number) || 0, labels);

      if (status === "online") {
        await this.collectNodeDetails(name, batch, summary);
      }
    }

    return onlineNodes;
  }

  private async collectNodeDetails(
    nodeName: string,
    batch: HealthMetric[],
    summary: ClusterHealthSummary
  ): Promise<void> {
    try {
      const result = await this.registry.execute("get_node_stats", {
        node: nodeName,
      });
      if (!result.success || !result.data) return;

      const stats = result.data as Record<string, unknown>;
      const labels = { node: nodeName };

      const swap = stats.swap as Record<string, number> | undefined;
      if (swap) {
        const swapTotal = swap.total || 0;
        const swapUsed = swap.used || 0;
        const swapPct = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;
        this.recordAndBatch(batch, "node_swap_pct", swapPct, labels);
      }

      const rootfs = stats.rootfs as Record<string, number> | undefined;
      if (rootfs) {
        const diskTotal = rootfs.total || 0;
        const diskUsed = rootfs.used || 0;
        const diskPct = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;
        const totalGb = diskTotal / 1024 / 1024 / 1024;
        const usedGb = diskUsed / 1024 / 1024 / 1024;

        summary.resources.disk_total_gb += totalGb;
        summary.resources.disk_used_gb += usedGb;

        this.recordAndBatch(batch, "node_disk_pct", diskPct, labels);
      }

      const loadavg = stats.loadavg as number[] | undefined;
      if (loadavg && loadavg.length >= 1) {
        this.recordAndBatch(batch, "node_load_1m", loadavg[0], labels);
        if (loadavg.length >= 2) {
          this.recordAndBatch(batch, "node_load_5m", loadavg[1], labels);
        }
        if (loadavg.length >= 3) {
          this.recordAndBatch(batch, "node_load_15m", loadavg[2], labels);
        }
      }
    } catch {
      // Node unreachable during detail fetch; skip it
    }
  }

  // ── VM Collection ───────────────────────────────────────

  private async collectVMs(
    batch: HealthMetric[],
    summary: ClusterHealthSummary,
    onlineNodes: string[]
  ): Promise<void> {
    const listResult = await this.registry.execute("list_vms", {});
    if (!listResult.success || !Array.isArray(listResult.data)) return;

    const vms = listResult.data as Array<Record<string, unknown>>;
    summary.vms.total = vms.length;

    for (const vm of vms) {
      const vmid = vm.vmid as number;
      const vmNode = (vm.node as string) || "";
      const status = vm.status as string;
      const name = (vm.name as string) || `vm-${vmid}`;
      const labels = { vmid: String(vmid), node: vmNode, name };

      if (status === "running") summary.vms.running++;
      else if (status === "stopped") summary.vms.stopped++;
      else if (status === "paused") summary.vms.paused++;

      this.recordAndBatch(
        batch,
        "vm_status",
        status === "running" ? 1 : 0,
        labels
      );

      if (status === "running" && onlineNodes.includes(vmNode)) {
        await this.collectVMDetails(vmNode, vmid, labels, batch);
      }
    }
  }

  private async collectVMDetails(
    node: string,
    vmid: number,
    labels: Record<string, string>,
    batch: HealthMetric[]
  ): Promise<void> {
    try {
      const result = await this.registry.execute("get_vm_status", {
        node,
        vmid,
      });
      if (!result.success || !result.data) return;

      const s = result.data as Record<string, unknown>;

      const cpuPct = typeof s.cpu === "number" ? s.cpu * 100 : 0;
      this.recordAndBatch(batch, "vm_cpu_pct", cpuPct, labels);

      const maxMem = (s.maxmem as number) || 0;
      const usedMem = (s.mem as number) || 0;
      const memPct = maxMem > 0 ? (usedMem / maxMem) * 100 : 0;
      this.recordAndBatch(batch, "vm_mem_pct", memPct, labels);

      if (typeof s.diskread === "number") {
        this.recordAndBatch(batch, "vm_disk_read_bytes", s.diskread, labels);
      }
      if (typeof s.diskwrite === "number") {
        this.recordAndBatch(batch, "vm_disk_write_bytes", s.diskwrite, labels);
      }
      if (typeof s.netin === "number") {
        this.recordAndBatch(batch, "vm_net_in_bytes", s.netin, labels);
      }
      if (typeof s.netout === "number") {
        this.recordAndBatch(batch, "vm_net_out_bytes", s.netout, labels);
      }
      if (typeof s.uptime === "number") {
        this.recordAndBatch(batch, "vm_uptime_s", s.uptime, labels);
      }
    } catch {
      // VM unreachable; skip
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  private recordAndBatch(
    batch: HealthMetric[],
    name: string,
    value: number,
    labels: Record<string, string>
  ): void {
    this.store.record(name, value, labels);
    batch.push({ name, value, labels, timestamp: Date.now() });

    // Persist per-node resource metrics to SQLite for historical charting
    const persistMetrics = ["node_cpu_pct", "node_mem_pct", "node_disk_pct"];
    if (persistMetrics.includes(name) && labels.node) {
      metricStore.record(labels.node, name, value);
    }
  }

  private finalizeSummary(summary: ClusterHealthSummary): void {
    const r = summary.resources;

    r.cpu_usage_pct =
      this.cpuCoresSum > 0
        ? Math.round((this.cpuWeightedSum / this.cpuCoresSum) * 100) / 100
        : 0;

    r.ram_usage_pct =
      r.ram_total_mb > 0
        ? Math.round((r.ram_used_mb / r.ram_total_mb) * 100 * 100) / 100
        : 0;

    r.disk_usage_pct =
      r.disk_total_gb > 0
        ? Math.round((r.disk_used_gb / r.disk_total_gb) * 100 * 100) / 100
        : 0;

    r.disk_total_gb = Math.round(r.disk_total_gb * 10) / 10;
    r.disk_used_gb = Math.round(r.disk_used_gb * 10) / 10;
  }

  private emitBatch(batch: HealthMetric[]): void {
    if (batch.length === 0) return;
    this.events.emit({
      type: AgentEventType.MetricRecorded,
      timestamp: new Date().toISOString(),
      data: {
        count: batch.length,
        metrics: batch,
      },
    });
  }

  private emitHealthCheck(summary: ClusterHealthSummary): void {
    this.events.emit({
      type: AgentEventType.HealthCheck,
      timestamp: summary.timestamp,
      data: summary as unknown as Record<string, unknown>,
    });
  }
}
