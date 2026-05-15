// ============================================================
// RHODES — Ticket ID Allocator
//
// Human-readable engineering-ticket identifiers in the form
// `RHODES-YYYY-NNN` (zero-padded to 3, widening to 4+ once a
// year hits 1000). Sequence resets on Jan 1 — each year keeps
// its own counter row.
//
// Storage: a tiny SQLite table keyed by year. Allocation is a
// single atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`
// statement, so two concurrent callers cannot collide on the
// same NNN without one of the two seeing the bumped value.
// `better-sqlite3` already serializes writes inside one
// process; the atomic upsert keeps us safe across separate
// connections to the same DB file as well.
//
// The allocator is intentionally storage-only — it doesn't
// know what an incident or a ticket is. The Ticket layer in
// `ticket-store.ts` calls `allocate(detectedAt)` once per
// new ticket and stamps the returned id into the row it
// persists.
// ============================================================

import Database from "better-sqlite3";

/**
 * Minimal subset of `better-sqlite3.Database` used by the allocator.
 * Defined as a structural type so callers can hand in either a real
 * `Database` or a sqlite-compatible mock without forcing a vitest
 * `vi.mock` of the whole module.
 */
export interface TicketIdDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

/** Pads `n` to 3 digits, expanding to whatever is needed past 999. */
export function formatTicketId(year: number, seq: number): string {
  const padded = seq < 1000 ? String(seq).padStart(3, "0") : String(seq);
  return `RHODES-${year}-${padded}`;
}

/**
 * Parse a ticket id into `{year, seq}`. Returns `null` for any input
 * that doesn't match. Used by the API routes when an operator passes a
 * human-readable id in the URL and we need to verify it before lookup.
 */
export function parseTicketId(id: string): { year: number; seq: number } | null {
  const match = /^RHODES-(\d{4})-(\d{3,})$/.exec(id);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const seq = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(seq)) return null;
  return { year, seq };
}

/**
 * Atomic ticket-id allocator. One instance per DB file. Safe to share
 * between concurrent callers in-process — every `allocate` call goes
 * through a single prepared statement that performs an
 * INSERT-or-UPDATE in one shot.
 */
export class TicketIdAllocator {
  private readonly db: TicketIdDb;
  private readonly bumpStmt: ReturnType<TicketIdDb["prepare"]>;

  constructor(db: TicketIdDb) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_id_sequence (
        year      INTEGER PRIMARY KEY,
        last_seq  INTEGER NOT NULL
      );
    `);

    // ON CONFLICT … DO UPDATE … RETURNING is supported by SQLite
    // 3.35+ (the one shipping with better-sqlite3 today). The
    // statement atomically:
    //   - inserts (year, 1) for the first ticket of a new year, OR
    //   - increments last_seq by 1 for an existing year row,
    // then returns the resulting last_seq.
    this.bumpStmt = this.db.prepare(`
      INSERT INTO ticket_id_sequence (year, last_seq)
      VALUES (@year, 1)
      ON CONFLICT(year) DO UPDATE SET last_seq = last_seq + 1
      RETURNING last_seq AS seq
    `);
  }

  /**
   * Allocate the next ticket id for the year of `now`. `now` defaults
   * to the current wallclock — callers pass an explicit `Date` for
   * tests and for backfilling pre-existing incidents (so the ticket id
   * year-matches the incident's `detected_at`).
   */
  allocate(now: Date = new Date()): string {
    const year = now.getUTCFullYear();
    const row = this.bumpStmt.get({ year }) as { seq: number } | undefined;
    if (!row || typeof row.seq !== "number") {
      throw new Error(`ticket-id allocator returned no row for year=${year}`);
    }
    return formatTicketId(year, row.seq);
  }

  /**
   * Peek the next id that would be allocated without consuming it.
   * Used in tests to verify counter state. Not exposed via API.
   */
  peek(year: number): number {
    const row = this.db
      .prepare(`SELECT last_seq FROM ticket_id_sequence WHERE year = ?`)
      .get(year) as { last_seq: number } | undefined;
    return (row?.last_seq ?? 0) + 1;
  }
}

/** Convenience helper for the in-process default. */
export function openTicketIdAllocator(dbPath: string): TicketIdAllocator {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return new TicketIdAllocator(db);
}
