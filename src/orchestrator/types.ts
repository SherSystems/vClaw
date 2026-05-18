// ============================================================
// RHODES — Orchestrator Types (v0.7 cluster upgrade)
//
// The orchestrator composes the substrate-agnostic primitives
// (evacuate_workload, enter_maintenance, remediate_host, etc.) into
// coordinated multi-host plans like cluster upgrades. This module
// defines the contract — plans, runs, phases, per-host substates,
// transitions — without implementing the runner. The runner (next
// session) walks the FSM by calling primitives between transitions.
//
// Design decisions:
//
// 1. Plan vs Run separation. A `UpgradePlan` is the declarative
//    input (which cluster, which version, which hosts, what
//    evacuation mode). A `UpgradeRun` is the execution state (phase,
//    per-host progress, started/completed timestamps). Same plan can
//    have multiple runs if the first fails and gets retried — each
//    run is fresh.
//
// 2. Top-level phases capture orchestrator-level state; per-host
//    sub-states capture where we are inside the per-host loop. A run
//    in phase `executing` always has a `currentHostIndex` pointing
//    at the host currently mid-upgrade.
//
// 3. Pure state transitions. The state machine is a pure function
//    `(currentState, event) → nextState`. No I/O. The runner does
//    I/O by calling primitives; on success/failure it feeds the
//    result back through the FSM to compute the next state. This
//    keeps the FSM testable in isolation without mocking adapters.
//
// 4. Rollback ladder is per-substrate (per the v0.6 architecture
//    decisions doc). The FSM transitions to `rolling_back`; the
//    runner picks the per-substrate rollback strategy from the
//    primitives' capability discovery and executes it. The FSM
//    doesn't know which strategy is used — only that one is in
//    progress.
// ============================================================

// ── Top-level upgrade phases ───────────────────────────────

/**
 * Where an UpgradeRun is overall. Single value; one of these at any
 * time. Sub-states (per-host progress) live inside `hosts[]`.
 */
export type UpgradePhase =
  /** Plan created; awaiting approval before execution can start. */
  | "pending"
  /** Approval received; ready for preflight. Brief intermediate state. */
  | "approved"
  /** Preflight checks running (capacity, version compat, alerts gate). */
  | "preflight"
  /** Walking through per-host loop. `currentHostIndex` points at the active host. */
  | "executing"
  /** Failure detected; rolling back. Runner picks per-substrate strategy. */
  | "rolling_back"
  /** All hosts upgraded successfully. Terminal. */
  | "completed"
  /** Unrecoverable failure. Terminal. */
  | "failed"
  /** Operator cancelled. Terminal. */
  | "aborted";

// ── Per-host substates (during 'executing' phase) ──────────

/**
 * Inside the per-host loop, where a single host is in its upgrade
 * journey. Walks: pending → entering_maintenance → evacuating →
 * remediating → awaiting_reboot → exiting_maintenance → smoke_testing
 * → completed. Or fails out to `failed` at any point.
 */
export type HostUpgradeState =
  | "pending"
  | "entering_maintenance"
  | "evacuating"
  | "remediating"
  | "awaiting_reboot"
  | "exiting_maintenance"
  | "smoke_testing"
  | "completed"
  | "failed";

// ── UpgradePlan: declarative input ─────────────────────────

/**
 * What we want to do. Created when an operator (or RHODES itself,
 * triggered by a ticket) decides a cluster needs an upgrade.
 */
export interface UpgradePlan {
  /** Stable globally-unique id. */
  id: string;
  /** Graph Resource.id of the cluster being upgraded. */
  clusterResourceId: string;
  /** Target version, substrate-specific (vSphere 8.0u3, EKS 1.31, etc). */
  targetVersion: string;
  /** Source version at plan-creation time (recorded for postmortem). */
  sourceVersion: string;
  /**
   * Graph Resource.ids of the hosts to upgrade, in the order they'll
   * be processed. The orchestrator walks this list strictly in order
   * — no parallelism within a single cluster upgrade (matches vSphere
   * LCM and EKS managed-node-group serial defaults).
   */
  hostResourceIds: string[];
  /**
   * Substrate-agnostic evacuation mode. Adapter must support it (per
   * its capability discovery) or preflight will fail.
   */
  evacuationMode: "live_migrate" | "evict" | "replace";
  /** ISO-8601 timestamp of plan creation. */
  createdAt: string;
  /** Who/what created the plan (operator email, RHODES ticket id, etc). */
  createdBy: string;
  /** ISO-8601 timestamp of approval (set when phase moves past `pending`). */
  approvedAt?: string;
  /** Who approved (operator email). */
  approvedBy?: string;
}

// ── UpgradeRun: execution state ────────────────────────────

