// ============================================================
// Orchestrator Store — plan + run CRUD, persistRun snapshots,
// listActiveRuns for crash-recovery.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrchestratorStore } from "../../src/orchestrator/index.js";

function fixturePlanInput(over: Partial<{
  clusterResourceId: string;
  targetVersion: string;
  sourceVersion: string;
  hostResourceIds: string[];
  evacuationMode: "live_migrate" | "evict" | "replace";
  createdBy: string;
}> = {}) {
  return {
    clusterResourceId: "vsphere:vsphere_cluster:prod-east",
    targetVersion: "8.0u3",
    sourceVersion: "8.0u2",
    hostResourceIds: [
      "vsphere:vsphere_host:h1",
      "vsphere:vsphere_host:h2",
      "vsphere:vsphere_host:h3",
    ],
    evacuationMode: "live_migrate" as const,
    createdBy: "pranav@shersystems.com",
    ...over,
  };
}

describe("OrchestratorStore", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-orch-test-"));
    store = new OrchestratorStore(join(dir, "orchestrator.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("createPlan persists every field and assigns a UUID", () => {
    const plan = store.createPlan(fixturePlanInput());
    expect(plan.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.clusterResourceId).toBe("vsphere:vsphere_cluster:prod-east");
    expect(plan.targetVersion).toBe("8.0u3");
    expect(plan.sourceVersion).toBe("8.0u2");
    expect(plan.hostResourceIds).toHaveLength(3);
    expect(plan.evacuationMode).toBe("live_migrate");
    expect(plan.createdBy).toBe("pranav@shersystems.com");
    expect(plan.approvedAt).toBeUndefined();

    const fetched = store.getPlan(plan.id);
    expect(fetched).toEqual(plan);
  });

  it("recordApproval sets approvedAt + approvedBy", () => {
    const plan = store.createPlan(fixturePlanInput());
    const approved = store.recordApproval(plan.id, "pranav@shersystems.com");
    expect(approved.approvedBy).toBe("pranav@shersystems.com");
    expect(approved.approvedAt).toBeDefined();
  });

  it("listPlansForCluster returns the cluster's plans newest first", () => {
    const planA = store.createPlan(
      fixturePlanInput({ clusterResourceId: "vsphere:vsphere_cluster:c1" }),
    );
    // Hack a small wait so created_at differs deterministically.
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    return wait(5).then(() => {
      const planB = store.createPlan(
        fixturePlanInput({ clusterResourceId: "vsphere:vsphere_cluster:c1" }),
      );
      store.createPlan(
        fixturePlanInput({ clusterResourceId: "vsphere:vsphere_cluster:other" }),
      );
      const plans = store.listPlansForCluster("vsphere:vsphere_cluster:c1");
      expect(plans).toHaveLength(2);
      expect(plans[0].id).toBe(planB.id); // newest first
      expect(plans[1].id).toBe(planA.id);
    });
  });

  it("createRun seeds pending hosts from the plan's host list", () => {
    const plan = store.createPlan(fixturePlanInput());
    const run = store.createRun(plan.id);
    expect(run.planId).toBe(plan.id);
    expect(run.phase).toBe("pending");
    expect(run.currentHostIndex).toBe(-1);
    expect(run.hosts).toHaveLength(3);
    expect(run.hosts.every((h) => h.state === "pending")).toBe(true);
    expect(run.hosts[0].hostResourceId).toBe("vsphere:vsphere_host:h1");
  });

  it("createRun throws when plan id doesn't exist", () => {
    expect(() => store.createRun("00000000-0000-0000-0000-000000000000")).toThrow(
      /not found/,
    );
  });

  it("persistRun snapshots the run (upsert by id, idempotent)", () => {
    const plan = store.createPlan(fixturePlanInput());
    const run = store.createRun(plan.id);
    const next = {
      ...run,
      phase: "executing" as const,
      currentHostIndex: 0,
      hosts: run.hosts.map((h, i) =>
        i === 0 ? { ...h, state: "remediating" as const } : h,
      ),
      startedAt: new Date().toISOString(),
    };
    store.persistRun(next);
    store.persistRun(next); // idempotent
    const fetched = store.getRun(run.id);
    expect(fetched?.phase).toBe("executing");
    expect(fetched?.currentHostIndex).toBe(0);
    expect(fetched?.hosts[0].state).toBe("remediating");

    const all = store.listAllRuns();
    expect(all).toHaveLength(1); // no duplicates
  });

  it("listActiveRuns excludes terminal phases", () => {
    const plan = store.createPlan(fixturePlanInput());
    const r1 = store.createRun(plan.id);
    const r2 = store.createRun(plan.id);
    const r3 = store.createRun(plan.id);
    store.persistRun({ ...r1, phase: "executing", startedAt: "now" });
    store.persistRun({ ...r2, phase: "completed", completedAt: "now" });
    store.persistRun({ ...r3, phase: "rolling_back" });

    const active = store.listActiveRuns();
    expect(active.map((r) => r.id).sort()).toEqual([r1.id, r3.id].sort());
  });

  it("cascade-delete: removing a plan removes its runs", () => {
    const plan = store.createPlan(fixturePlanInput());
    store.createRun(plan.id);
    store.createRun(plan.id);
    expect(store.listAllRuns()).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db as import("better-sqlite3").Database;
    db.prepare("DELETE FROM upgrade_plans WHERE id = ?").run(plan.id);
    expect(store.listAllRuns()).toHaveLength(0);
  });
});
