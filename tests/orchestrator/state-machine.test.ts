// ============================================================
// Orchestrator State Machine — pure-function transitions.
// No I/O, no mocks needed. Thousands of paths per test if we wanted.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  transition,
  type HostUpgradeProgress,
  type UpgradeEvent,
  type UpgradeRun,
} from "../../src/orchestrator/index.js";

const NOW = "2026-05-18T22:00:00.000Z";
const LATER = "2026-05-18T22:05:00.000Z";

function mkRun(over: Partial<UpgradeRun> = {}): UpgradeRun {
  const hosts: HostUpgradeProgress[] = over.hosts ?? [
    { hostResourceId: "vsphere:vsphere_host:h1", state: "pending" },
    { hostResourceId: "vsphere:vsphere_host:h2", state: "pending" },
    { hostResourceId: "vsphere:vsphere_host:h3", state: "pending" },
  ];
  return {
    id: "run-1",
    planId: "plan-1",
    phase: "pending",
    currentHostIndex: -1,
    hosts,
    ...over,
  };
}

const approve: UpgradeEvent = {
  kind: "approve",
  actor: "pranav@shersystems.com",
  at: NOW,
};
const preflightOk: UpgradeEvent = {
  kind: "preflight_succeeded",
  at: NOW,
};
const preflightBad: UpgradeEvent = {
  kind: "preflight_failed",
  reason: "cluster missing capacity for N-1",
  at: NOW,
};
const stepOk: UpgradeEvent = { kind: "host_step_succeeded", at: NOW };
const stepBad: UpgradeEvent = {
  kind: "host_step_failed",
  reason: "vmware_host_enter_maintenance: NOT_RESPONDING",
  at: NOW,
};
const rbOk: UpgradeEvent = { kind: "rollback_succeeded", at: LATER };
const rbBad: UpgradeEvent = {
  kind: "rollback_failed",
  reason: "snapshot revert failed",
  at: LATER,
};
const abort: UpgradeEvent = {
  kind: "abort",
  actor: "pranav@shersystems.com",
  reason: "found a worse problem",
  at: NOW,
};