/**
 * The execution of a Plan. A Plan can have multiple Runs (the first
 * might fail at preflight, get fixed, then a second run starts).
 * Each Run is immutable in identity — its phase and host progress
 * advance through transitions but it never restarts from scratch.
 */
export interface UpgradeRun {
  /** Stable globally-unique id. */
  id: string;
  /** The plan this run is executing. */
  planId: string;
  /** Where the run is overall. */
  phase: UpgradePhase;
  /**
   * Index into the plan's `hostResourceIds`. -1 means the per-host
   * loop hasn't started yet (e.g., in `pending` / `approved` /
   * `preflight`). Equal to `hosts.length` means all hosts processed.
   */
  currentHostIndex: number;
  /** Per-host progress, parallel array to plan.hostResourceIds. */
  hosts: HostUpgradeProgress[];
  /** ISO-8601 — when this run started (phase moved past pending). */
  startedAt?: string;
  /** ISO-8601 — when this run reached a terminal phase. */
  completedAt?: string;
  /** Human-readable reason for terminal phases (failed/aborted). */
  errorMessage?: string;
}

export interface HostUpgradeProgress {
  hostResourceId: string;
  state: HostUpgradeState;
  startedAt?: string;
  completedAt?: string;
  /** Human-readable reason when state === 'failed'. */
  errorMessage?: string;
}

// ── Events that drive transitions ──────────────────────────

/**
 * Closed set of events the FSM accepts. Adding a new event requires
 * a deliberate FSM-table extension — don't extend ad-hoc.
 *
 * Events fall into two groups:
 *
 *   Operator-driven: `approve`, `abort`. Trigger phase transitions.
 *   Runner-driven: `preflight_*`, `host_step_succeeded`,
 *     `host_step_failed`, `rollback_*`. Reflect the outcome of a
 *     primitive call the runner just made.
 */
export type UpgradeEvent =
  /** Operator approved the plan. pending → approved. */
  | { kind: "approve"; actor: string; at: string }
  /** Operator aborted. Any non-terminal phase → aborted. */
  | { kind: "abort"; actor: string; reason: string; at: string }
  /** Preflight checks all passed. preflight → executing. */
  | { kind: "preflight_succeeded"; at: string }
  /** Preflight failed. preflight → failed. */
  | { kind: "preflight_failed"; reason: string; at: string }
  /**
   * Most recent per-host primitive call succeeded; advance to next
   * sub-state for the current host (or to next host).
   */
  | { kind: "host_step_succeeded"; at: string }
  /** Per-host primitive call failed; mark host failed, enter rolling_back. */
  | { kind: "host_step_failed"; reason: string; at: string }
  /** Rollback completed cleanly. rolling_back → failed. */
  | { kind: "rollback_succeeded"; at: string }
  /** Rollback itself failed. rolling_back → failed (with double-failure note). */
  | { kind: "rollback_failed"; reason: string; at: string };

// ── State-machine result ───────────────────────────────────

/**
 * The pure FSM returns a description of what changed, so the runner
 * can decide what primitive (if any) to call next and persist the
 * new run state.
 */
export interface TransitionResult {
  /** The new run state (full snapshot — runner persists it). */
  nextRun: UpgradeRun;
  /**
   * What the runner should DO next, based on the new state:
   * - `none`: no action needed (run is in a terminal phase, or
   *   waiting for an external event like approval/abort)
   * - `run_preflight`: kick off preflight checks
   * - `start_host_step`: call the primitive for the current host's
   *   current sub-state (the runner reads `currentHostIndex` +
   *   `hosts[currentHostIndex].state` to know what primitive)
   * - `start_rollback`: pick the per-substrate rollback strategy
   *   from capability discovery and start it
   */
  nextAction:
    | "none"
    | "run_preflight"
    | "start_host_step"
    | "start_rollback";
}

/**
 * Per-host sub-state progression. Used by the FSM to know which
 * sub-state comes next after a successful step on the current host.
 */
export const HOST_STATE_PROGRESSION: HostUpgradeState[] = [
  "pending",
  "entering_maintenance",
  "evacuating",
  "remediating",
  "awaiting_reboot",
  "exiting_maintenance",
  "smoke_testing",
  "completed",
];

/**
 * For a given current host sub-state, return the next one in the
 * progression (or null if `completed`/`failed`).
 */
export function nextHostState(
  current: HostUpgradeState,
): HostUpgradeState | null {
  const idx = HOST_STATE_PROGRESSION.indexOf(current);
  if (idx < 0 || idx >= HOST_STATE_PROGRESSION.length - 1) return null;
  return HOST_STATE_PROGRESSION[idx + 1];
}

/** Terminal phases — run is done, no further transitions possible. */
export const TERMINAL_PHASES: ReadonlySet<UpgradePhase> = new Set([
  "completed",
  "failed",
  "aborted",
]);
