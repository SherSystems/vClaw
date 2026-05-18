// ============================================================
// RHODES — Orchestrator Runner
//
// Walks the FSM by calling primitives, catching errors, and feeding
// results back through `transition()`. Persists after every step.
//
// This is the I/O layer. The FSM in state-machine.ts is pure. The
// split lets the FSM be tested without mocks (already done in
// state-machine.test.ts) and lets the runner be tested with fake
// primitives that simulate substrate behavior (done here).
//
// Design notes:
//
// 1. Provider routing: the runner determines which substrate's
//    primitives to call by parsing the host's Resource.id (format
//    `{provider}:{type}:{provider_uid}`). No graph lookup needed —
//    the id IS the provider routing key.
//
// 2. Sub-state → primitive mapping: a lookup table maps each
//    HostUpgradeState to the primitive call the runner makes. States
//    that aren't real primitive calls in the v0.6 contract
//    (`awaiting_reboot`, `smoke_testing`) are handled by built-in
//    helpers — the runner sleeps + polls until the host is back, then
//    runs a tiny smoke test. The helpers can be overridden via
//    constructor opts so tests can inject deterministic versions.
//
// 3. Preflight is a STUB for v0.7-alpha. Returns preflight_succeeded.
//    The real preflight engine lands in a separate commit; the runner
//    will accept a callable when that lands.
//
// 4. Rollback is also a STUB. Returns rollback_succeeded. Real
//    rollback ladder + per-substrate strategy selection from
//    capability discovery lands separately.
//
// 5. drive() is the loop entry point. Reads the current run, infers
//    the next action from its phase, executes it, feeds the event
//    back through transition(), persists, and repeats until the run
//    is in a terminal phase or the next action is `none` (waiting on
//    operator approval).
// ============================================================

import {
  CapabilityUnsupported,
  PrimitiveNotImplemented,
  ProviderNotRegistered,
  getPrimitives,
  type Primitives,
} from "../primitives/index.js";
import type { GraphProvider } from "../graph/types.js";
import type { OrchestratorStore } from "./store.js";
import { transition } from "./state-machine.js";
import { TERMINAL_PHASES, type HostUpgradeState } from "./types.js";
import type {
  HostUpgradeProgress,
  TransitionResult,
  UpgradeEvent,
  UpgradePlan,
  UpgradeRun,
} from "./types.js";

// ── Pluggable I/O the runner needs ─────────────────────────

