// ============================================================
// Metric Store — Persistent metric history with SQLite
// ============================================================

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve default DB path: <project_root>/data/metrics.db */
function defaultDbPath(): string {
  const dataDir = resolve(__dirname, "..", "..", "data");
  mkdirSync(dataDir, { recursive: true });
  return resolve(dataDir, "metrics.db");
}

// ── Types ────────────────────────────────────────────────────

export interface MetricPoint {
  timestamp: number;
  value: number;
}

interface RawMetricRow {
  id: number;
  timestamp: number;
  node: string;
  metric_name: string;
  value: number;
}

// ── PersistentMetricStore Class ──────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class PersistentMetricStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath?: string) {
    const path = dbPath ?? defaultDbPath();
    this.db = new Database(path);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    this.createTable();
    this.cleanup();

    this.insertStmt = this.db.prepare(`
      INSERT INTO metrics (timestamp, node, metric_name, value)
      VALUES (@timestamp, @node, @metric_name, @value)
    `);
  }

  /**
   * Record a metric data point.
   */
  record(node: string, metricName: string, value: number): void {
    this.insertStmt.run({
      timestamp: Date.now(),
      node,
      metric_name: metricName,
      value,
    });
  }

  /**
   * Query metric history for a given node + metric within a time range.
   */
  query(node: string, metricName: string, timeRangeMs: number): MetricPoint[] {
    const cutoff = Date.now() - timeRangeMs;
    const rows = this.db
      .prepare(
        `SELECT timestamp, value FROM metrics
         WHERE node = @node AND metric_name = @metric_name AND timestamp >= @cutoff
         ORDER BY timestamp ASC`,
      )
      .all({ node, metric_name: metricName, cutoff }) as RawMetricRow[];

    return rows.map((r) => ({ timestamp: r.timestamp, value: r.value }));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // ── Private ─────────────────────────────────────────────────

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   INTEGER NOT NULL,
        node        TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        value       REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_metrics_lookup
        ON metrics(node, metric_name, timestamp);
    `);
  }

  private cleanup(): void {
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    this.db.prepare("DELETE FROM metrics WHERE timestamp < @cutoff").run({ cutoff });
  }
}

// ── Singleton ────────────────────────────────────────────────

export const metricStore = new PersistentMetricStore();
