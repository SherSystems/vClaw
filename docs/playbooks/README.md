# RHODES Playbook Catalog

A playbook is a named, recognized class of failure with a deterministic
diagnostic chain, a tier-classified remediation surface, and (where
appropriate) hard rules that override LLM judgment. Playbooks are how
RHODES turns "the VM is dead" into a five-step plan an operator can
approve in one click.

Two kinds of playbook live in this repo:

- **Healing-registry entries** (`src/healing/playbooks.ts`) — anomaly
  triggers that the autopilot watches for and auto-dispatches against.
  These are the ones the dashboard's *Playbooks* view enumerates.
- **Pure decision modules** (`src/playbooks/*.ts`) — parsers,
  classifiers, and planners with no side effects. They expose a
  `Run...Playbook(executor, options)` entrypoint that a registry entry
  or an operator-driven CLI invocation hands off to.

The catalog below covers both surfaces. Status reflects what is on
`main` (v0.4.3) today and what changes when v0.4.4 lands.

## Current state — 8 registered playbooks (v0.4.3)

Count taken from `src/healing/playbooks.ts` (`grep -c "^    id:"`). One
decision module — `src/playbooks/vm-diagnostic.ts` — exists but is not
yet wired into the registry; operators can invoke it programmatically.

| Id | Name | Trigger metric / type | Approval | Cooldown | Doc |
|---|---|---|---|---|---|
| `vm_unresponsive` | VM Unresponsive | `vm_status` / flatline | auto | 15 min | (registry only) |
| `node_memory_critical` | Node Memory Critical | `node_memory_pct` / threshold | auto | 30 min | (registry only) |
| `disk_space_critical` | Disk Space Critical | `disk_usage_pct` / threshold | required | 60 min | (registry only) |
| `node_cpu_overload` | Node CPU Overload | `node_cpu_pct` / threshold | auto | 30 min | (registry only) |
| `vm_crashed` | VM Crashed | `vm_status` / threshold | auto | 10 min | (registry only) |
| `proxmox_storage_exhaustion_pause` | Proxmox Storage-Exhaustion Pause | `vm_status` / state_change (`reason=paused_io_error`) | required | 10 min | [proxmox-storage-pause.md](./proxmox-storage-pause.md) |
| `jellyfin-service-probe` | Jellyfin Service Probe | `service_http_status` / state_change (`service_name=jellyfin`) | auto | 5 min | (registry only — uses `src/playbooks/service-http-probe.ts`) |
| `predictive_disk_full` | Predictive Disk Full | `disk_usage_pct` / trend | auto | 360 min | (registry only) |

### Action tiers in one table

The diagnostic-grade playbooks (storage-pause, vm-diagnostic) expose
their own `PLAYBOOK_ACTION_TIERS` map. The tier table below summarizes
what each playbook may issue at each tier — the same five tiers the SSH
adapter uses (`read` < `safe_write` < `risky_write` < `destructive` <
`never`).

| Playbook | read | safe_write | risky_write | destructive | never |
|---|---|---|---|---|---|
| Proxmox Storage-Exhaustion Pause | `qm list`, `qm config`, `qm monitor`, `pvesm status`, `lvs`, `qm listsnapshot` | `qm snapshot` (safety snap), `qm resume` | `qm delsnapshot` | `qm reset` (separate gate) | `qm destroy`, `vm-*-disk-*` deletion, `rm -rf`, `lvremove` on non-snap LVs |
| In-VM Diagnostic (decision module) | `df -h`, `free -h`, `uptime`, `systemctl --failed`, `systemctl status`, `journalctl`, `dmesg`, `ss -tlnp` | `apt-get clean` | `systemctl restart`, `systemctl disable`, `journalctl --vacuum-size` | (none auto) | BOOT_LOOP auto-act, KERNEL_ERROR auto-act, DISK_FULL on `/` |

## After v0.4.4 — 9 registered playbooks (in flight)

v0.4.4 wires `src/playbooks/vm-diagnostic.ts` into the healing
registry so the `service_http_status` → in-VM diagnostic chain becomes
automatic. After the wiring branch (`feature/healing-recovery-and-wiring`)
merges, the catalog grows to:

| Id | Name | Trigger | Approval | Cooldown | Doc |
|---|---|---|---|---|---|
| ... all 8 above ... | ... | ... | ... | ... | ... |
| `vm_in_guest_diagnostic` | In-VM Diagnostic & Remediation | `service_http_status` / state_change (no label filter) | required | 15 min | [vm-diagnostic.md](./vm-diagnostic.md) |

The new entry hands its `Goal` off to `src/playbooks/vm-diagnostic.ts`
with `event_class: "VM_APP_UNREACHABLE"`. Its design (gather → classify
→ plan → execute → verify) is documented in
[vm-diagnostic.md](./vm-diagnostic.md) regardless of registry state —
the decision module is on `main` today, only the autoroute is pending.

## Cross-playbook references

- **IO_ERROR handoff.** The vm-diagnostic classifier deliberately
  emits `IO_ERROR` as an *escalation*, not a remediation step. The
  intent is that the runner converts it into a
  `STORAGE_EXHAUSTION_PAUSE` event so the proxmox-storage-pause
  playbook owns the recovery. This avoids the in-VM playbook trying to
  fix a thin-pool problem from inside the VM where it has no leverage.
- **Container failures.** A
  [podman-netavark-firewall-deadlock.md](./podman-netavark-firewall-deadlock.md)
  doc captures the 2026-05-12 jellyfin incident class. The decision
  module + registry entry are TODO — when implemented, this catalog
  grows to 10.

## Adding a new playbook

1. Author the decision module under `src/playbooks/<name>.ts`. Follow
   the storage-pause / vm-diagnostic shape: pure parsers, a classifier
   returning a typed union, a plan builder with action tiers, and an
   `Executor` interface for I/O. Hard rules live in
   `validateRemediationCandidate()`.
2. Add tests under `tests/playbooks/<name>.test.ts` with mocked
   executor.
3. Register the autoroute in `src/healing/playbooks.ts` with a trigger,
   cooldown, `requires_approval` policy, and a `custom_goal` action
   pointing at the decision module path.
4. Write `docs/playbooks/<name>.md` mirroring the structure of
   [proxmox-storage-pause.md](./proxmox-storage-pause.md): event
   class, failure-class explanation, diagnostic flow, tier policy,
   hard rules, example transcript, testing notes.
5. Add a row to the table at the top of this file.
