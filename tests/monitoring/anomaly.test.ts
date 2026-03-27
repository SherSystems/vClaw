import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AnomalyDetector,
  linearRegression,
  predictTimeToThreshold,
  rollingStats,
  type DataPoint,
  type MetricStore,
  type ThresholdConfig,
  type TrendConfig,
  type SpikeConfig,
  type FlatlineConfig,
} from "../../src/monitoring/anomaly.js";

// ── Helpers ──────────────────────────────────────────────────

function dp(value: number, minutesAgo: number = 0): DataPoint {
  return {
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    value,
    labels: {},
  };
}

function createMockStore(
  data: Record<string, { points: DataPoint[]; latest: DataPoint | null }>
): MetricStore {
  return {
    query(metric: string, _labels: Record<string, string>, _duration_minutes: number) {
      return data[metric]?.points ?? [];
    },
    getLatest(metric: string, _labels: Record<string, string>) {
      return data[metric]?.latest ?? null;
    },
  };
}

// ── linearRegression ─────────────────────────────────────────

describe("linearRegression", () => {
  it("returns slope=0, intercept=0 for zero points", () => {
    const result = linearRegression([]);
    expect(result.slope).toBe(0);
    expect(result.intercept).toBe(0);
  });

  it("returns slope=0, intercept=value for a single point", () => {
    const result = linearRegression([dp(42)]);
    expect(result.slope).toBe(0);
    expect(result.intercept).toBe(42);
  });

  it("returns correct slope for a perfect upward trend", () => {
    // y = x (value equals minutes-from-start)
    const now = Date.now();
    const points: DataPoint[] = [0, 1, 2, 3, 4].map((m) => ({
      timestamp: new Date(now + m * 60_000).toISOString(),
      value: m,
      labels: {},
    }));
    const { slope, intercept } = linearRegression(points);
    expect(slope).toBeCloseTo(1, 5);
    expect(intercept).toBeCloseTo(0, 5);
  });

  it("returns correct slope and intercept for two points", () => {
    const now = Date.now();
    const points: DataPoint[] = [
      { timestamp: new Date(now).toISOString(), value: 10, labels: {} },
      { timestamp: new Date(now + 5 * 60_000).toISOString(), value: 20, labels: {} },
    ];
    const { slope, intercept } = linearRegression(points);
    // slope = (20-10) / 5 minutes = 2 per minute
    expect(slope).toBeCloseTo(2, 5);
    expect(intercept).toBeCloseTo(10, 5);
  });

  it("returns slope=0 when all values are the same", () => {
    const now = Date.now();
    const points: DataPoint[] = [0, 1, 2, 3].map((m) => ({
      timestamp: new Date(now + m * 60_000).toISOString(),
      value: 50,
      labels: {},
    }));
    const { slope, intercept } = linearRegression(points);
    expect(slope).toBeCloseTo(0, 5);
    expect(intercept).toBeCloseTo(50, 5);
  });
});

// ── predictTimeToThreshold ───────────────────────────────────

describe("predictTimeToThreshold", () => {
  it("returns null when slope <= 0", () => {
    expect(predictTimeToThreshold(50, 0, 90)).toBeNull();
    expect(predictTimeToThreshold(50, -1, 90)).toBeNull();
  });

  it("returns 0 when current >= threshold", () => {
    expect(predictTimeToThreshold(90, 1, 90)).toBe(0);
    expect(predictTimeToThreshold(95, 1, 90)).toBe(0);
  });

  it("returns correct hours for a positive slope", () => {
    // current=50, threshold=90, slope=2/min => 20 min => 1/3 hr
    const result = predictTimeToThreshold(50, 2, 90);
    expect(result).toBeCloseTo(20 / 60, 5);
  });

  it("returns null when slope is zero (edge case)", () => {
    expect(predictTimeToThreshold(50, 0, 90)).toBeNull();
  });
});

// ── rollingStats ─────────────────────────────────────────────

describe("rollingStats", () => {
  it("returns mean=0, stddev=0 for an empty array", () => {
    const { mean, stddev } = rollingStats([]);
    expect(mean).toBe(0);
    expect(stddev).toBe(0);
  });

  it("returns mean=value, stddev=0 for a single value", () => {
    const { mean, stddev } = rollingStats([dp(7)]);
    expect(mean).toBe(7);
    expect(stddev).toBe(0);
  });

  it("computes correct mean and sample stddev for known dataset", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] => mean=5, sample variance=4.571..., sample stddev~=2.138
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const points = values.map((v) => dp(v));
    const { mean, stddev } = rollingStats(points);
    expect(mean).toBe(5);
    expect(stddev).toBeCloseTo(2.138, 2);
  });

  it("returns stddev=0 when all values are the same", () => {
    const points = [10, 10, 10, 10].map((v) => dp(v));
    const { mean, stddev } = rollingStats(points);
    expect(mean).toBe(10);
    expect(stddev).toBe(0);
  });
});

// ── AnomalyDetector — Threshold ─────────────────────────────

