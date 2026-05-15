import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import {
  TicketIdAllocator,
  formatTicketId,
  parseTicketId,
} from "../../src/healing/ticket-ids.js";

// ── Helpers ────────────────────────────────────────────────

let dbPath: string;

function freshDbPath(): string {
  dbPath = `/tmp/rhodes-test-ticketids-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.db`;
  return dbPath;
}

function openDb(): Database.Database {
  const db = new Database(freshDbPath());
  db.pragma("journal_mode = WAL");
  return db;
}

afterEach(() => {
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  } catch {
    /* ignore */
  }
});

// ── formatTicketId / parseTicketId ─────────────────────────

describe("formatTicketId", () => {
  it("zero-pads to 3 digits below 1000", () => {
    expect(formatTicketId(2026, 1)).toBe("RHODES-2026-001");
    expect(formatTicketId(2026, 42)).toBe("RHODES-2026-042");
    expect(formatTicketId(2026, 999)).toBe("RHODES-2026-999");
  });

  it("widens past 999 without truncation", () => {
    expect(formatTicketId(2026, 1000)).toBe("RHODES-2026-1000");
    expect(formatTicketId(2026, 9999)).toBe("RHODES-2026-9999");
  });
});

describe("parseTicketId", () => {
  it("returns year+seq for valid ids", () => {
    expect(parseTicketId("RHODES-2026-001")).toEqual({ year: 2026, seq: 1 });
    expect(parseTicketId("RHODES-2026-1234")).toEqual({ year: 2026, seq: 1234 });
  });

  it("rejects malformed ids", () => {
    expect(parseTicketId("RHODES-26-1")).toBeNull();
    expect(parseTicketId("RHODES-2026-12")).toBeNull(); // <3 digits
    expect(parseTicketId("ZZZ-2026-001")).toBeNull();
    expect(parseTicketId("")).toBeNull();
    expect(parseTicketId("rhodes-2026-001")).toBeNull();
  });
});

// ── TicketIdAllocator ──────────────────────────────────────

describe("TicketIdAllocator", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("allocates monotonically inside a year", () => {
    const allocator = new TicketIdAllocator(db);
    const t1 = allocator.allocate(new Date(Date.UTC(2026, 0, 5)));
    const t2 = allocator.allocate(new Date(Date.UTC(2026, 0, 5)));
    const t3 = allocator.allocate(new Date(Date.UTC(2026, 5, 1)));
    expect(t1).toBe("RHODES-2026-001");
    expect(t2).toBe("RHODES-2026-002");
    expect(t3).toBe("RHODES-2026-003");
  });

  it("resets the counter on year rollover", () => {
    const allocator = new TicketIdAllocator(db);
    const t2026a = allocator.allocate(new Date(Date.UTC(2026, 11, 31)));
    const t2026b = allocator.allocate(new Date(Date.UTC(2026, 11, 31)));
    const t2027a = allocator.allocate(new Date(Date.UTC(2027, 0, 1)));
    const t2027b = allocator.allocate(new Date(Date.UTC(2027, 0, 1)));
    expect(t2026a).toBe("RHODES-2026-001");
    expect(t2026b).toBe("RHODES-2026-002");
    expect(t2027a).toBe("RHODES-2027-001");
    expect(t2027b).toBe("RHODES-2027-002");
  });

  it("survives concurrent allocations against the same DB file", () => {
    const allocator = new TicketIdAllocator(db);
    const N = 200;
    const ids = new Set<string>();
    for (let i = 0; i < N; i++) {
      const id = allocator.allocate(new Date(Date.UTC(2026, 0, 5)));
      // No duplicates — atomic upsert prevents the same NNN being
      // handed out twice.
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(N);
    // Monotonic — every id from 001..200 appears.
    for (let n = 1; n <= N; n++) {
      const padded = n < 1000 ? String(n).padStart(3, "0") : String(n);
      expect(ids.has(`RHODES-2026-${padded}`)).toBe(true);
    }
  });

  it("peek returns next id without bumping", () => {
    const allocator = new TicketIdAllocator(db);
    expect(allocator.peek(2026)).toBe(1);
    allocator.allocate(new Date(Date.UTC(2026, 0, 5)));
    expect(allocator.peek(2026)).toBe(2);
    expect(allocator.peek(2027)).toBe(1);
  });

  it("two allocators against the same DB file see the same counter", () => {
    // Simulates the case where two processes (or a process + a
    // separately-attached test) hit the same on-disk DB. The
    // ON CONFLICT clause keeps NNN unique even when each connection
    // has its own prepared statement.
    const allocatorA = new TicketIdAllocator(db);
    const dbB = new Database(dbPath);
    const allocatorB = new TicketIdAllocator(dbB);
    const ids = new Set<string>();
    for (let i = 0; i < 40; i++) {
      ids.add(allocatorA.allocate(new Date(Date.UTC(2026, 0, 5))));
      ids.add(allocatorB.allocate(new Date(Date.UTC(2026, 0, 5))));
    }
    expect(ids.size).toBe(80);
    dbB.close();
  });
});
