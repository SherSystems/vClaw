# Orchestrator — v0.7 cluster upgrade

The orchestrator composes RHODES' substrate-agnostic primitives (`evacuate_workload`, `enter_maintenance`, `remediate_host`, `rollback` — see `src/primitives/`) into coordinated multi-host workflows. The headline use case is **autonomous vSphere cluster upgrades**, but the same orchestrator handles EKS node-pool rolling upgrades, AKS scale-set upgrades, and Proxmox cluster maintenance with no code changes — each substrate's primitives plug in.

This module ships in pieces:

| Piece | Status |
|---|---|
| **State machine + persistence** | ✅ this commit (v0.7-alpha) |
| Runner (walks the FSM by calling primitives) | ❌ next commit |
| Rollback ladder (per-substrate strategy selection) | ❌ next commit |
| Slack progress hooks (thread replies per host step) | ❌ next commit |
| Preflight engine (capacity / version compat / alerts gate) | ❌ v0.6.5 piece (separate) |
| Live integration on the nested lab | ❌ deployment session |

This commit gives downstream work a **stable contract** (UpgradePlan, UpgradeRun, transition) without making any of the harder decisions yet.

## The state machine

`transition(currentRun, event) → TransitionResult` is the single pure entry point. No I/O. The runner does I/O (calls primitives), feeds the result back through `transition()`, and persists the new run.

### Top-level phases

```
                ┌────────────┐
                │  pending   │  (plan created, awaiting approval)
                └─────┬──────┘
                      │ approve
                      ▼
                ┌────────────┐
                │  approved  │  (intermediate, runner kicks preflight)
                └─────┬──────┘
                      │ run_preflight (action)
                      ▼
                ┌────────────┐
                │ preflight  │
                └──┬──────┬──┘
       preflight_  │      │ preflight_
       succeeded   │      │ failed
                   ▼      ▼
            ┌──────────┐  ┌──────────┐
            │executing │  │  failed  │ ← terminal
            └─┬──────┬─┘  └──────────┘
              │      │
   host_step_ │      │ host_step_
   succeeded  │      │ failed
   (advance)  │      ▼
              │ ┌──────────────┐
              │ │ rolling_back │
              │ └──┬─────────┬─┘
              │    │         │
              │ rb_succ.   rb_failed
              │    │         │
              ▼    ▼         ▼
       ┌──────────┐ ┌──────────┐
       │completed │ │  failed  │ ← terminal
       └──────────┘ └──────────┘

(abort accepted from any non-terminal → aborted ← terminal)
```

### Per-host substates (during `executing`)

For each host in `plan.hostResourceIds`, the runner walks:

```
pending → entering_maintenance → evacuating → remediating
       → awaiting_reboot → exiting_maintenance → smoke_testing → completed
```

A failure at any sub-state transitions the run to `rolling_back` and marks the current host `failed`.

### Events

Closed set in `types.ts`:

| Event | Source | Effect |
|---|---|---|
| `approve` | operator | `pending → approved` |
| `abort` | operator | any non-terminal → `aborted` |
| `preflight_succeeded` | runner | `preflight → executing`, begin host 0 |
| `preflight_failed` | runner | `preflight → failed` |
| `host_step_succeeded` | runner | advance sub-state or move to next host |
| `host_step_failed` | runner | mark host failed, enter `rolling_back` |
| `rollback_succeeded` | runner | `rolling_back → failed` (clean rollback) |
| `rollback_failed` | runner | `rolling_back → failed` (double-failure) |

## Plan vs Run

| | Purpose | Mutability |
|---|---|---|
| `UpgradePlan` | Declarative input — which cluster, which version, which hosts, evacuation mode | Immutable once created (except for approval bits) |
| `UpgradeRun` | Execution state — phase, current host index, per-host progress, timestamps | Mutated on every FSM transition |

One Plan can have multiple Runs. The first run fails at preflight; operator fixes the cluster; a second run is created from the same Plan. Each Run is fresh.

## How the runner will use this (next commit)

```ts
import { OrchestratorStore, transition } from "../orchestrator/index.js";
import { getPrimitives } from "../primitives/index.js";

const store = new OrchestratorStore();
const plan = store.createPlan({...});
const run = store.createRun(plan.id);

// Operator approves
let result = transition(run, { kind: "approve", actor: "pranav@shersystems.com", at: now() });
store.persistRun(result.nextRun);

while (result.nextAction !== "none") {
  if (result.nextAction === "run_preflight") {
    const ok = await runPreflight(plan); // runner's I/O
    const evt = ok ? { kind: "preflight_succeeded", at: now() } : { kind: "preflight_failed", reason: ok.reason, at: now() };
    result = transition(result.nextRun, evt);
    store.persistRun(result.nextRun);
  }
  if (result.nextAction === "start_host_step") {
    const host = result.nextRun.hosts[result.nextRun.currentHostIndex];
    const provider = providerFor(host.hostResourceId);
    const prims = getPrimitives(provider);
    try {
      // Call the right primitive for the current sub-state
      await callPrimitiveFor(host.state, prims, host.hostResourceId, plan);
      result = transition(result.nextRun, { kind: "host_step_succeeded", at: now() });
    } catch (err) {
      result = transition(result.nextRun, { kind: "host_step_failed", reason: String(err), at: now() });
    }
    store.persistRun(result.nextRun);
  }
  // ... etc for start_rollback
}
```

## Crash recovery

On boot, the runner can call `store.listActiveRuns()` to find runs whose phase isn't terminal and resume them. Because the FSM is pure + persisted on every transition, resuming is just re-reading the run + computing the appropriate next action from `currentHostIndex` + `hosts[currentHostIndex].state`. Mid-primitive crashes that left the substrate in an inconsistent state need the per-primitive idempotency guarantees we baked into the primitives contract (`evacuate_workload` is safe to re-run, etc.).

## Storage location

`getDataDir()/orchestrator.db` (default: `~/.rhodes/data/orchestrator.db`). Two tables, three indexes. Plans cascade-delete their runs.
