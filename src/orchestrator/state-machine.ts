// ============================================================
// RHODES — Orchestrator State Machine (pure transitions)
//
// `transition(currentRun, event) → TransitionResult` is the single
// pure entry point. No I/O. Given a current UpgradeRun and an event,
// returns the next UpgradeRun plus what the runner should do next.
//
// The runner does the I/O — it calls primitives, posts to Slack,
// reads the graph — and feeds the result back through transition()
// to compute the new state. This keeps the FSM testable in isolation:
// thousands of transitions per test, deterministic, no mocks.
//
// Invariants the FSM enforces:
//
// - Terminal phases (completed / failed / aborted) reject all events
//   (idempotent — returns same run, action `none`).
// - `abort` is accepted in any non-terminal phase and always wins.
// - `currentHostIndex` is always `-1` outside the executing phase or
//   a valid index into `hosts[]` while executing.
// - `hosts[currentHostIndex].state` is always one of the non-terminal
//   sub-states (`pending`..`smoke_testing`) while phase is executing
//   and currentHostIndex points at a real host.
// - `startedAt` is set when phase first leaves `pending`.
// - `completedAt` and `errorMessage` are set when phase enters a
//   terminal value.
// ============================================================

import type {
  HostUpgradeProgress,
  HostUpgradeState,
  TransitionResult,
  UpgradeEvent,
  UpgradeRun,
} from "./types.js";
import { TERMINAL_PHASES, nextHostState } from "./types.js";

/**
 * The FSM. Pure function — no side effects, no I/O. Caller persists
 * `result.nextRun` and acts on `result.nextAction`.
 */
export function transition(
  run: UpgradeRun,
  event: UpgradeEvent,
): TransitionResult {
  // Terminal phases reject everything except idempotent re-asserts.
  if (TERMINAL_PHASES.has(run.phase)) {
    return { nextRun: run, nextAction: "none" };
  }

  // Abort always wins (in any non-terminal phase).
  if (event.kind === "abort") {
    return {
      nextRun: {
        ...run,
        phase: "aborted",
        completedAt: event.at,
        errorMessage: `aborted by ${event.actor}: ${event.reason}`,
      },
      nextAction: "none",
    };
  }

  switch (run.phase) {
    case "pending":
      return handlePending(run, event);
    case "approved":
      return handleApproved(run, event);
    case "preflight":
      return handlePreflight(run, event);
    case "executing":
      return handleExecuting(run, event);
    case "rolling_back":
      return handleRollingBack(run, event);
    default:
      // Should be unreachable — TERMINAL_PHASES handled above.
      return { nextRun: run, nextAction: "none" };
  }
}

// ── Per-phase handlers ─────────────────────────────────────

function handlePending(
  run: UpgradeRun,
  event: UpgradeEvent,
): TransitionResult {
  if (event.kind === "approve") {
    return {
      nextRun: {
        ...run,
        phase: "approved",
        startedAt: event.at,
      },
      nextAction: "run_preflight",
    };
  }
  return ignore(run);
}

function handleApproved(
  run: UpgradeRun,
  event: UpgradeEvent,
): TransitionResult {
  // `approved` is a brief intermediate state — runner kicks preflight
  // immediately. We accept preflight_succeeded/failed here too in case
  // the runner is fast and the FSM hasn't seen a phase-tick event in
  // between. (We don't model a separate "preflight_started" event —
  // the runner just calls and feeds back the result.)
  if (event.kind === "preflight_succeeded") {
    return advanceToFirstHost(run, event.at);
  }
  if (event.kind === "preflight_failed") {
    return failRun(run, event.at, `preflight failed: ${event.reason}`);
  }
  // If for some reason the runner re-emits run_preflight intent, accept it.
  return { nextRun: { ...run, phase: "preflight" }, nextAction: "run_preflight" };
}

function handlePreflight(
  run: UpgradeRun,
  event: UpgradeEvent,
): TransitionResult {
  if (event.kind === "preflight_succeeded") {
    return advanceToFirstHost(run, event.at);
  }
  if (event.kind === "preflight_failed") {
    return failRun(run, event.at, `preflight failed: ${event.reason}`);
  }
  return ignore(run);
}

function handleExecuting(
  run: UpgradeRun,
  event: UpgradeEvent,
): TransitionResult {
  if (event.kind === "host_step_succeeded") {
    return advanceHostStep(run, event.at);
  }
  if (event.kind === "host_step_failed") {
    return startRollback(run, event.at, event.reason);
  }
  return ignore(run);
}

