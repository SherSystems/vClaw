# Snapshot Retention & Safety-Snap Policy

**Module:** [`src/playbooks/proxmox-storage-pause.ts`](../../src/playbooks/proxmox-storage-pause.ts)
**Shipped in:** v0.4.3 (`feature/snapshot-retention`)
**Status:** First-class rule, on by default in the storage-pause remediation path.

---

## Rationale

The storage-exhaustion-pause playbook ranks snapshots by deletion
priority and prunes oldest-first to free thin-pool space. That ranking
is correct as far as it goes. But ranking-by-age is not the same as
*deletion safety*. Two operational realities forced this policy into
existence:

1. A VM whose only retained snapshot is `current` has nothing to roll
   back to if remediation goes sideways. "Free more space, lose the
   safety net" is the kind of trade RHODES must never make
   unilaterally.
2. Operators expect that taking a destructive action against a guest
   VM (deleting snapshots that LVM treats as real extents) leaves
   behind a rollback path. They do this manually with
   `qm snapshot <vmid> pre-something-2026-05-12` before any risky
   storage work. RHODES should do the same — automatically.

This policy codifies both expectations as runtime behavior, not
operator discipline.

## The three rules

### 1. Retention floor — never prune the newest non-`current` snapshot

`filterDeletableCandidates()` excludes the snapshot with the most
recent `created_at` timestamp from the deletable set. If only one
snapshot is in scope, the candidate list comes out empty and the plan
gracefully degrades to "no deletable candidates — escalate to
operator." Entries that have no `created_at` (older naming schemes,
missing parser metadata) are treated as *oldest* for safety so the
floor never accidentally keeps an undated entry while pruning a dated
one.

The constant is:

```ts
export const SNAPSHOT_RETENTION_FLOOR = 1;
```

Opt-in via `rankSnapshotsForDeletion({ apply_retention_floor: true })`.
The remediation playbook always sets this flag. The thin-pool monitor —
which only *observes* snapshots and emits warnings — leaves it off so
it continues to see every candidate (including the would-be retained
one) when reporting stale snapshots to the operator.

### 2. Safety-snap rule — take one before any delete

`buildRemediationPlan()` prepends a step of kind
`take_safety_snapshot` whenever the plan contains any delete step:

```ts
qm snapshot <vmid> rhodes-safety-<ISO-timestamp>
```

This step is classified `safe_write` (Tier 2). It runs *before* any
destructive delete. If the safety snap fails to take, the runner
aborts the entire remediation without issuing a single delete — no
safety net, no destructive action.

The snap name is namespaced with the `rhodes-safety-` prefix, so
`validateRemediationCandidate()` knows it from operator-named
snapshots and applies the cleanup rule (next section) to it.

### 3. Prior safety-snap cleanup — only after a successful resume + verify

Before the new safety snap is taken, the planner looks for an existing
`rhodes-safety-*` snapshot (from a previous remediation run) via
`findPreviousSafetySnapshot()`. If one exists, a step of kind
`cleanup_prior_safety_snapshot` is appended to the plan — but it does
NOT execute inline with the rest of the steps.

The runner collects deferred-cleanup steps up front, then runs them
ONLY after:

1. `qm resume <vmid>` succeeded, AND
2. `qm status` returned `running` within the 5-second verify window.

If resume fails — for any reason — the prior safety snap is preserved
as a rollback target. The notes log explicitly records the preservation:

```
Resume did not succeed; preserving previous safety snapshot(s)
for rollback: rhodes-safety-2026-05-12T18:09:21.044Z
```

This is the rule that prevents the playbook from orphaning its own
rollback path mid-incident.

## How it surfaces in a plan

In a dashboard plan-card view, the safety-snap step renders distinctly
from the delete steps:

```
PLAN — Proxmox Storage-Exhaustion Pause (vmid 201)

  ■ shielded   qm snapshot 201 rhodes-safety-2026-05-13T03:14:09.183Z
               Take pre-remediation safety snapshot.            [safe_write]

  ▶ pruning    qm delsnapshot 201 autosnap_2026-01-15_03_00_00
               Delete snapshot — older than 30d, crash-recovery.[risky_write]
               Frees ~80.0 GiB.

  ▶ resume     qm resume 201                                    [safe_write]

  ✓ cleanup    qm delsnapshot 201 rhodes-safety-2026-05-12T18:09:21.044Z
               Prune previous safety snapshot after successful  [risky_write]
               resume. (runs only on green verify)
```

The "shielded" decoration is the contract: this step is what RHODES
brought to the table; without it, no delete happens.

## Action tiers

| Step kind | Command | Tier | Auto-execute? | Notes |
|---|---|---|---|---|
| `take_safety_snapshot` | `qm snapshot <vmid> rhodes-safety-<ISO>` | `safe_write` | Yes, after plan approval | Aborts run on failure |
| `delete_snapshot` | `qm delsnapshot <vmid> <name>` | `risky_write` | Operator approval at plan phase | Hard-rule guards: no `vm-*-disk-*`, no rhodes-safety-* outside cleanup path |
| `cleanup_prior_safety_snapshot` | `qm delsnapshot <vmid> rhodes-safety-<prior-ISO>` | `risky_write` | Only after green resume + verify | Hard rule: blocked unless `allow_safety_cleanup` matches the exact prior name |
| Resume / verify | `qm resume <vmid>`, `qm status <vmid>` | `safe_write` | Yes | The verify gate decides whether cleanup runs |

The `rhodes-safety-*` deletion guard lives in
`validateRemediationCandidate()` and is exercised by the test suite.
Any LLM-generated remediation candidate that references a
`rhodes-safety-*` name as a delete target without the exact-name
`allow_safety_cleanup` permission is refused outright — even a
correctly-formed plan can't accidentally orphan the safety net.

## Source

- Constants: `SNAPSHOT_RETENTION_FLOOR`,
  `RHODES_SAFETY_SNAPSHOT_PREFIX`, `PLAYBOOK_ACTION_TIERS` in
  [`src/playbooks/proxmox-storage-pause.ts`](../../src/playbooks/proxmox-storage-pause.ts)
- Functions: `filterDeletableCandidates`, `findPreviousSafetySnapshot`,
  `validateRemediationCandidate`, `buildRemediationPlan`,
  `runProxmoxStoragePausePlaybook` in the same file
- Executor contract: `ProxmoxExecutor.qmTakeSnapshot()` is new in
  v0.4.3 — adapters now expose snapshot creation as a first-class
  capability alongside the existing `qmDelSnapshot` and `qmResume`.

## Before this rule existed — Jellyfin save on 2026-05-12

The retention-floor and safety-snap rules were not academic
hardening. They came directly out of the 2026-05-12 Jellyfin
incident. A thin-pool exhaustion on the media VM produced two
candidate snapshots, both old, one of them carrying the only good
state from before a Jellyfin library re-index. RHODES proposed
pruning both. The operator approved the older one, manually held back
the second, and only after the VM resumed cleanly did the second
delete happen — by hand. That manual hold-back is exactly the policy
that now ships: retention floor keeps the newest non-current
snapshot, a safety snap is taken before any delete, and the prior
safety snap survives until a successful resume + verify. The next
time this incident class fires, the operator clicks Approve once and
the rest is mechanical.
