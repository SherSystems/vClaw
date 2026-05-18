// ============================================================
// Proxmox Maintenance Tracker — file persistence + in-memory.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileMaintenanceTracker,
  InMemoryMaintenanceTracker,
} from "../../src/primitives/proxmox-maintenance.js";

describe("InMemoryMaintenanceTracker", () => {
  it("markIn / isIn / markOut roundtrip", async () => {
    const t = new InMemoryMaintenanceTracker();
    expect(t.isIn("nodeA")).toBe(false);
    const meta = await t.markIn("nodeA", { reason: "test", planId: "plan-1" });
    expect(meta.reason).toBe("test");
    expect(meta.planId).toBe("plan-1");
    expect(t.isIn("nodeA")).toBe(true);
    expect(t.metaFor("nodeA")).toEqual(meta);
    const removed = await t.markOut("nodeA");
    expect(removed).toBe(true);
    expect(t.isIn("nodeA")).toBe(false);
    const removedAgain = await t.markOut("nodeA");
    expect(removedAgain).toBe(false);
  });

  it("list returns all entries", async () => {
    const t = new InMemoryMaintenanceTracker();
    await t.markIn("nodeA");
    await t.markIn("nodeB", { reason: "upgrade" });
    const entries = t.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.node).sort()).toEqual(["nodeA", "nodeB"]);
  });
});

describe("FileMaintenanceTracker", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-maint-"));
    path = join(dir, "proxmox-maintenance.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when file doesn't exist", () => {
    const t = new FileMaintenanceTracker(path);
    expect(t.list()).toEqual([]);
    expect(t.isIn("nodeA")).toBe(false);
  });

  it("persists markIn to disk and reloads on restart", async () => {
    const t1 = new FileMaintenanceTracker(path);
    await t1.markIn("nodeA", { reason: "v0.7.1.1 test", planId: "plan-xyz" });
    expect(existsSync(path)).toBe(true);

    // Simulate restart: new tracker instance reads the file
    const t2 = new FileMaintenanceTracker(path);
    expect(t2.isIn("nodeA")).toBe(true);
    expect(t2.metaFor("nodeA")?.reason).toBe("v0.7.1.1 test");
    expect(t2.metaFor("nodeA")?.planId).toBe("plan-xyz");
  });

  it("markOut removes from disk", async () => {
    const t = new FileMaintenanceTracker(path);
    await t.markIn("nodeA");
    await t.markIn("nodeB");
    expect(t.list()).toHaveLength(2);
    await t.markOut("nodeA");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(raw.nodes)).toEqual(["nodeB"]);
  });

  it("tolerates corrupt file and starts empty", () => {
    // Use a fresh sub-path to be paranoid about test isolation across
    // afterEach timing — directly under the test's dir, file name
    // distinct from the default so prior state can't carry over.
    const corruptPath = join(dir, "corrupt-test.json");
    writeFileSync(corruptPath, "{not valid json", "utf8");
    const t = new FileMaintenanceTracker(corruptPath);
    expect(t.list()).toEqual([]);
  });

  it("tolerates wrong schema and starts empty", () => {
    const wrongSchemaPath = join(dir, "wrong-schema-test.json");
    writeFileSync(
      wrongSchemaPath,
      JSON.stringify({ version: 999, totally: "different" }),
      "utf8",
    );
    const t = new FileMaintenanceTracker(wrongSchemaPath);
    expect(t.list()).toEqual([]);
  });

  it("write is atomic (tmp file doesn't linger after success)", async () => {
    const t = new FileMaintenanceTracker(path);
    await t.markIn("nodeA");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