function handleRollingBack(
  run: UpgradeRun,
  event: UpgradeEvent,
): TransitionResult {
  if (event.kind === "rollback_succeeded") {
    // Rollback clean, but the run still failed (a host hit
    // host_step_failed earlier).
    return {
      nextRun: {
        ...run,
        phase: "failed",
        completedAt: event.at,
        errorMessage: run.errorMessage ?? "rolled back after failure",
      },
      nextAction: "none",
    };
  }
  if (event.kind === "rollback_failed") {
    return {
      nextRun: {
        ...run,
        phase: "failed",
        completedAt: event.at,
        errorMessage: `rollback also failed: ${event.reason}; original error: ${run.errorMessage ?? "unknown"}`,
      },
      nextAction: "none",
    };
  }
  return ignore(run);
}

// ── Helpers ────────────────────────────────────────────────

function advanceToFirstHost(run: UpgradeRun, at: string): TransitionResult {
  // No hosts? Empty cluster — succeed immediately.
  if (run.hosts.length === 0) {
    return {
      nextRun: {
        ...run,
        phase: "completed",
        completedAt: at,
      },
      nextAction: "none",
    };
  }
  const hosts = run.hosts.map((h, i) =>
    i === 0
      ? { ...h, state: "entering_maintenance" as HostUpgradeState, startedAt: at }
      : h,
  );
  return {
    nextRun: {
      ...run,
      phase: "executing",
      currentHostIndex: 0,
      hosts,
    },
    nextAction: "start_host_step",
  };
}

function advanceHostStep(run: UpgradeRun, at: string): TransitionResult {
  const idx = run.currentHostIndex;
  const current = run.hosts[idx];
  if (!current) {
    // Defensive — currentHostIndex out of range; treat as completed.
    return {
      nextRun: { ...run, phase: "completed", completedAt: at },
      nextAction: "none",
    };
  }

  const next = nextHostState(current.state);
  // If the sub-state progression is exhausted (smoke_testing → completed),
  // mark host completed and try to move to the next host.
  if (next === null || next === "completed") {
    return moveToNextHost(run, idx, at);
  }

  // Still inside the same host — advance its sub-state.
  const updatedHosts = run.hosts.map((h, i) =>
    i === idx ? { ...h, state: next } : h,
  );
  return {
    nextRun: { ...run, hosts: updatedHosts },
    nextAction: "start_host_step",
  };
}

function moveToNextHost(
  run: UpgradeRun,
  doneIdx: number,
  at: string,
): TransitionResult {
  const hostsWithCompletion = run.hosts.map((h, i) =>
    i === doneIdx
      ? { ...h, state: "completed" as HostUpgradeState, completedAt: at }
      : h,
  );

  const nextIdx = doneIdx + 1;
  if (nextIdx >= run.hosts.length) {
    // All done.
    return {
      nextRun: {
        ...run,
        phase: "completed",
        currentHostIndex: nextIdx,
        hosts: hostsWithCompletion,
        completedAt: at,
      },
      nextAction: "none",
    };
  }

  // Begin the next host.
  const finalHosts = hostsWithCompletion.map((h, i) =>
    i === nextIdx
      ? { ...h, state: "entering_maintenance" as HostUpgradeState, startedAt: at }
      : h,
  );
  return {
    nextRun: {
      ...run,
      currentHostIndex: nextIdx,
      hosts: finalHosts,
    },
    nextAction: "start_host_step",
  };
}

function startRollback(
  run: UpgradeRun,
  at: string,
  reason: string,
): TransitionResult {
  const idx = run.currentHostIndex;
  const hosts: HostUpgradeProgress[] = run.hosts.map((h, i) =>
    i === idx
      ? {
          ...h,
          state: "failed" as HostUpgradeState,
          completedAt: at,
          errorMessage: reason,
        }
      : h,
  );
  return {
    nextRun: {
      ...run,
      phase: "rolling_back",
      hosts,
      errorMessage: `host[${idx}] failed: ${reason}`,
    },
    nextAction: "start_rollback",
  };
}

function failRun(
  run: UpgradeRun,
  at: string,
  reason: string,
): TransitionResult {
  return {
    nextRun: {
      ...run,
      phase: "failed",
      completedAt: at,
      errorMessage: reason,
    },
    nextAction: "none",
  };
}

function ignore(run: UpgradeRun): TransitionResult {
  return { nextRun: run, nextAction: "none" };
}
