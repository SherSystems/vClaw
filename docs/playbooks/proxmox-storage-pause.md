# Proxmox Storage-Exhaustion Pause Playbook

**Event class:** `STORAGE_EXHAUSTION_PAUSE`
**Module:** [`src/playbooks/proxmox-storage-pause.ts`](../../src/playbooks/proxmox-storage-pause.ts)
**Monitor:** [`src/providers/proxmox/thin-pool-monitor.ts`](../../src/providers/proxmox/thin-pool-monitor.ts)
**Status:** First-class recognized failure mode

---

## The class of failure

A Proxmox VM goes silent. SSH times out. The console is blank. `qm reboot`
hangs. Operators reach for the OS-corruption checklist — kernel panics,
filesystem repair, ISO rescue — and burn hours.

The actual root cause, on the overwhelming majority of small/home labs and
many production single-host clusters, is:

> The thin-provisioned `local-lvm` (or any `lvmthin`) pool filled up. QEMU
> detected the I/O failure and **suspended the guest** rather than risk
> corruption. The guest is fine. It's frozen.

Run `qm monitor <vmid>` then `info status` and you'll see:

```
VM status: paused (io-error)
```

That single line is the fingerprint. Prune some snapshots to free thin-pool
space, `qm resume`, and the VM comes back instantly — no reboot, no fsck,
no data loss.

This playbook makes that diagnostic chain a first-class flow in RHODES,
with hard safety rails preventing the obvious foot-gun: deleting an active
VM disk (`vm-*-disk-*`) instead of a snapshot.

---

## Diagnostic flow

```
   ┌─────────────────────────────────────────────────────────┐
   │ 1. VM state inspection                                  │
   │    qm list  →  qm config <vmid>  →  qm monitor: info    │
   │                                       status            │
   └────────────────────────┬────────────────────────────────┘
                            │
                ┌───────────┴───────────┐
                │ Monitor output?       │
                └───────────┬───────────┘
                            │
       ┌────────────────────┼─────────────────────────────┐
       │                    │                             │
       ▼                    ▼                             ▼
  paused (io-error)    paused (other)              running
       │                    │                             │
       ▼                    ▼                             ▼
  STORAGE_              flag for                    fall through
  EXHAUSTION_           human review               to OS-level
  PAUSE                                             diagnostic
       │
       ▼
   ┌──────────────────────────────────────────────────────┐
   │ 3. Storage inspection                                │
   │    pvesm status   (which storage is near 100%?)      │
   │    lvs            (find thin pool, check Data%)      │
   └──────────────────────────┬───────────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │ 4. Snapshot bloat detection                          │
   │    qm listsnapshot <vmid> + siblings on same pool    │
   │    cross-ref with lvs sizes                          │
   │    flag: crash-recovery snaps, >30d old, nested virt │
   └──────────────────────────┬───────────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │ 5. PLAN (operator approval gate)                     │
   │    HARD RULE: never propose vm-*-disk-* deletion     │
   │    Order: oldest → largest → crash-recovery          │
   │    Show projected freed bytes + cumulative           │
   └──────────────────────────┬───────────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │ 6. EXECUTE (Tier 3 — RISKY_WRITE)                    │
   │    qm delsnapshot <vmid> <snap>  (one at a time)     │
   │    re-check lvs Data% after each                     │
   │    stop once below 80%                               │
   └──────────────────────────┬───────────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │ 7. Resume + verify                                   │
   │    qm resume <vmid>                                  │
   │    sleep 5–10s → qm status (expect: running)         │
   │    optional SSH probe if host known                  │
   │    Fallback (Tier 4): qm reset — separate approval   │
   └──────────────────────────────────────────────────────┘
```

---

## Tier policy

The playbook overrides the default proxmox adapter classification for the
following commands when invoked as part of this playbook:

| Command           | Tier            | Index | Auto-execute?                          |
| ----------------- | --------------- | ----- | -------------------------------------- |
| `qm resume`       | `safe_write`    | 2     | Yes (after pruning succeeded)          |
| `qm delsnapshot`  | `risky_write`   | 3     | Operator approval at PLAN phase        |
| `qm reset`        | `destructive`   | 4     | Separate approval gate (fallback only) |
| `qm destroy`      | `never`         | 5     | **Always blocked**                     |

These are exported from
[`PLAYBOOK_ACTION_TIERS`](../../src/playbooks/proxmox-storage-pause.ts) and
exercised by the test suite.

### Hard rules

`validateRemediationCandidate()` is the bouncer. It refuses to let any of
the following slip into a remediation plan:

1. **No active disk deletion.** Anything matching `vm-\d+-disk-\d+` is
   blocked outright. This is the rule that prevents an LLM from confusing
   an `lvs` row for a snapshot row and proposing `lvremove pve/vm-201-disk-0`.
