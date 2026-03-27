import { describe, it, expect, vi, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { PersistentMetricStore, type MetricPoint } from "../../src/monitoring/metric-store.js";

function tmpDbPath(): string {
  return `/tmp/infrawrap-test-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("PersistentMetricStore", () => {
  let store: PersistentMetricStore;
  let dbPath: string;

  afterEach(() => {
    try {
      store?.close();
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(dbPath);
      unlinkSync(dbPath + "-wal");
      unlinkSync(dbPath + "-shm");
    } catch {
      /* files may not exist */
    }
  });

  function createStore(): PersistentMetricStore {
    dbPath = tmpDbPath();
    store = new PersistentMetricStore(dbPath);
    return store;
  }

  it("record() stores data and query() retrieves it", () => {
    const s = createStore();
    s.record("pve1", "cpu_usage", 55.2);

    const results = s.query("pve1", "cpu_usage", 60_000);
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(55.2);
    expect(results[0].timestamp).toBeTypeOf("number");
  });

  it("query() returns empty array for unknown node", () => {
    const s = createStore();
    s.record("pve1", "cpu_usage", 42);

    const results = s.query("unknown-node", "cpu_usage", 60_000);
    expect(results).toEqual([]);
  });

  it("query() returns empty array for unknown metric", () => {
    const s = createStore();
    s.record("pve1", "cpu_usage", 42);

    const results = s.query("pve1", "nonexistent_metric", 60_000);
    expect(results).toEqual([]);
  });

  it("query() respects timeRangeMs — only returns data within range", () => {
    vi.useFakeTimers();
    const baseTime = Date.now();

    const s = createStore();

    // Record at t=0
    vi.setSystemTime(baseTime);
    s.record("pve1", "mem_usage", 10);

    // Record at t=+5 minutes
    vi.setSystemTime(baseTime + 5 * 60_000);
    s.record("pve1", "mem_usage", 20);

    // Record at t=+10 minutes
    vi.setSystemTime(baseTime + 10 * 60_000);
    s.record("pve1", "mem_usage", 30);

    // Query with a 6-minute window (should get only the last two records)
    vi.setSystemTime(baseTime + 10 * 60_000);
    const results = s.query("pve1", "mem_usage", 6 * 60_000);

    expect(results).toHaveLength(2);
    expect(results[0].value).toBe(20);
    expect(results[1].value).toBe(30);

    vi.useRealTimers();
  });

  it("record() multiple metrics for the same node", () => {
    const s = createStore();
    s.record("pve1", "cpu_usage", 45);
    s.record("pve1", "mem_usage", 72);
    s.record("pve1", "disk_io", 120);

    expect(s.query("pve1", "cpu_usage", 60_000)).toHaveLength(1);
    expect(s.query("pve1", "mem_usage", 60_000)).toHaveLength(1);
    expect(s.query("pve1", "disk_io", 60_000)).toHaveLength(1);

    expect(s.query("pve1", "cpu_usage", 60_000)[0].value).toBe(45);
    expect(s.query("pve1", "mem_usage", 60_000)[0].value).toBe(72);
    expect(s.query("pve1", "disk_io", 60_000)[0].value).toBe(120);
  });

  it("record() same metric for different nodes", () => {
    const s = createStore();
    s.record("pve1", "cpu_usage", 30);
    s.record("pve2", "cpu_usage", 60);
    s.record("pve3", "cpu_usage", 90);

    expect(s.query("pve1", "cpu_usage", 60_000)[0].value).toBe(30);
    expect(s.query("pve2", "cpu_usage", 60_000)[0].value).toBe(60);
    expect(s.query("pve3", "cpu_usage", 60_000)[0].value).toBe(90);
  });

  it("query() returns results ordered by timestamp ASC", () => {
    vi.useFakeTimers();
    const baseTime = Date.now();

    const s = createStore();

    // Insert in non-sequential order using fake timers
    vi.setSystemTime(baseTime + 3000);
    s.record("pve1", "cpu_usage", 30);

    vi.setSystemTime(baseTime + 1000);
    s.record("pve1", "cpu_usage", 10);

    vi.setSystemTime(baseTime + 2000);
    s.record("pve1", "cpu_usage", 20);

    vi.setSystemTime(baseTime + 3000);
    const results = s.query("pve1", "cpu_usage", 60_000);

    expect(results).toHaveLength(3);
    expect(results[0].value).toBe(10);
    expect(results[1].value).toBe(20);
    expect(results[2].value).toBe(30);
    expect(results[0].timestamp).toBeLessThan(results[1].timestamp);
    expect(results[1].timestamp).toBeLessThan(results[2].timestamp);

    vi.useRealTimers();
  });

  it("close() does not throw", () => {
    const s = createStore();
    expect(() => s.close()).not.toThrow();
  });

  it("multiple records return correct MetricPoint[] shape", () => {
    const s = createStore();
    s.record("pve1", "cpu_usage", 10);
    s.record("pve1", "cpu_usage", 20);
    s.record("pve1", "cpu_usage", 30);

    const results: MetricPoint[] = s.query("pve1", "cpu_usage", 60_000);

    expect(results).toHaveLength(3);
    for (const point of results) {
      expect(point).toHaveProperty("timestamp");
      expect(point).toHaveProperty("value");
      expect(point.timestamp).toBeTypeOf("number");
      expect(point.value).toBeTypeOf("number");
      // Ensure no extra properties leak through
      expect(Object.keys(point).sort()).toEqual(["timestamp", "value"]);
    }
  });
});
