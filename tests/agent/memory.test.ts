// ============================================================
// Tests — AgentMemory (SQLite-backed)
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { AgentMemory } from "../../src/agent/memory.js";
import { unlinkSync, existsSync } from "node:fs";

let memory: AgentMemory;
let dbPath: string;

function freshMemory(): AgentMemory {
  dbPath = `/tmp/vclaw-test-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  memory = new AgentMemory(dbPath);
  return memory;
}

afterEach(() => {
  try {
    memory?.close();
  } catch {
    // already closed
  }
  // Clean up DB file and WAL/SHM sidecar files
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) {
      unlinkSync(p);
    }
  }
});

describe("AgentMemory", () => {
  // ── save ────────────────────────────────────────────────────

  it("save() returns a UUID", () => {
    const mem = freshMemory();
    const id = mem.save({
      type: "preference",
      key: "default_ram",
      value: "4096",
      confidence: 0.9,
    });

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // ── recall ──────────────────────────────────────────────────

  it("recall() returns saved entries", () => {
    const mem = freshMemory();
    mem.save({ type: "pattern", key: "vm_naming", value: "prefix-role-N", confidence: 0.8 });

    const results = mem.recall();
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("vm_naming");
    expect(results[0].value).toBe("prefix-role-N");
  });

  it("recall() filters by type", () => {
    const mem = freshMemory();
    mem.save({ type: "preference", key: "k1", value: "v1", confidence: 0.5 });
    mem.save({ type: "pattern", key: "k2", value: "v2", confidence: 0.5 });
    mem.save({ type: "failure", key: "k3", value: "v3", confidence: 0.5 });

    const patterns = mem.recall("pattern");
    expect(patterns).toHaveLength(1);
    expect(patterns[0].key).toBe("k2");
  });

  it("recall() filters by key (LIKE match)", () => {
    const mem = freshMemory();
    mem.save({ type: "preference", key: "disk_size", value: "100", confidence: 0.7 });
    mem.save({ type: "preference", key: "ram_size", value: "4096", confidence: 0.7 });
    mem.save({ type: "preference", key: "disk_type", value: "ssd", confidence: 0.7 });

    const results = mem.recall(undefined, "disk");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.key.includes("disk"))).toBe(true);
  });

  it("recall() respects limit", () => {
    const mem = freshMemory();
    for (let i = 0; i < 10; i++) {
      mem.save({ type: "pattern", key: `key_${i}`, value: `val_${i}`, confidence: 0.5 });
    }

    const results = mem.recall(undefined, undefined, 3);
    expect(results).toHaveLength(3);
  });

  it("recall() ordered by last_used_at DESC", () => {
    const mem = freshMemory();
    const id1 = mem.save({ type: "pattern", key: "older", value: "a", confidence: 0.5 });

    // Touch the first entry so its last_used_at is newer
    mem.touch(id1);

    mem.save({ type: "pattern", key: "newer", value: "b", confidence: 0.5 });

    const results = mem.recall("pattern");
    // Most recently saved comes first (DESC by last_used_at)
    expect(results[0].key).toBe("newer");
    expect(results[1].key).toBe("older");
  });

  // ── UPSERT ─────────────────────────────────────────────────

  it("save() with same type+key does UPSERT (updates value and confidence)", () => {
    const mem = freshMemory();
    mem.save({ type: "preference", key: "ram", value: "2048", confidence: 0.5 });
    mem.save({ type: "preference", key: "ram", value: "4096", confidence: 0.9 });

    const results = mem.recall("preference");
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe("4096");
    expect(results[0].confidence).toBe(0.9);
  });

  // ── touch ───────────────────────────────────────────────────

  it("touch() updates last_used_at and increments use_count", () => {
    const mem = freshMemory();
    const id = mem.save({ type: "pattern", key: "touch_test", value: "x", confidence: 0.5 });

    const before = mem.getByKey("touch_test")!;
    expect(before.use_count).toBe(0);

    mem.touch(id);
    const after = mem.getByKey("touch_test")!;
    expect(after.use_count).toBe(1);
    expect(after.last_used_at >= before.last_used_at).toBe(true);
  });

  // ── forget ──────────────────────────────────────────────────

  it("forget() deletes the entry", () => {
    const mem = freshMemory();
    const id = mem.save({ type: "failure", key: "bad_vm", value: "crashed", confidence: 0.6 });

    mem.forget(id);

    const results = mem.recall("failure");
    expect(results).toHaveLength(0);
  });

  // ── getByKey ────────────────────────────────────────────────

  it("getByKey() returns the entry by key", () => {
    const mem = freshMemory();
    mem.save({ type: "environment", key: "proxmox_host", value: "10.0.0.1", confidence: 1.0 });

    const entry = mem.getByKey("proxmox_host");
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe("10.0.0.1");
    expect(entry!.type).toBe("environment");
  });

  it("getByKey() returns null for unknown key", () => {
    const mem = freshMemory();
    expect(mem.getByKey("nonexistent")).toBeNull();
  });

  // ── close ───────────────────────────────────────────────────

  it("close() doesn't throw", () => {
    const mem = freshMemory();
    expect(() => mem.close()).not.toThrow();
  });
});
