import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { AuditLog } from "../../src/governance/audit.js";
import type { AuditEntry } from "../../src/types.js";

// ── Helpers ─────────────────────────────────────────────────

function makeDbPath(): string {
  return `/tmp/vclaw-test-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

let counter = 0;
function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  counter++;
  return {
    id: overrides.id ?? `entry-${counter}`,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    action: overrides.action ?? "create_vm",
    tier: overrides.tier ?? "safe_write",
    approval: overrides.approval,
    reasoning: overrides.reasoning ?? "Test reasoning",
    params: overrides.params ?? { name: "test-vm" },
    result: overrides.result ?? "success",
    error: overrides.error,
    state_before: overrides.state_before,
    state_after: overrides.state_after,
    plan_id: overrides.plan_id,
    step_id: overrides.step_id,
    duration_ms: overrides.duration_ms ?? 150,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("AuditLog", () => {
  let dbPath: string;
  let audit: AuditLog;

  beforeEach(() => {
    dbPath = makeDbPath();
    audit = new AuditLog(dbPath);
  });

  afterEach(() => {
    audit.close();
    if (existsSync(dbPath)) {
      try { unlinkSync(dbPath); } catch { /* ignore */ }
    }
    // Clean up WAL/SHM files
    for (const suffix of ["-wal", "-shm"]) {
      const f = dbPath + suffix;
      if (existsSync(f)) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    }
  });

  it("log() inserts an entry and query() retrieves it", () => {
    const entry = makeEntry({ id: "test-1", action: "list_vms" });
    audit.log(entry);

    const results = audit.query();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("test-1");
    expect(results[0].action).toBe("list_vms");
  });

  it("query() with no filters returns all entries (up to limit)", () => {
    audit.log(makeEntry({ id: "a1" }));
    audit.log(makeEntry({ id: "a2" }));
    audit.log(makeEntry({ id: "a3" }));

    const results = audit.query();
    expect(results).toHaveLength(3);
  });

  it("query() filters by action", () => {
    audit.log(makeEntry({ id: "b1", action: "create_vm" }));
    audit.log(makeEntry({ id: "b2", action: "delete_vm" }));
    audit.log(makeEntry({ id: "b3", action: "create_vm" }));

    const results = audit.query({ action: "create_vm" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === "create_vm")).toBe(true);
  });

  it("query() filters by tier", () => {
    audit.log(makeEntry({ id: "c1", tier: "read" }));
    audit.log(makeEntry({ id: "c2", tier: "destructive" }));
    audit.log(makeEntry({ id: "c3", tier: "read" }));

    const results = audit.query({ tier: "read" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.tier === "read")).toBe(true);
  });

  it("query() filters by result", () => {
    audit.log(makeEntry({ id: "d1", result: "success" }));
    audit.log(makeEntry({ id: "d2", result: "failed" }));
    audit.log(makeEntry({ id: "d3", result: "success" }));

    const results = audit.query({ result: "failed" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("d2");
  });

  it("query() filters by since (ISO date)", () => {
    const old = "2024-01-01T00:00:00.000Z";
    const recent = "2026-03-22T12:00:00.000Z";

    audit.log(makeEntry({ id: "e1", timestamp: old }));
    audit.log(makeEntry({ id: "e2", timestamp: recent }));

    const results = audit.query({ since: "2025-01-01T00:00:00.000Z" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("e2");
  });

  it("query() with limit", () => {
    for (let i = 0; i < 10; i++) {
      audit.log(makeEntry({ id: `f${i}` }));
    }

    const results = audit.query({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("query() returns entries ordered by timestamp DESC", () => {
    audit.log(makeEntry({ id: "g1", timestamp: "2026-01-01T00:00:00.000Z" }));
    audit.log(makeEntry({ id: "g2", timestamp: "2026-03-01T00:00:00.000Z" }));
    audit.log(makeEntry({ id: "g3", timestamp: "2026-02-01T00:00:00.000Z" }));

    const results = audit.query();
    expect(results[0].id).toBe("g2");
    expect(results[1].id).toBe("g3");
    expect(results[2].id).toBe("g1");
  });

  describe("getStats()", () => {
    beforeEach(() => {
      audit.log(makeEntry({ id: "s1", result: "success", tier: "read" }));
      audit.log(makeEntry({ id: "s2", result: "success", tier: "safe_write" }));
      audit.log(makeEntry({ id: "s3", result: "failed", tier: "risky_write" }));
      audit.log(makeEntry({ id: "s4", result: "blocked", tier: "destructive" }));
      audit.log(makeEntry({ id: "s5", result: "failed", tier: "read" }));
    });

    it("returns correct total count", () => {
      const stats = audit.getStats();
      expect(stats.total).toBe(5);
    });

    it("groups by_result correctly", () => {
      const stats = audit.getStats();
      expect(stats.by_result.success).toBe(2);
      expect(stats.by_result.failed).toBe(2);
      expect(stats.by_result.blocked).toBe(1);
    });

    it("groups by_tier correctly", () => {
      const stats = audit.getStats();
      expect(stats.by_tier.read).toBe(2);
      expect(stats.by_tier.safe_write).toBe(1);
      expect(stats.by_tier.risky_write).toBe(1);
      expect(stats.by_tier.destructive).toBe(1);
    });

    it("returns recent_failures (failed and blocked)", () => {
      const stats = audit.getStats();
      expect(stats.recent_failures).toHaveLength(3);
      const ids = stats.recent_failures.map((e) => e.id);
      expect(ids).toContain("s3");
      expect(ids).toContain("s4");
      expect(ids).toContain("s5");
    });
  });

  it("log() handles optional fields (null approval, state_before, state_after, plan_id, step_id, error)", () => {
    const entry = makeEntry({
      id: "opt-1",
      approval: undefined,
      state_before: undefined,
      state_after: undefined,
      plan_id: undefined,
      step_id: undefined,
      error: undefined,
    });
    audit.log(entry);

    const results = audit.query();
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.approval).toBeUndefined();
    expect(r.state_before).toBeUndefined();
    expect(r.state_after).toBeUndefined();
    expect(r.plan_id).toBeUndefined();
    expect(r.step_id).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("log() handles populated optional fields", () => {
    const entry = makeEntry({
      id: "opt-2",
      approval: {
        request_id: "req-1",
        approved: true,
        approved_by: "user",
        method: "cli",
        timestamp: new Date().toISOString(),
      },
      state_before: { status: "stopped" },
      state_after: { status: "running" },
      plan_id: "plan-1",
      step_id: "step-1",
      error: "some error",
    });
    audit.log(entry);

    const results = audit.query();
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.approval?.approved).toBe(true);
    expect(r.state_before).toEqual({ status: "stopped" });
    expect(r.state_after).toEqual({ status: "running" });
    expect(r.plan_id).toBe("plan-1");
    expect(r.step_id).toBe("step-1");
    expect(r.error).toBe("some error");
  });

  it("close() does not throw", () => {
    expect(() => audit.close()).not.toThrow();
  });
});
