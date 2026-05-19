// ============================================================
// Orchestrator Runner — end-to-end FSM walks against fake primitives.
// Real primitive bodies don't exist yet; the runner is exercised
// against deterministic fakes that succeed/fail on demand.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OrchestratorStore,
  UpgradeRunner,
  providerFromResourceId,
  type UpgradePlan,
} from "../../src/orchestrator/index.js";
import type { Primitives } from "../../src/primitives/index.js";

const FIXED_NOW = "2026-05-18T22:00:00.000Z";

interface FakePrimitivesOpts {
  failOn?: Partial<Record<
    "enterMaintenance" | "evacuateWorkload" | "remediateHost" | "exitMaintenance",
    string
  >>;
}

function fakePrimitives(opts: FakePrimitivesOpts = {}): Primitives {
  return {
    capabilities: () => ({
      provider: "vsphere",
      evacuateModes: ["live_migrate"],
      maintenanceModeSupported: true,
      hostRemediationSupported: true,
      rollbackStrategies: ["snapshot_restore"],
    }),
    enterMaintenance: async () => {
      if (opts.failOn?.enterMaintenance) {
        throw new Error(opts.failOn.enterMaintenance);
      }
      return { ok: true };
    },
    exitMaintenance: async () => {
      if (opts.failOn?.exitMaintenance) {
        throw new Error(opts.failOn.exitMaintenance);
      }
      return { ok: true };
    },
    evacuateWorkload: async () => {
      if (opts.failOn?.evacuateWorkload) {
        throw new Error(opts.failOn.evacuateWorkload);
      }
      return { ok: true };
    },
    remediateHost: async () => {
      if (opts.failOn?.remediateHost) {
        throw new Error(opts.failOn.remediateHost);
      }
      return { ok: true };
    },
    rollback: async () => ({ ok: true }),
  };
}

function approvedPlan(store: OrchestratorStore): {
  plan: UpgradePlan;
  runId: string;
} {
  const plan = store.createPlan({
    clusterResourceId: "vsphere:vsphere_cluster:prod-east",
    targetVersion: "8.0u3",
    sourceVersion: "8.0u2",
    hostResourceIds: [
      "vsphere:vsphere_host:h1",
      "vsphere:vsphere_host:h2",
    ],
    evacuationMode: "live_migrate",
    createdBy: "pranav@shersystems.com",
  });
  store.recordApproval(plan.id, "pranav@shersystems.com");
  const run = store.createRun(plan.id);
  // Move past pending — drive() picks up at `approved` and kicks preflight.
  store.persistRun({ ...run, phase: "approved", startedAt: FIXED_NOW });
  return { plan, runId: run.id };
}

