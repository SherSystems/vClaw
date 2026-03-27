// ============================================================
// vClaw — Agent Memory (SQLite-backed)
// Cross-session memory for patterns, preferences, and learnings
// ============================================================

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryEntry } from "../types.js";

export class AgentMemory {
  private db: Database.Database;

  constructor(dbPath: string = "data/memory.db") {
    // Ensure the directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
      CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_type_key ON memory(type, key);
    `);
  }

  /**
   * Save a new memory entry. Returns the generated ID.
   */
  save(
    entry: Omit<MemoryEntry, "id" | "created_at" | "last_used_at" | "use_count">,
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO memory (id, type, key, value, confidence, created_at, last_used_at, use_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(type, key) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        last_used_at = excluded.last_used_at
    `);

    stmt.run(id, entry.type, entry.key, entry.value, entry.confidence, now, now);
    return id;
  }

  /**
   * Recall memory entries, optionally filtered by type and/or key.
   */
  recall(type?: string, key?: string, limit: number = 50): MemoryEntry[] {
    let sql = "SELECT * FROM memory WHERE 1=1";
    const params: unknown[] = [];

    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }

    if (key) {
      sql += " AND key LIKE ?";
      params.push(`%${key}%`);
    }

    sql += " ORDER BY last_used_at DESC, use_count DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as MemoryEntry[];
  }

  /**
   * Touch a memory entry — update last_used_at and increment use_count.
   */
  touch(id: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE memory SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?
    `);
    stmt.run(now, id);
  }

  /**
   * Forget (delete) a memory entry by ID.
   */
  forget(id: string): void {
    const stmt = this.db.prepare("DELETE FROM memory WHERE id = ?");
    stmt.run(id);
  }

  /**
   * Get a specific memory entry by its key.
   */
  getByKey(key: string): MemoryEntry | null {
    const stmt = this.db.prepare("SELECT * FROM memory WHERE key = ?");
    const row = stmt.get(key) as MemoryEntry | undefined;
    return row ?? null;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