describe("AnomalyDetector — Threshold", () => {
  const thresholdCfg: ThresholdConfig = {
    metric: "cpu",
    labels: {},
    warning: 80,
    critical: 90,
  };

  function makeDetector() {
    return new AnomalyDetector({
      thresholds: [thresholdCfg],
      trends: [],
      spikes: [],
      flatlines: [],
      cooldown_minutes: 0,
    });
  }

  it("detects critical when value >= critical threshold", () => {
    const store = createMockStore({
      cpu: { points: [], latest: dp(95) },
    });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].severity).toBe("critical");
    expect(anomalies[0].type).toBe("threshold");
  });

  it("detects warning when value >= warning but < critical", () => {
    const store = createMockStore({
      cpu: { points: [], latest: dp(85) },
    });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].severity).toBe("warning");
  });

  it("no anomaly when value below warning", () => {
    const store = createMockStore({
      cpu: { points: [], latest: dp(50) },
    });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });

  it("no anomaly when no latest data point", () => {
    const store = createMockStore({
      cpu: { points: [], latest: null },
    });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });
});

// ── AnomalyDetector — Trend ─────────────────────────────────

describe("AnomalyDetector — Trend", () => {
  const trendCfg: TrendConfig = {
    metric: "cpu",
    labels: {},
    lookback_minutes: 30,
    threshold: 90,
    horizon_hours: 4,
  };

  function makeDetector(overrides?: Partial<TrendConfig>) {
    return new AnomalyDetector({
      thresholds: [],
      trends: [{ ...trendCfg, ...overrides }],
      spikes: [],
      flatlines: [],
      cooldown_minutes: 0,
    });
  }

  it("detects trend when slope predicts threshold breach within horizon", () => {
    const now = Date.now();
    // rising from 60 to 80 over 20 min => slope ~1/min, threshold 90 in ~10 min
    const points: DataPoint[] = [0, 5, 10, 15, 20].map((m) => ({
      timestamp: new Date(now - (20 - m) * 60_000).toISOString(),
      value: 60 + m,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[points.length - 1] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe("trend");
  });

  it("critical severity when breach predicted within 1 hour", () => {
    const now = Date.now();
    // slope ~2/min => breach in ~5 min from 80
    const points: DataPoint[] = [0, 1, 2, 3, 4].map((m) => ({
      timestamp: new Date(now - (4 - m) * 60_000).toISOString(),
      value: 70 + m * 2,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[points.length - 1] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].severity).toBe("critical");
  });

  it("warning severity when breach predicted within horizon but > 1 hour", () => {
    const now = Date.now();
    // slope ~0.1/min => threshold in ~100 min (~1.67 hours)
    const points: DataPoint[] = [0, 10, 20, 30].map((m) => ({
      timestamp: new Date(now - (30 - m) * 60_000).toISOString(),
      value: 80 + m * 0.1,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[points.length - 1] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].severity).toBe("warning");
  });

  it("no anomaly when not enough data points (< 3)", () => {
    const now = Date.now();
    const points: DataPoint[] = [
      { timestamp: new Date(now - 60_000).toISOString(), value: 80, labels: {} },
      { timestamp: new Date(now).toISOString(), value: 85, labels: {} },
    ];
    const store = createMockStore({ cpu: { points, latest: points[1] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });

  it("no anomaly when value already above threshold", () => {
    const now = Date.now();
    const points: DataPoint[] = [0, 5, 10].map((m) => ({
      timestamp: new Date(now - (10 - m) * 60_000).toISOString(),
      value: 91 + m,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[points.length - 1] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });

  it("no anomaly when slope is negative/flat", () => {
    const now = Date.now();
    const points: DataPoint[] = [0, 5, 10].map((m) => ({
      timestamp: new Date(now - (10 - m) * 60_000).toISOString(),
      value: 80 - m,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[points.length - 1] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });
});

// ── AnomalyDetector — Spike ─────────────────────────────────

describe("AnomalyDetector — Spike", () => {
  const spikeCfg: SpikeConfig = {
    metric: "cpu",
    labels: {},
    lookback_minutes: 15,
    deviation_factor: 2,
  };

  function makeDetector(overrides?: Partial<SpikeConfig>) {
    return new AnomalyDetector({
      thresholds: [],
      trends: [],
      spikes: [{ ...spikeCfg, ...overrides }],
      flatlines: [],
      cooldown_minutes: 0,
    });
  }

  it("detects spike when value deviates by >= deviation_factor stddevs", () => {
    // Historical: [50, 50, 50, 50] => mean=50, stddev=0... need variation
    // Historical with some variance: [48, 50, 52, 50] => mean=50, stddev~=1.63
    // Latest at 54 => deviation ~= 2.45 stddevs (> 2)
    const now = Date.now();
    const points: DataPoint[] = [48, 50, 52, 50, 54].map((v, i) => ({
      timestamp: new Date(now - (4 - i) * 60_000).toISOString(),
      value: v,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[4] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe("spike");
  });

  it("critical when deviation >= factor * 1.5", () => {
    // Historical: [50, 50, 52, 48] => mean=50, sample stddev ~= 1.63
    // Latest at 56 => deviation ~= 3.67 stddevs (>= 2 * 1.5 = 3)
    const now = Date.now();
    const points: DataPoint[] = [50, 50, 52, 48, 56].map((v, i) => ({
      timestamp: new Date(now - (4 - i) * 60_000).toISOString(),
      value: v,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[4] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].severity).toBe("critical");
  });

  it("no anomaly when not enough data (< 5)", () => {
    const now = Date.now();
    const points: DataPoint[] = [50, 50, 90, 50].map((v, i) => ({
      timestamp: new Date(now - (3 - i) * 60_000).toISOString(),
      value: v,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[3] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });

  it("no anomaly when stddev is 0", () => {
    const now = Date.now();
    // Historical all the same => stddev=0
    const points: DataPoint[] = [50, 50, 50, 50, 99].map((v, i) => ({
      timestamp: new Date(now - (4 - i) * 60_000).toISOString(),
      value: v,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[4] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });

  it("no anomaly when deviation below factor", () => {
    const now = Date.now();
    // Historical: [48, 50, 52, 50] => mean=50, stddev~=1.63
    // Latest at 51 => deviation ~= 0.61 (< 2)
    const points: DataPoint[] = [48, 50, 52, 50, 51].map((v, i) => ({
      timestamp: new Date(now - (4 - i) * 60_000).toISOString(),
      value: v,
      labels: {},
    }));
    const store = createMockStore({ cpu: { points, latest: points[4] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });
});

// ── AnomalyDetector — Flatline ───────────────────────────────

describe("AnomalyDetector — Flatline", () => {
  const flatlineCfg: FlatlineConfig = {
    metric: "net_rx",
    labels: {},
    lookback_minutes: 10,
    tolerance: 0.001,
  };

  function makeDetector() {
    return new AnomalyDetector({
      thresholds: [],
      trends: [],
      spikes: [],
      flatlines: [flatlineCfg],
      cooldown_minutes: 0,
    });
  }

  it("detects flatline when all values are within tolerance of zero", () => {
    const now = Date.now();
    const points: DataPoint[] = [0, 0, 0.0005, 0].map((v, i) => ({
      timestamp: new Date(now - (3 - i) * 60_000).toISOString(),
      value: v,
      labels: {},
    }));
    const store = createMockStore({ net_rx: { points, latest: points[3] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe("flatline");
    expect(anomalies[0].severity).toBe("warning");
  });

  it("no anomaly when values are not all zero", () => {
    const now = Date.now();
    const points: DataPoint[] = [0, 0, 5, 0].map((v, i) => ({
      timestamp: new Date(now - (3 - i) * 60_000).toISOString(),
      value: v,
      labels: {},
    }));
    const store = createMockStore({ net_rx: { points, latest: points[3] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });

  it("no anomaly when not enough data (< 3)", () => {
    const now = Date.now();
    const points: DataPoint[] = [0, 0].map((v, i) => ({
      timestamp: new Date(now - (1 - i) * 60_000).toISOString(),
      value: v,
      labels: {},
    }));
    const store = createMockStore({ net_rx: { points, latest: points[1] } });
    const anomalies = makeDetector().detect(store);
    expect(anomalies).toHaveLength(0);
  });
});

// ── AnomalyDetector — Cooldown / Deduplication ───────────────

describe("AnomalyDetector — Cooldown / Deduplication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDetector(cooldownMinutes: number) {
    return new AnomalyDetector({
      thresholds: [{ metric: "cpu", labels: {}, warning: 80, critical: 90 }],
      trends: [],
      spikes: [],
      flatlines: [],
      cooldown_minutes: cooldownMinutes,
    });
  }

  it("same anomaly not reported twice within cooldown period", () => {
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const store = createMockStore({
      cpu: { points: [], latest: dp(95) },
    });
    const detector = makeDetector(5);

    const first = detector.detect(store);
    expect(first).toHaveLength(1);

    // Still within cooldown
    vi.advanceTimersByTime(2 * 60_000);
    const second = detector.detect(store);
    expect(second).toHaveLength(0);
  });

  it("same anomaly reported again after cooldown expires", () => {
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const store = createMockStore({
      cpu: { points: [], latest: dp(95) },
    });
    const detector = makeDetector(5);

    const first = detector.detect(store);
    expect(first).toHaveLength(1);

    // Advance past cooldown
    vi.advanceTimersByTime(6 * 60_000);
    const second = detector.detect(store);
    expect(second).toHaveLength(1);
  });

  it("resetCooldowns() clears all cooldowns", () => {
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const store = createMockStore({
      cpu: { points: [], latest: dp(95) },
    });
    const detector = makeDetector(5);

    detector.detect(store);
    detector.resetCooldowns();

    const after = detector.detect(store);
    expect(after).toHaveLength(1);
  });
});
