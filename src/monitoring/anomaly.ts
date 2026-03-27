// ============================================================
// vClaw — Anomaly Detection Engine
// Detects threshold breaches, trends, spikes, and flatlines
// ============================================================

import { randomUUID } from "crypto";

// ── Interfaces ──────────────────────────────────────────────

export interface DataPoint {
  timestamp: string;
  value: number;
  labels: Record<string, string>;
}

export interface MetricStore {
  query(metric: string, labels: Record<string, string>, duration_minutes: number): DataPoint[];
  getLatest(metric: string, labels: Record<string, string>): DataPoint | null;
}

export interface Anomaly {
  id: string;
  type: "threshold" | "trend" | "spike" | "flatline";
  severity: "warning" | "critical";
  metric: string;
  labels: Record<string, string>;
  current_value: number;
  threshold?: number;
  projected_value?: number;
  projected_time?: string;
  message: string;
  detected_at: string;
}

export interface ThresholdConfig {
  metric: string;
  labels: Record<string, string>;
  warning: number;
  critical: number;
}

export interface TrendConfig {
  metric: string;
  labels: Record<string, string>;
  lookback_minutes: number;
  threshold: number;
  horizon_hours: number;
}

export interface SpikeConfig {
  metric: string;
  labels: Record<string, string>;
  lookback_minutes: number;
  deviation_factor: number;
}

export interface FlatlineConfig {
  metric: string;
  labels: Record<string, string>;
  lookback_minutes: number;
  tolerance: number;
}

export interface AnomalyDetectorOptions {
  thresholds?: ThresholdConfig[];
  trends?: TrendConfig[];
  spikes?: SpikeConfig[];
  flatlines?: FlatlineConfig[];
  cooldown_minutes?: number;
}

// ── Statistical Helpers ─────────────────────────────────────

export function linearRegression(points: DataPoint[]): { slope: number; intercept: number } {
  if (points.length < 2) {
    return { slope: 0, intercept: points.length === 1 ? points[0].value : 0 };
  }

  const timestamps = points.map((p) => new Date(p.timestamp).getTime());
  const baseTime = timestamps[0];
  const xs = timestamps.map((t) => (t - baseTime) / 60_000); // minutes from first point
  const ys = points.map((p) => p.value);
  const n = xs.length;

  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    return { slope: 0, intercept: sumY / n };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

export function predictTimeToThreshold(
  current: number,
  slope: number,
  threshold: number,
): number | null {
  if (slope <= 0) return null;
  if (current >= threshold) return 0;

  const minutes = (threshold - current) / slope;
  const hours = minutes / 60;

  return hours > 0 ? hours : null;
}

export function rollingStats(points: DataPoint[]): { mean: number; stddev: number } {
  if (points.length === 0) {
    return { mean: 0, stddev: 0 };
  }

  const values = points.map((p) => p.value);
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;

  if (n < 2) {
    return { mean, stddev: 0 };
  }

  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);

  return { mean, stddev };
}

// ── Default Configurations ──────────────────────────────────

const DEFAULT_THRESHOLDS: ThresholdConfig[] = [
  { metric: "cpu_usage_pct", labels: {}, warning: 80, critical: 90 },
  { metric: "memory_usage_pct", labels: {}, warning: 75, critical: 85 },
  { metric: "disk_usage_pct", labels: {}, warning: 80, critical: 90 },
];

const DEFAULT_TRENDS: TrendConfig[] = [
  { metric: "cpu_usage_pct", labels: {}, lookback_minutes: 30, threshold: 90, horizon_hours: 2 },
  { metric: "memory_usage_pct", labels: {}, lookback_minutes: 30, threshold: 85, horizon_hours: 2 },
  { metric: "disk_usage_pct", labels: {}, lookback_minutes: 60, threshold: 90, horizon_hours: 6 },
];

