// ============================================================
// Audit Log — Persistent action logging with SQLite
// ============================================================

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type { AuditEntry } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve default DB path: <project_root>/data/audit.db */
function defaultDbPath(): string {
  const dataDir = resolve(__dirname, "..", "..", "data");
  mkdirSync(dataDir, { recursive: true });
  return resolve(dataDir, "audit.db");
}

// ── Query Filter Types ──────────────────────────────────────

export interface AuditQueryFilters {
  action?: string;
  tier?: string;
  result?: string;
  since?: string; // ISO date string
  limit?: number;
}

export interface AuditStats {
  total: number;
  by_result: Record<string, number>;
  by_tier: Record<string, number>;
  recent_failures: AuditEntry[];
}

// ── AuditLog Class ──────────────────────────────────────────

export class AuditLog {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? defaultDbPath();
    this.db = new Database(path);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    this.createTable();
  }

  /**
   * Log an audit entry to the database.
   */
  log(entry: AuditEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (
        id, timestamp, action, tier, approval, reasoning,
        params, result, error, state_before, state_after,
        plan_id, step_id, duration_ms
      ) VALUES (
        @id, @timestamp, @action, @tier, @approval, @reasoning,
        @params, @result, @error, @state_before, @state_after,
        @plan_id, @step_id, @duration_ms
      )
    `);

    stmt.run({
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.action,
      tier: entry.tier,
      approval: entry.approval ? JSON.stringify(entry.approval) : null,
      reasoning: entry.reasoning,
      params: JSON.stringify(entry.params),
      result: entry.result,
      error: entry.error ?? null,
      state_before: entry.state_before
        ? JSON.stringify(entry.state_before)
        : null,
      state_after: entry.state_after
        ? JSON.stringify(entry.state_after)
        : null,
      plan_id: entry.plan_id ?? null,
      step_id: entry.step_id ?? null,
      duration_ms: entry.duration_ms,
    });
  }

  /**
   * Query audit entries with optional filters.
   */
  query(filters: AuditQueryFilters = {}): AuditEntry[] {
    const conditions: string[] = [];
    const values: Record<string, unknown> = {};

    if (filters.action) {
      conditions.push("action = @action");
      values.action = filters.action;
    }

    if (filters.tier) {
      conditions.push("tier = @tier");
      values.tier = filters.tier;
    }

    if (filters.result) {
      conditions.push("result = @result");
      values.result = filters.result;
    }

    if (filters.since) {
      conditions.push("timestamp >= @since");
      values.since = filters.since;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;

    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT @limit`,
      )
      .all({ ...values, limit }) as RawAuditRow[];

    return rows.map(deserializeRow);
  }

  /**
   * Get aggregate statistics from the audit log.
   */
  getStats(): AuditStats {
    const total = (
      this.db.prepare("SELECT COUNT(*) as count FROM audit_log").get() as {
        count: number;
      }
    ).count;

    const byResult = this.db
      .prepare(
        "SELECT result, COUNT(*) as count FROM audit_log GROUP BY result",
      )
      .all() as { result: string; count: number }[];

    const byTier = this.db
      .prepare("SELECT tier, COUNT(*) as count FROM audit_log GROUP BY tier")
      .all() as { tier: string; count: number }[];

    const recentFailureRows = this.db
      .prepare(
        `SELECT * FROM audit_log
         WHERE result IN ('failed', 'blocked')
         ORDER BY timestamp DESC
         LIMIT 10`,
      )
      .all() as RawAuditRow[];

    return {
      total,
      by_result: Object.fromEntries(byResult.map((r) => [r.result, r.count])),
      by_tier: Object.fromEntries(byTier.map((r) => [r.tier, r.count])),
      recent_failures: recentFailureRows.map(deserializeRow),
    };
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
      CREATE TABLE IF NOT EXISTS audit_log (
        id            TEXT PRIMARY KEY,
        timestamp     TEXT NOT NULL,
        action        TEXT NOT NULL,
        tier          TEXT NOT NULL,
        approval      TEXT,
        reasoning     TEXT NOT NULL,
        params        TEXT NOT NULL,
        result        TEXT NOT NULL,
        error         TEXT,
        state_before  TEXT,
        state_after   TEXT,
        plan_id       TEXT,
        step_id       TEXT,
        duration_ms   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_log(result);
      CREATE INDEX IF NOT EXISTS idx_audit_tier ON audit_log(tier);
    `);
  }
}

// ── Row Deserialization ─────────────────────────────────────

interface RawAuditRow {
  id: string;
  timestamp: string;
  action: string;
  tier: string;
  approval: string | null;
  reasoning: string;
  params: string;
  result: string;
  error: string | null;
  state_before: string | null;
  state_after: string | null;
  plan_id: string | null;
  step_id: string | null;
  duration_ms: number;
}

function deserializeRow(row: RawAuditRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    action: row.action,
    tier: row.tier as AuditEntry["tier"],
    approval: row.approval ? JSON.parse(row.approval) : undefined,
    reasoning: row.reasoning,
    params: JSON.parse(row.params),
    result: row.result as AuditEntry["result"],
    error: row.error ?? undefined,
    state_before: row.state_before ? JSON.parse(row.state_before) : undefined,
    state_after: row.state_after ? JSON.parse(row.state_after) : undefined,
    plan_id: row.plan_id ?? undefined,
    step_id: row.step_id ?? undefined,
    duration_ms: row.duration_ms,
  };
}
