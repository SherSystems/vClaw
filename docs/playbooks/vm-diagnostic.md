# In-VM Diagnostic + Remediation Playbook

**Event class:** `VM_APP_UNREACHABLE`
**Module:** [`src/playbooks/vm-diagnostic.ts`](../../src/playbooks/vm-diagnostic.ts)
**Tests:** [`tests/playbooks/vm-diagnostic.test.ts`](../../tests/playbooks/vm-diagnostic.test.ts)
**Status:** Decision module shipped in v0.4.3. Healing-registry wiring
(`service_http_status` → vm-diagnostic auto-fire) in flight on
`feature/healing-recovery-and-wiring`, queued for v0.4.4.

---

## The class of failure

An app-level probe trips. The VM itself is fine — Proxmox reports it
running, the host pings, SSH works, the kernel is happy. But the
service the operator actually cares about (Jellyfin, Sonarr, an API
gateway, a database) is not answering.

A human SRE in this situation runs the same dozen commands every
time: `df -h`, `free -h`, `uptime`, `systemctl --failed`,
`journalctl -u <svc> --since=10min`, `dmesg`, `ss -tlnp`,
`systemctl status <svc>`. Then they read the outputs together and form
a hypothesis: out of disk; out of RAM; OOM killer fired; service
crashed and won't restart; service active but not listening; kernel
threw an error.

This playbook codifies that loop. It does NOT replace the human's
final judgment — every remediation step is tier-classified and the
plan gates on operator approval. What it removes is the typing.

---

## Diagnostic sequence — nine commands in parallel

The `GATHER` phase fans out all nine commands at once via the
injected `VmDiagnosticExecutor.exec()`. Results are reduced to typed
structs by nine deterministic parsers so the classifier sees data, not
text:

| # | Command | Parser | Used for |
|---|---|---|---|
| 1 | `df -h` | `parseDfH` | DISK_FULL / DISK_PRESSURE on each mount |
| 2 | `free -h` | `parseFreeH` | MEMORY_PRESSURE / SWAP_PRESSURE |
| 3 | `uptime` | `parseUptime` | BOOT_LOOP (uptime < 5min + load average) |
| 4 | `systemctl --failed --no-pager` | `parseSystemctlFailed` | SERVICE_CRASHED corroboration |
| 5 | `journalctl --since=10min --no-pager -p err -n 50` (system-wide) | `parseJournalctl` | System-level error context |
| 6 | `journalctl -u <service> --since=10min --no-pager -p err -n 100` (per-unit) | `parseJournalctl` | Per-service failure history (BOOT_LOOP detection) |
| 7 | `dmesg -T --level=err,crit,alert,emerg \| tail -50` | `parseDmesg` | IO_ERROR, MEMORY_OOM, KERNEL_ERROR |
| 8 | `ss -tlnp` | `parseSsListening` (against expected port) | SERVICE_NOT_LISTENING |
| 9 | `systemctl status <service> --no-pager -l` | `parseSystemctlStatus` | Active state, sub-state, last log tail |

All nine commands classify as `read` under the SSH safety classifier
and the playbook's own `PLAYBOOK_ACTION_TIERS` table.

## Classification — ten failure modes, priority-ordered

`classifyFailureModes()` reduces the parsed bundle into a deduplicated,
priority-ordered list of failure modes. Priority is defined by
`FAILURE_MODE_PRIORITY` in source.

| Priority | Mode | Auto-remediation | Operator escalation |
|---|---|---|---|
| 1 | `IO_ERROR` | None — hand off to `proxmox-storage-pause` | Required — emit `STORAGE_EXHAUSTION_PAUSE` |
| 2 | `DISK_FULL` | Only on `/var` or `/var/*`: `journalctl --vacuum-size=500M` + `apt-get clean` | Required on `/` or unknown mounts |
| 3 | `MEMORY_OOM` | `systemctl restart <service>` | Always — repeated OOMs are a capacity signal |
| 4 | `BOOT_LOOP` | `systemctl disable <service>` (stop the loop, do NOT restart) | Required — operator must investigate before re-enable |
| 5 | `SERVICE_CRASHED` | `systemctl restart <service>` | None |
| 6 | `SERVICE_NOT_LISTENING` | `systemctl restart <service>` | None |
| 7 | `KERNEL_ERROR` | None | Required — Tier 5 manual triage |
| 8 | `DISK_PRESSURE` | `journalctl --vacuum-size=500M` (advisory) | None |
| 9 | `MEMORY_PRESSURE` | `systemctl restart <service>` | Capacity follow-up |
| 10 | `UNDETERMINED` | None | None — runner records inconclusive verdict |

A single anomaly typically produces 1–3 modes. The plan builder
deduplicates `systemctl restart` proposals so MEMORY_OOM +
SERVICE_CRASHED doesn't try to restart the service twice.

## Tier policy

| Command pattern | Tier | Auto-execute |
|---|---|---|
| `df`, `free`, `uptime`, `systemctl --failed`, `systemctl status`, `journalctl`, `dmesg`, `ss` | `read` | Yes (gather phase) |
| `apt-get clean` | `safe_write` | Yes |
| `journalctl --vacuum-size=...` | `risky_write` | Operator approval |
| `systemctl restart <service>` | `risky_write` | Operator approval |
| `systemctl disable <service>` (BOOT_LOOP only) | `risky_write` | Operator approval AND refuse-boot-loop override |