const DEFAULT_SPIKES: SpikeConfig[] = [
  { metric: "cpu_usage_pct", labels: {}, lookback_minutes: 15, deviation_factor: 2 },
  { metric: "memory_usage_pct", labels: {}, lookback_minutes: 15, deviation_factor: 2 },
  { metric: "network_rx_bytes", labels: {}, lookback_minutes: 15, deviation_factor: 2 },
  { metric: "network_tx_bytes", labels: {}, lookback_minutes: 15, deviation_factor: 2 },
];

const DEFAULT_FLATLINES: FlatlineConfig[] = [
  { metric: "network_rx_bytes", labels: {}, lookback_minutes: 10, tolerance: 0.001 },
  { metric: "network_tx_bytes", labels: {}, lookback_minutes: 10, tolerance: 0.001 },
];

const DEFAULT_COOLDOWN_MINUTES = 5;

// ── Anomaly Detector ────────────────────────────────────────

export class AnomalyDetector {
  private readonly thresholds: ThresholdConfig[];
  private readonly trends: TrendConfig[];
  private readonly spikes: SpikeConfig[];
  private readonly flatlines: FlatlineConfig[];
  private readonly cooldownMs: number;
  private readonly recentAnomalies: Map<string, number> = new Map();

  constructor(options?: AnomalyDetectorOptions) {
    this.thresholds = options?.thresholds ?? DEFAULT_THRESHOLDS;
    this.trends = options?.trends ?? DEFAULT_TRENDS;
    this.spikes = options?.spikes ?? DEFAULT_SPIKES;
    this.flatlines = options?.flatlines ?? DEFAULT_FLATLINES;
    this.cooldownMs = (options?.cooldown_minutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000;
  }

  detect(metricStore: MetricStore): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const now = Date.now();

    this.pruneExpiredCooldowns(now);

    for (const cfg of this.thresholds) {
      const anomaly = this.detectThreshold(metricStore, cfg);
      if (anomaly && !this.isDuplicate(anomaly, now)) {
        anomalies.push(anomaly);
        this.recordAnomaly(anomaly, now);
      }
    }

    for (const cfg of this.trends) {
      const anomaly = this.detectTrend(metricStore, cfg);
      if (anomaly && !this.isDuplicate(anomaly, now)) {
        anomalies.push(anomaly);
        this.recordAnomaly(anomaly, now);
      }
    }

    for (const cfg of this.spikes) {
      const anomaly = this.detectSpike(metricStore, cfg);
      if (anomaly && !this.isDuplicate(anomaly, now)) {
        anomalies.push(anomaly);
        this.recordAnomaly(anomaly, now);
      }
    }

    for (const cfg of this.flatlines) {
      const anomaly = this.detectFlatline(metricStore, cfg);
      if (anomaly && !this.isDuplicate(anomaly, now)) {
        anomalies.push(anomaly);
        this.recordAnomaly(anomaly, now);
      }
    }

    return anomalies;
  }

  resetCooldowns(): void {
    this.recentAnomalies.clear();
  }

  // ── Strategy: Threshold ─────────────────────────────────

  private detectThreshold(store: MetricStore, cfg: ThresholdConfig): Anomaly | null {
    const latest = store.getLatest(cfg.metric, cfg.labels);
    if (!latest) return null;

    const value = latest.value;

    if (value >= cfg.critical) {
      return this.buildAnomaly("threshold", "critical", cfg.metric, cfg.labels, value, {
        threshold: cfg.critical,
        message: `${cfg.metric} at ${value.toFixed(1)}% exceeds critical threshold ${cfg.critical}%`,
      });
    }

    if (value >= cfg.warning) {
      return this.buildAnomaly("threshold", "warning", cfg.metric, cfg.labels, value, {
        threshold: cfg.warning,
        message: `${cfg.metric} at ${value.toFixed(1)}% exceeds warning threshold ${cfg.warning}%`,
      });
    }

    return null;
  }

  // ── Strategy: Trend ─────────────────────────────────────