describe("transition (pure FSM)", () => {
  it("pending → approved on approve, asks runner to run preflight", () => {
    const r = transition(mkRun(), approve);
    expect(r.nextRun.phase).toBe("approved");
    expect(r.nextRun.startedAt).toBe(NOW);
    expect(r.nextAction).toBe("run_preflight");
  });

  it("preflight_succeeded transitions to executing and starts host 0", () => {
    const run = mkRun({ phase: "preflight", startedAt: NOW });
    const r = transition(run, preflightOk);
    expect(r.nextRun.phase).toBe("executing");
    expect(r.nextRun.currentHostIndex).toBe(0);
    expect(r.nextRun.hosts[0].state).toBe("entering_maintenance");
    expect(r.nextRun.hosts[0].startedAt).toBe(NOW);
    expect(r.nextRun.hosts[1].state).toBe("pending"); // untouched
    expect(r.nextAction).toBe("start_host_step");
  });

  it("preflight_failed transitions to failed with reason", () => {
    const run = mkRun({ phase: "preflight" });
    const r = transition(run, preflightBad);
    expect(r.nextRun.phase).toBe("failed");
    expect(r.nextRun.errorMessage).toContain("missing capacity");
    expect(r.nextAction).toBe("none");
  });

  it("walks per-host substates in order on consecutive host_step_succeeded", () => {
    let run = mkRun({
      phase: "executing",
      currentHostIndex: 0,
      hosts: [
        {
          hostResourceId: "vsphere:vsphere_host:h1",
          state: "entering_maintenance",
          startedAt: NOW,
        },
        { hostResourceId: "vsphere:vsphere_host:h2", state: "pending" },
      ],
    });

    const expectedProgression = [
      "evacuating",
      "remediating",
      "awaiting_reboot",
      "exiting_maintenance",
      "smoke_testing",
    ];
    for (const expected of expectedProgression) {
      const r = transition(run, stepOk);
      expect(r.nextRun.hosts[0].state).toBe(expected);
      expect(r.nextRun.currentHostIndex).toBe(0);
      expect(r.nextAction).toBe("start_host_step");
      run = r.nextRun;
    }
    // Next step completes host 0 and advances to host 1
    const r = transition(run, stepOk);
    expect(r.nextRun.currentHostIndex).toBe(1);
    expect(r.nextRun.hosts[0].state).toBe("completed");
    expect(r.nextRun.hosts[0].completedAt).toBe(NOW);
    expect(r.nextRun.hosts[1].state).toBe("entering_maintenance");
    expect(r.nextAction).toBe("start_host_step");
  });

  it("completes the entire run after the last host's smoke test succeeds", () => {
    const run = mkRun({
      phase: "executing",
      currentHostIndex: 2,
      hosts: [
        { hostResourceId: "vsphere:vsphere_host:h1", state: "completed" },
        { hostResourceId: "vsphere:vsphere_host:h2", state: "completed" },
        {
          hostResourceId: "vsphere:vsphere_host:h3",
          state: "smoke_testing",
          startedAt: NOW,
        },
      ],
    });
    const r = transition(run, stepOk);
    expect(r.nextRun.phase).toBe("completed");
    expect(r.nextRun.hosts[2].state).toBe("completed");
    expect(r.nextRun.completedAt).toBe(NOW);
    expect(r.nextAction).toBe("none");
  });

  it("host_step_failed enters rolling_back and marks current host failed", () => {
    const run = mkRun({
      phase: "executing",
      currentHostIndex: 1,
      hosts: [
        { hostResourceId: "vsphere:vsphere_host:h1", state: "completed" },
        {
          hostResourceId: "vsphere:vsphere_host:h2",
          state: "remediating",
          startedAt: NOW,
        },
        { hostResourceId: "vsphere:vsphere_host:h3", state: "pending" },
      ],
    });
    const r = transition(run, stepBad);
    expect(r.nextRun.phase).toBe("rolling_back");
    expect(r.nextRun.hosts[1].state).toBe("failed");
    expect(r.nextRun.hosts[1].errorMessage).toContain("NOT_RESPONDING");
    expect(r.nextRun.errorMessage).toContain("host[1]");
    expect(r.nextAction).toBe("start_rollback");
  });

  it("rollback_succeeded → failed (rolled back cleanly)", () => {
    const run = mkRun({
      phase: "rolling_back",
      errorMessage: "host[1] failed: remediate timed out",
    });
    const r = transition(run, rbOk);
    expect(r.nextRun.phase).toBe("failed");
    expect(r.nextRun.completedAt).toBe(LATER);
    expect(r.nextAction).toBe("none");
  });

  it("rollback_failed → failed with double-failure note", () => {
    const run = mkRun({
      phase: "rolling_back",
      errorMessage: "host[1] failed: remediate timed out",
    });
    const r = transition(run, rbBad);
    expect(r.nextRun.phase).toBe("failed");
    expect(r.nextRun.errorMessage).toContain("rollback also failed");
    expect(r.nextRun.errorMessage).toContain("snapshot revert");
    expect(r.nextRun.errorMessage).toContain("host[1]");
    expect(r.nextAction).toBe("none");
  });

  it("abort wins in pending", () => {
    const r = transition(mkRun(), abort);
    expect(r.nextRun.phase).toBe("aborted");
    expect(r.nextRun.errorMessage).toContain("aborted by");
    expect(r.nextRun.errorMessage).toContain("found a worse problem");
    expect(r.nextAction).toBe("none");
  });

  it("abort wins in executing too", () => {
    const run = mkRun({
      phase: "executing",
      currentHostIndex: 1,
      hosts: [
        { hostResourceId: "h1", state: "completed" },
        { hostResourceId: "h2", state: "evacuating", startedAt: NOW },
        { hostResourceId: "h3", state: "pending" },
      ],
    });
    const r = transition(run, abort);
    expect(r.nextRun.phase).toBe("aborted");
    expect(r.nextAction).toBe("none");
  });

  it("terminal phases ignore all events (idempotent)", () => {
    for (const phase of ["completed", "failed", "aborted"] as const) {
      const run = mkRun({ phase, completedAt: NOW });
      const r = transition(run, approve);
      expect(r.nextRun.phase).toBe(phase);
      expect(r.nextAction).toBe("none");
    }
  });

  it("approved + preflight_succeeded skips ahead to executing if runner is fast", () => {
    const run = mkRun({ phase: "approved", startedAt: NOW });
    const r = transition(run, preflightOk);
    expect(r.nextRun.phase).toBe("executing");
    expect(r.nextRun.currentHostIndex).toBe(0);
  });

  it("empty host list completes immediately on preflight_succeeded", () => {
    const run = mkRun({ phase: "preflight", hosts: [] });
    const r = transition(run, preflightOk);
    expect(r.nextRun.phase).toBe("completed");
    expect(r.nextRun.completedAt).toBe(NOW);
    expect(r.nextAction).toBe("none");
  });

  it("unrelated events are ignored (no state change, no action)", () => {
    const r = transition(mkRun(), stepOk); // host_step_succeeded in pending = ignore
    expect(r.nextRun.phase).toBe("pending");
    expect(r.nextAction).toBe("none");
  });
});