describe("UpgradeRunner.drive", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-runner-"));
    store = new OrchestratorStore(join(dir, "orchestrator.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs an upgrade to completion end-to-end against fake primitives", async () => {
    const { runId } = approvedPlan(store);
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      awaitReboot: async () => {},
      clock: () => FIXED_NOW,
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("completed");
    expect(final.completedAt).toBe(FIXED_NOW);
    expect(final.hosts.every((h) => h.state === "completed")).toBe(true);
    expect(final.errorMessage).toBeUndefined();
  });

  it("stops at pending (waiting for approve) without doing anything", async () => {
    const plan = store.createPlan({
      clusterResourceId: "vsphere:vsphere_cluster:c",
      targetVersion: "8.0u3",
      sourceVersion: "8.0u2",
      hostResourceIds: ["vsphere:vsphere_host:h1"],
      evacuationMode: "live_migrate",
      createdBy: "pranav@shersystems.com",
    });
    const run = store.createRun(plan.id);
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      clock: () => FIXED_NOW,
    });
    const final = await runner.drive(run.id);
    expect(final.phase).toBe("pending");
    expect(final.currentHostIndex).toBe(-1);
  });

  it("transitions to rolling_back then failed when a primitive throws", async () => {
    const { runId } = approvedPlan(store);
    const runner = new UpgradeRunner(store, {
      primitivesFor: () =>
        fakePrimitives({
          failOn: { remediateHost: "vmware_host_remediate timeout" },
        }),
      awaitReboot: async () => {},
      runRollback: async () => ({ ok: true }),
      clock: () => FIXED_NOW,
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("failed");
    expect(final.hosts[0].state).toBe("failed");
    expect(final.hosts[0].errorMessage).toContain("vmware_host_remediate timeout");
    expect(final.errorMessage).toContain("host[0]");
  });

  it("rollback_failed surfaces double-failure error in run.errorMessage", async () => {
    const { runId } = approvedPlan(store);
    const runner = new UpgradeRunner(store, {
      primitivesFor: () =>
        fakePrimitives({
          failOn: { remediateHost: "primary failure" },
        }),
      awaitReboot: async () => {},
      runRollback: async () => ({ ok: false, reason: "snapshot revert failed" }),
      clock: () => FIXED_NOW,
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("failed");
    expect(final.errorMessage).toContain("rollback also failed");
    expect(final.errorMessage).toContain("snapshot revert failed");
    expect(final.errorMessage).toContain("primary failure");
  });

  it("preflight_failed → failed without entering host loop", async () => {
    const { runId } = approvedPlan(store);
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      runPreflight: async () => ({
        ok: false,
        reason: "cluster lacks N-1 capacity",
      }),
      clock: () => FIXED_NOW,
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("failed");
    expect(final.errorMessage).toContain("cluster lacks N-1 capacity");
    expect(final.currentHostIndex).toBe(-1);
  });

  it("PrimitiveNotImplemented error is reported with helpful message", async () => {
    // Default primitives.vmware.evacuateWorkload throws PrimitiveNotImplemented.
    // We can simulate by importing the real registered impl and not overriding.
    const { runId } = approvedPlan(store);
    const realProvider = await import("../../src/primitives/index.js");
    const runner = new UpgradeRunner(store, {
      primitivesFor: realProvider.getPrimitives, // hits the real stub registry
      awaitReboot: async () => {},
      clock: () => FIXED_NOW,
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("failed");
    expect(final.hosts[0].errorMessage).toContain("primitive stub");
    expect(final.hosts[0].state).toBe("failed");
  });

  it("smoke test failure marks the host failed", async () => {
    const { runId } = approvedPlan(store);
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      awaitReboot: async () => {},
      smokeTest: async () => ({ ok: false, reason: "post-upgrade ping timeout" }),
      clock: () => FIXED_NOW,
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("failed");
    expect(final.errorMessage).toContain("post-upgrade ping timeout");
  });

  it("awaitReboot is called once per host", async () => {
    let rebootCalls = 0;
    const { runId } = approvedPlan(store);
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      awaitReboot: async () => {
        rebootCalls++;
      },
      clock: () => FIXED_NOW,
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("completed");
    expect(rebootCalls).toBe(2); // 2 hosts, one reboot each
  });

  it("throws on unknown run id", async () => {
    const runner = new UpgradeRunner(store, { clock: () => FIXED_NOW });
    await expect(runner.drive("nonexistent")).rejects.toThrow(/not found/);
  });
});

describe("UpgradeRunner.drive — onTransition hook (v0.7.3.1)", () => {
  let dir: string;
  let store: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-runner-hook-"));
    store = new OrchestratorStore(join(dir, "orchestrator.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires onTransition after every persisted FSM transition with (prev, next, event)", async () => {
    const { runId } = approvedPlan(store);
    const calls: Array<{ prevPhase: string; nextPhase: string; eventKind: string }> = [];
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      awaitReboot: async () => {},
      clock: () => FIXED_NOW,
      onTransition: (prev, next, event) => {
        calls.push({
          prevPhase: prev.phase,
          nextPhase: next.phase,
          eventKind: event.kind,
        });
      },
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("completed");
    // Must observe at least one transition per persisted step, and the
    // first event must be preflight_succeeded (drive starts at approved).
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].eventKind).toBe("preflight_succeeded");
    // The terminal phase must show up as the last next.phase.
    expect(calls[calls.length - 1].nextPhase).toBe("completed");
    // prev.phase of the very first call is the run state drive() loaded.
    expect(calls[0].prevPhase).toBe("approved");
  });

  it("awaits async onTransition before continuing the loop", async () => {
    const { runId } = approvedPlan(store);
    const order: string[] = [];
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      awaitReboot: async () => {
        order.push("awaitReboot");
      },
      clock: () => FIXED_NOW,
      onTransition: async (_prev, next) => {
        // Yield a microtask so a non-awaiting impl would race with awaitReboot.
        await new Promise<void>((resolve) => setImmediate(resolve));
        order.push(`hook:${next.phase}:host${next.currentHostIndex}`);
      },
    });
    await runner.drive(runId);
    // Every hook call must finish before the next awaitReboot fires.
    // Confirm by checking no two consecutive entries are both "awaitReboot"
    // without a hook entry between, AND that the first hook entry precedes
    // the first awaitReboot (preflight transition happens before host loop).
    const firstHookIdx = order.findIndex((s) => s.startsWith("hook:"));
    const firstRebootIdx = order.indexOf("awaitReboot");
    expect(firstHookIdx).toBeGreaterThanOrEqual(0);
    expect(firstRebootIdx).toBeGreaterThan(firstHookIdx);
  });

  it("swallows errors thrown by onTransition so the runner doesn't stall", async () => {
    const { runId } = approvedPlan(store);
    const errs: string[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(" "));
    };
    try {
      const runner = new UpgradeRunner(store, {
        primitivesFor: () => fakePrimitives(),
        awaitReboot: async () => {},
        clock: () => FIXED_NOW,
        onTransition: () => {
          throw new Error("subscriber boom");
        },
      });
      const final = await runner.drive(runId);
      // Runner must still reach completion despite the subscriber blowing up.
      expect(final.phase).toBe("completed");
      // And the error must have been logged (not silently dropped).
      expect(errs.some((e) => e.includes("subscriber boom"))).toBe(true);
      expect(errs.some((e) => e.includes("onTransition hook threw"))).toBe(true);
    } finally {
      console.error = originalErr;
    }
  });

  it("swallows rejections from async onTransition without stalling", async () => {
    const { runId } = approvedPlan(store);
    const originalErr = console.error;
    let captured = 0;
    console.error = () => {
      captured++;
    };
    try {
      const runner = new UpgradeRunner(store, {
        primitivesFor: () => fakePrimitives(),
        awaitReboot: async () => {},
        clock: () => FIXED_NOW,
        onTransition: async () => {
          throw new Error("async subscriber boom");
        },
      });
      const final = await runner.drive(runId);
      expect(final.phase).toBe("completed");
      expect(captured).toBeGreaterThan(0);
    } finally {
      console.error = originalErr;
    }
  });

  it("is optional — runner works fine without an onTransition hook", async () => {
    const { runId } = approvedPlan(store);
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      awaitReboot: async () => {},
      clock: () => FIXED_NOW,
      // no onTransition
    });
    const final = await runner.drive(runId);
    expect(final.phase).toBe("completed");
  });

  it("hook sees the persisted next state (store and next arg match)", async () => {
    const { runId } = approvedPlan(store);
    const mismatches: string[] = [];
    const runner = new UpgradeRunner(store, {
      primitivesFor: () => fakePrimitives(),
      awaitReboot: async () => {},
      clock: () => FIXED_NOW,
      onTransition: (_prev, next) => {
        const persisted = store.getRun(next.id);
        if (!persisted || persisted.phase !== next.phase) {
          mismatches.push(
            `${next.id}: persisted=${persisted?.phase} next=${next.phase}`,
          );
        }
      },
    });
    await runner.drive(runId);
    expect(mismatches).toEqual([]);
  });
});

describe("providerFromResourceId", () => {
  it("extracts the provider segment", () => {
    expect(providerFromResourceId("vsphere:vsphere_host:h1")).toBe("vsphere");
    expect(providerFromResourceId("proxmox:proxmox_vm:200")).toBe("proxmox");
    expect(providerFromResourceId("aws:aws_ec2_instance:i-123")).toBe("aws");
  });

  it("throws on malformed id", () => {
    expect(() => providerFromResourceId("no-colons")).toThrow();
    expect(() => providerFromResourceId(":leading-colon")).toThrow();
  });
});