export interface RunnerHooks {
  /**
   * Test seam for the global primitives registry. Defaults to
   * `getPrimitives(provider)`. Tests inject a fake registry so they
   * don't have to mutate the global one.
   */
  primitivesFor?: (provider: GraphProvider) => Primitives;
  /**
   * Real preflight runs a battery of checks (capacity, version
   * compat, alerts gate). For v0.7-alpha this is a stub that
   * returns success. Tests can override.
   */
  runPreflight?: (
    plan: UpgradePlan,
    run: UpgradeRun,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Real rollback picks the per-substrate strategy from the
   * primitives' capability discovery. Stubbed for v0.7-alpha.
   */
  runRollback?: (
    plan: UpgradePlan,
    run: UpgradeRun,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Wait for a host to become reachable again after a reboot.
   * Default: a fixed 5s delay. Production wires up a real
   * connectivity poll. Tests override with 0ms.
   */
  awaitReboot?: (hostResourceId: string) => Promise<void>;
  /**
   * Smoke test after a host returns from maintenance. Default:
   * always passes. Production verifies one workload round-trips.
   */
  smokeTest?: (
    hostResourceId: string,
    plan: UpgradePlan,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** ISO-8601 clock override for deterministic tests. */
  clock?: () => string;
}

// ── Runner ─────────────────────────────────────────────────

export class UpgradeRunner {
  private readonly primitivesFor: (provider: GraphProvider) => Primitives;
  private readonly runPreflight: NonNullable<RunnerHooks["runPreflight"]>;
  private readonly runRollback: NonNullable<RunnerHooks["runRollback"]>;
  private readonly awaitReboot: NonNullable<RunnerHooks["awaitReboot"]>;
  private readonly smokeTest: NonNullable<RunnerHooks["smokeTest"]>;
  private readonly clock: () => string;

  constructor(
    private readonly store: OrchestratorStore,
    hooks: RunnerHooks = {},
  ) {
    this.primitivesFor = hooks.primitivesFor ?? getPrimitives;
    this.runPreflight =
      hooks.runPreflight ?? (async () => ({ ok: true }) as const);
    this.runRollback =
      hooks.runRollback ?? (async () => ({ ok: true }) as const);
    this.awaitReboot =
      hooks.awaitReboot ?? ((_: string) => sleep(5000));
    this.smokeTest =
      hooks.smokeTest ?? (async () => ({ ok: true }) as const);
    this.clock = hooks.clock ?? (() => new Date().toISOString());
  }

  /**
   * Drive a run from its current state until it reaches a terminal
   * phase or a phase that requires external input (e.g., `pending`
   * waiting on approve). Returns the final run snapshot.
   *
   * Safe to call repeatedly — idempotent on terminal phases (the FSM
   * rejects further events).
   */
  async drive(runId: string): Promise<UpgradeRun> {
    const initialRun = this.store.getRun(runId);
    if (!initialRun) throw new Error(`UpgradeRunner.drive: run ${runId} not found`);
    const plan = this.store.getPlan(initialRun.planId);
    if (!plan) throw new Error(`UpgradeRunner.drive: plan ${initialRun.planId} not found`);

    let run = initialRun;
    while (!TERMINAL_PHASES.has(run.phase)) {
      const action = inferAction(run);
      if (action === "none") {
        return run; // Waiting for external input (typically `approve`).
      }
      const event = await this.executeAction(plan, run, action);
      const result = transition(run, event);
      this.store.persistRun(result.nextRun);
      run = result.nextRun;
      if (result.nextAction === "none") return run;
    }
    return run;
  }

  /**
   * Execute a single action and return the UpgradeEvent it produced.
   * Exposed for tests + callers that want fine-grained control
   * instead of the full drive() loop.
   */
  async executeAction(
    plan: UpgradePlan,
    run: UpgradeRun,
    action: TransitionResult["nextAction"],
  ): Promise<UpgradeEvent> {
    const at = this.clock();
    switch (action) {
      case "run_preflight": {
        const res = await this.runPreflight(plan, run);
        return res.ok
          ? { kind: "preflight_succeeded", at }
          : { kind: "preflight_failed", reason: res.reason, at };
      }
      case "start_host_step":
        return this.executeHostStep(plan, run, at);
      case "start_rollback": {
        const res = await this.runRollback(plan, run);
        return res.ok
          ? { kind: "rollback_succeeded", at }
          : { kind: "rollback_failed", reason: res.reason, at };
      }
      case "none":
        // Defensive — drive() should have returned already.
        throw new Error(
          "UpgradeRunner.executeAction: nextAction is 'none' (caller should not have invoked)",
        );
    }
  }

  private async executeHostStep(
    plan: UpgradePlan,
    run: UpgradeRun,
    at: string,
  ): Promise<UpgradeEvent> {
    const idx = run.currentHostIndex;
    const host = run.hosts[idx];
    if (!host) {
      return {
        kind: "host_step_failed",
        reason: `currentHostIndex ${idx} out of range`,
        at,
      };
    }
    try {
      await this.dispatchHostState(plan, host);
      return { kind: "host_step_succeeded", at };
    } catch (err) {
      return {
        kind: "host_step_failed",
        reason: formatHostStepError(err, host.state),
        at,
      };
    }
  }

  private async dispatchHostState(
    plan: UpgradePlan,
    host: HostUpgradeProgress,
  ): Promise<void> {
    const provider = providerFromResourceId(host.hostResourceId);
    if (host.state === "awaiting_reboot") {
      await this.awaitReboot(host.hostResourceId);
      return;
    }
    if (host.state === "smoke_testing") {
      const res = await this.smokeTest(host.hostResourceId, plan);
      if (!res.ok) throw new Error(res.reason);
      return;
    }
    const prims = this.primitivesFor(provider);
    switch (host.state) {
      case "entering_maintenance":
        await prims.enterMaintenance({
          hostId: host.hostResourceId,
          provider,
          evacuate: false,
        });
        return;
      case "evacuating":
        await prims.evacuateWorkload({
          targetId: host.hostResourceId,
          provider,
          mode: plan.evacuationMode,
        });
        return;
      case "remediating":
        await prims.remediateHost({
          hostId: host.hostResourceId,
          provider,
          image: plan.targetVersion,
        });
        return;
      case "exiting_maintenance":
        await prims.exitMaintenance({
          hostId: host.hostResourceId,
          provider,
        });
        return;
      case "pending":
      case "completed":
      case "failed":
        throw new Error(
          `dispatchHostState: unexpected sub-state '${host.state}' for active execution`,
        );
    }
  }
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Infer the right next action from the current run state. Used on
 * drive() boot to figure out where to pick up an in-flight run.
 */
function inferAction(run: UpgradeRun): TransitionResult["nextAction"] {
  if (TERMINAL_PHASES.has(run.phase)) return "none";
  switch (run.phase) {
    case "pending":
      return "none"; // waiting on approve
    case "approved":
    case "preflight":
      return "run_preflight";
    case "executing":
      return "start_host_step";
    case "rolling_back":
      return "start_rollback";
    default:
      return "none";
  }
}

/**
 * Resource.id format is `{provider}:{type}:{provider_uid}`.
 * Just take the first colon-delimited segment.
 */
function providerFromResourceId(resourceId: string): GraphProvider {
  const idx = resourceId.indexOf(":");
  if (idx <= 0) {
    throw new Error(
      `providerFromResourceId: malformed Resource.id '${resourceId}'`,
    );
  }
  const provider = resourceId.slice(0, idx);
  // Narrow to the GraphProvider union — caller-side error if not valid.
  return provider as GraphProvider;
}

function formatHostStepError(err: unknown, state: HostUpgradeState): string {
  if (err instanceof PrimitiveNotImplemented) {
    return `${state}: ${err.message} (primitive stub — implement in v0.7+)`;
  }
  if (err instanceof CapabilityUnsupported) {
    return `${state}: capability not supported on this substrate — ${err.message}`;
  }
  if (err instanceof ProviderNotRegistered) {
    return `${state}: ${err.message}`;
  }
  if (err instanceof Error) return `${state}: ${err.message}`;
  return `${state}: ${String(err)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export for tests
export { inferAction, providerFromResourceId };