These come from `PLAYBOOK_ACTION_TIERS` in
`src/playbooks/vm-diagnostic.ts`. The SSH safety classifier produces
matching tiers for the same verbs — the playbook never *lowers* a
classifier verdict, it just names the verbs it intends to issue.

## Hard rules

The decision module encodes four rules that no operator approval can
override (operators can always bypass the playbook entirely by SSHing
in themselves — these rules describe what the playbook itself will
refuse to do):

1. **Never auto-act on `BOOT_LOOP`.** The default `refuse_boot_loop_auto`
   flag is `true`. Even with operator approval, the runner short-circuits
   before EXECUTE and surfaces the disable step as an escalation. The
   operator can pass `refuse_boot_loop_auto=false` to override; the
   dashboard does not expose that toggle.
2. **Never auto-act on `KERNEL_ERROR`.** Recent high-severity dmesg
   lines (OOM, NMI, I/O failure prefixes, ext-fs error, kernel panic)
   that don't already classify as IO_ERROR or MEMORY_OOM become an
   escalation. The playbook will not propose a restart for an unknown
   kernel-level fault.
3. **Never auto-clean `/`.** `DISK_FULL` on the root filesystem (or
   any mount the playbook can't confidently scope to `/var`) is
   surfaced as an escalation. The auto-vacuum/apt-clean path is gated
   on the full mount actually being `/var` or `/var/*`. Disk full on
   `/` typically means the operator must triage volumes, snapshot
   policy, or container image bloat — none of which this playbook
   understands.
4. **`IO_ERROR` is a handoff, not a fix.** When the dmesg classifier
   sees `i/o error`, `sd N:N:N:N: FAILED Result:`, or `jbd2` failures,
   it emits IO_ERROR as the highest-priority mode and produces NO
   remediation steps for it — the runner is expected to hand off to
   the proxmox-storage-pause playbook (which operates at the
   hypervisor layer where it has leverage).

## Example transcript — Jellyfin OOM in a Win11 VM

Synthetic but realistic. The host VM stays up; the Jellyfin systemd
unit OOM-killed itself after a transcoding burst.

```
[autopilot] anomaly: service_http_status state_change, severity=critical
            labels={vm: jellyfin-server, vmid: 101,
                    service_name: jellyfin, port: 8096}
[playbook]  matched: vm_in_guest_diagnostic (cooldown 15min)
[playbook]  requires_approval=true → preparing plan

[gather]    9 commands in parallel via ssh target jellyfin-server
[gather]    df: /=42%, /var=51%, /tmp=8%
[gather]    free: mem=98.2%, swap=84.3%
[gather]    uptime: up 7 days, 03:14, load 1m=0.42 5m=0.31 15m=0.28
[gather]    systemctl --failed: 1 unit — jellyfin.service
[gather]    journalctl -u jellyfin --since=10min:
              Apr 30 22:14:09 jellyfin-server systemd[1]: jellyfin.service:
                Main process exited, code=killed, status=9/KILL
              Apr 30 22:14:09 jellyfin-server systemd[1]: jellyfin.service:
                Failed with result 'signal'.
[gather]    dmesg (tail):
              [Thu Apr 30 22:14:08 2026] Out of memory: Killed process
                3478 (jellyfin) total-vm:7842300kB anon-rss:6914812kB
[gather]    ss -tlnp :8096 → no LISTEN
[gather]    systemctl status jellyfin → Active: failed (Result: signal)

[classify]  modes (priority-ordered):
              1. MEMORY_OOM      (dmesg: oom-killer)
              2. SERVICE_CRASHED (status: failed)
              3. MEMORY_PRESSURE (free: 98.2%, swap 84.3%)
              4. SERVICE_NOT_LISTENING (ss: no LISTEN on 8096)

[plan]      steps:
              1. sudo systemctl restart jellyfin   [risky_write]
                 reason: OOM kill detected — restart to recover.
            escalations:
              - MEMORY_OOM: repeated OOM kills indicate a capacity
                problem; capture for follow-up review.
              - MEMORY_PRESSURE: memory pressure suggests capacity tuning.

[operator]  APPROVED

[execute]   sudo systemctl restart jellyfin → ok
[wait]      sleep 3s
[verify]    probeApp() → 200 OK in 9ms
[done]      recovered=true after 1 step, app probe returned 200.
            escalations recorded for operator follow-up:
              - capacity review for jellyfin (4 OOMs in 30d)
```

## Cross-references

- Source: [`src/playbooks/vm-diagnostic.ts`](../../src/playbooks/vm-diagnostic.ts)
- Tests: [`tests/playbooks/vm-diagnostic.test.ts`](../../tests/playbooks/vm-diagnostic.test.ts)
- Companion service-probe playbook (entry point for many runs):
  [`src/playbooks/service-http-probe.ts`](../../src/playbooks/service-http-probe.ts)
- IO_ERROR handoff target:
  [proxmox-storage-pause.md](./proxmox-storage-pause.md)
- Catalog entry: [README.md](./README.md)