  private detectTrend(store: MetricStore, cfg: TrendConfig): Anomaly | null {
    const points = store.query(cfg.metric, cfg.labels, cfg.lookback_minutes);
    if (points.length < 3) return null;

    const latest = points[points.length - 1];
    if (latest.value >= cfg.threshold) return null; // already above threshold, not a prediction

    const { slope } = linearRegression(points);
    const hoursToThreshold = predictTimeToThreshold(latest.value, slope, cfg.threshold);

    if (hoursToThreshold === null || hoursToThreshold > cfg.horizon_hours) return null;

    const projectedTime = new Date(Date.now() + hoursToThreshold * 3_600_000).toISOString();
    const severity = hoursToThreshold <= 1 ? "critical" : "warning";

    return this.buildAnomaly("trend", severity, cfg.metric, cfg.labels, latest.value, {
      threshold: cfg.threshold,
      projected_value: cfg.threshold,
      projected_time: projectedTime,
      message: `${cfg.metric} trending toward ${cfg.threshold}% in ~${hoursToThreshold.toFixed(1)} hours (slope: ${slope.toFixed(3)}/min)`,
    });
  }

  // ── Strategy: Spike ─────────────────────────────────────

  private detectSpike(store: MetricStore, cfg: SpikeConfig): Anomaly | null {
    const points = store.query(cfg.metric, cfg.labels, cfg.lookback_minutes);
    if (points.length < 5) return null;

    const latest = points[points.length - 1];
    const historical = points.slice(0, -1);
    const { mean, stddev } = rollingStats(historical);

    if (stddev === 0) return null;

    const deviations = Math.abs(latest.value - mean) / stddev;
    if (deviations < cfg.deviation_factor) return null;

    const severity = deviations >= cfg.deviation_factor * 1.5 ? "critical" : "warning";

    return this.buildAnomaly("spike", severity, cfg.metric, cfg.labels, latest.value, {
      message: `${cfg.metric} spiked to ${latest.value.toFixed(1)} (${deviations.toFixed(1)} std devs from mean ${mean.toFixed(1)})`,
    });
  }

  // ── Strategy: Flatline ──────────────────────────────────

  private detectFlatline(store: MetricStore, cfg: FlatlineConfig): Anomaly | null {
    const points = store.query(cfg.metric, cfg.labels, cfg.lookback_minutes);
    if (points.length < 3) return null;

    const allZero = points.every((p) => Math.abs(p.value) <= cfg.tolerance);
    if (!allZero) return null;

    const latest = points[points.length - 1];

    return this.buildAnomaly("flatline", "warning", cfg.metric, cfg.labels, latest.value, {
      message: `${cfg.metric} flatlined at zero for the last ${cfg.lookback_minutes} minutes`,
    });
  }

  // ── Deduplication ───────────────────────────────────────

  private deduplicationKey(anomaly: Pick<Anomaly, "type" | "metric" | "labels" | "severity">): string {
    const labelStr = Object.entries(anomaly.labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${anomaly.type}:${anomaly.metric}:${labelStr}:${anomaly.severity}`;
  }

  private isDuplicate(anomaly: Anomaly, now: number): boolean {
    const key = this.deduplicationKey(anomaly);
    const lastSeen = this.recentAnomalies.get(key);
    return lastSeen !== undefined && now - lastSeen < this.cooldownMs;
  }

  private recordAnomaly(anomaly: Anomaly, now: number): void {
    const key = this.deduplicationKey(anomaly);
    this.recentAnomalies.set(key, now);
  }

  private pruneExpiredCooldowns(now: number): void {
    for (const [key, ts] of this.recentAnomalies) {
      if (now - ts >= this.cooldownMs) {
        this.recentAnomalies.delete(key);
      }
    }
  }

  // ── Builder ─────────────────────────────────────────────

  private buildAnomaly(
    type: Anomaly["type"],
    severity: Anomaly["severity"],
    metric: string,
    labels: Record<string, string>,
    current_value: number,
    extra: {
      threshold?: number;
      projected_value?: number;
      projected_time?: string;
      message: string;
    },
  ): Anomaly {
    return {
      id: randomUUID(),
      type,
      severity,
      metric,
      labels,
      current_value,
      threshold: extra.threshold,
      projected_value: extra.projected_value,
      projected_time: extra.projected_time,
      message: extra.message,
      detected_at: new Date().toISOString(),
    };
  }
}