2. **No `qm destroy`.** Tier 5, permanently blocked.
3. **No `lvremove` on non-snapshot LVs.**
4. **No `rm -rf`.**

If a candidate violates a hard rule, it moves to `plan.blocked_candidates`
and the operator sees the reason in the dashboard timeline.

---

## Proactive monitor

The reactive playbook is paired with
[`ThinPoolMonitor`](../../src/providers/proxmox/thin-pool-monitor.ts) which
polls `pvesm status` + `lvs` on every Proxmox node and emits:

- `ThinPoolWarning` event when any storage or thin-pool data% crosses
  `RHODES_PROXMOX_THIN_POOL_WARN_PCT` (default `85`).
- `StaleSnapshotDetected` event for snapshots older than
  `RHODES_PROXMOX_STALE_SNAPSHOT_DAYS` (default `30`).

### Config env vars

| Env var                                       | Default | Meaning                                          |
| --------------------------------------------- | ------- | ------------------------------------------------ |
| `RHODES_PROXMOX_THIN_POOL_POLL_SECS`          | `300`   | Polling interval (seconds)                       |
| `RHODES_PROXMOX_THIN_POOL_WARN_PCT`           | `85`    | Storage / Data% alert threshold                  |
| `RHODES_PROXMOX_STALE_SNAPSHOT_DAYS`          | `30`    | Snapshots older than this are flagged stale      |
| `RHODES_PROXMOX_THIN_POOL_ALERT_COOLDOWN_MIN` | `30`    | Suppress duplicate alerts within this window     |

---

## Example transcript

A real recovery as RHODES would narrate it:

```
[autopilot] anomaly: vm_status state_change, severity=critical
            labels={node: pve1, vmid: 201, reason: paused_io_error}
[playbook]  matched: proxmox_storage_exhaustion_pause
[playbook]  requires_approval=true → escalating to operator

[playbook] phase=vm_state
[playbook] qm list pve1 → vmid 201 present, status=paused
[playbook] qm config 201 → disks=[local-lvm:vm-201-disk-0]
[playbook] phase=monitor_status
[playbook] qm monitor 201 → "VM status: paused (io-error)"
[playbook] classification = STORAGE_EXHAUSTION_PAUSE

[playbook] phase=storage_inspection
[playbook] pvesm status → local-lvm 98.0% (HOT)
[playbook] lvs           → data twi-aotz Data%=96.4% (HOT)
[playbook] VMs on local-lvm: [201, 100, 300]

[playbook] phase=snapshot_analysis
[playbook] qm listsnapshot 201:
              - autosnap_2026-01-15_03_00_00   (older than 30d, crash-recovery)
              - pre-reboot                      (crash-recovery snapshot)
[playbook] estimated freed bytes:
              autosnap_2026-01-15_03_00_00 → 80.0 GiB
              pre-reboot                    → 50.0 GiB

[playbook] phase=plan
[playbook] PLAN:
  1. qm delsnapshot 201 autosnap_2026-01-15_03_00_00   [risky_write]
                                                       frees ~80.0 GiB
  resume: qm resume 201                                [safe_write]
  fallback: qm reset 201                               [destructive, gated]
[playbook] blocked_candidates: []

[operator]  APPROVED

[playbook] phase=execute
[playbook] qm delsnapshot 201 autosnap_2026-01-15_03_00_00 → ok
[playbook] lvs recheck → data Data%=78.1% (< target 80%, stopping)

[playbook] phase=resume
[playbook] qm resume 201 → ok
[playbook] sleep 5s → qm status 201 → running

[playbook] phase=verify
[playbook] ssh probe 10.0.0.201 → reachable
[playbook] outcome: resumed=true, reset_required=false

[autopilot] incident resolved by playbook "Proxmox Storage-Exhaustion Pause"
            duration: 12.4s, steps: 1 delsnapshot + 1 resume
```

---

## Why this is its own event class

Treating `paused (io-error)` as just another flavor of "VM unreachable"
leads RHODES down the OS-corruption diagnostic path, which is wrong and
expensive. By promoting it to a recognized event class:

1. **Dispatcher routing is deterministic.** The autopilot doesn't have to
   guess.
2. **The remediation surface is narrow.** Operators see exactly two action
   tiers (Tier 3 prune, Tier 4 reset) instead of a freeform agent loop.
3. **Telemetry is comparable across incidents.** "How often does this
   class fire on pve1?" becomes a one-line query.
4. **Hard rules can be encoded once.** The "never delete `vm-*-disk-*`"
   guard isn't relying on the LLM's good behavior.

---

## Testing

```
npm test -- --runTestsByPath tests/playbooks/proxmox-storage-pause.test.ts
npm test -- --runTestsByPath tests/providers/thin-pool-monitor.test.ts
```

Both suites use mocked `qm` / `pvesm` / `lvs` output. No live Proxmox
calls are made in CI.
