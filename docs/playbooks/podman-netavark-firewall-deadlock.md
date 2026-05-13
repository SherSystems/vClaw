# Podman / Netavark Firewall Backend Deadlock Playbook

**Event class:** `CONTAINER_FIREWALL_BACKEND_DEADLOCK`
**Module:** [`src/playbooks/podman-netavark-firewall-deadlock.ts`](../../src/playbooks/podman-netavark-firewall-deadlock.ts) *(TODO)*
**Monitor:** [`src/providers/podman/container-health-monitor.ts`](../../src/providers/podman/container-health-monitor.ts) *(TODO)*
**Status:** Proposed — captured from real recovery on `jellyfin` VM (Proxmox vmid 101) on 2026-05-12.

---

## The class of failure

A long-running rootful Podman service (Jellyfin, Sonarr, Radarr, etc.)
appears slow or unresponsive. The container is `Up`. The host VM is idle.
The disk is fine. Resource graphs show nothing.

Then an operator does the "obvious" thing — `podman restart <name>` — and
the container refuses to come back:

```
Error: netavark: code: 1, msg: iptables: Chain already exists.
```

Every subsequent `podman start`, `podman run`, even a fresh `podman run`
with `--rm` on the same network, returns the same error. The service is
now hard-down, the operator has no quick rollback, and the panic clock
starts.

The actual root cause is a **firewall-backend split** between netavark and
the kernel's netfilter state. Two failure modes chain together:

1. **Wedge** — the service's process state machine stalls (event-loop
   block, deadlock, slow filesystem call, GC pause that exceeds the
   accept-queue drain rate). Symptom: high `Recv-Q` on the listen socket,
   very low `voluntary_ctxt_switches` for a server process, and connections
   piling up unaccepted.
2. **Restart deadlock** — when netavark tries to re-attach the container
   to its bridge, it calls `iptables -t filter -N NETAVARK_FORWARD`.
   If those chains already exist in the kernel as **native nftables**
   chains (created by a previous netavark with `nftables` driver, by Docker,
   or by manual `nft` rules), the iptables-legacy compat layer cannot see
   or replace them. The kernel reports "chain already exists" and netavark
   aborts.

The split typically arises after one of:

- Distro upgrade swapping `iptables-nft` for `iptables-legacy` (or vice versa).
- Switching `firewall_driver` in `containers.conf` between `iptables` and `nftables`.
- Coexistence with Docker on the same host (Docker writes via nftables on
  modern distros).
- A `containers.conf` change that didn't pair with `podman system reset` or
  a host reboot.

The fingerprint, after `podman start` fails:

```bash
iptables -t filter -L NETAVARK_FORWARD -n
# → chain `NETAVARK_FORWARD' in table `filter' is incompatible, use 'nft' tool.

nft list chain ip filter NETAVARK_FORWARD
# → returns rules. The chain exists in nft but is invisible to iptables.
```

That mismatch — chain visible via `nft`, invisible via `iptables`, but
its **name** is registered with the kernel — is the trap.

---

## Why the surgical fix is dangerous

The obvious move is `nft delete chain ip filter NETAVARK_FORWARD`. Do not
do this without a plan: that chain holds forwarding rules for **every
other container on the host** that shares the bridge family. On the
production trigger (jellyfin VM), that chain was carrying
~36M forwarded packets across 9 healthy containers. Deleting it instantly
strands their network, and netavark does not auto-reconcile rules for
already-running containers — they would need to be restarted to repopulate.

The playbook prefers (in order):

1. **Driver switch**, when netavark was built with nftables support →
   change `firewall_driver = "nftables"` in `/etc/containers/containers.conf.d/`
   and retry. Zero blast radius on other containers.
2. **Coordinated stack restart**, when (1) fails because netavark binary
   lacks nft support → stop every container on the affected network,
   delete the native-nft chains, restart the stack. Bounded downtime,
   no host reboot.
3. **VM reboot**, when (2) is too risky (mixed-criticality stack,
   unfamiliar dependencies) → guaranteed clean firewall state, paid for
   in 30–90s of full downtime. The bias toward reboot is correct on
   single-purpose VMs where every container is on the same network and
   has `restart: unless-stopped`.

---

## Diagnostic flow

```
   ┌─────────────────────────────────────────────────────────┐
   │ 1. Wedge detection                                      │
   │    ss -tlnp '( sport = :<port> )'                       │
   │    → Recv-Q > 0 with idle CPU = stuck accept loop       │
   │    cat /proc/<pid>/status: voluntary_ctxt_switches low  │
   │    cat /proc/<pid>/stack: kernel wait site              │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 2. Resource ruleout                                     │
   │    host load, host RAM, %iowait, %util on backing disk  │
   │    guest free RAM (NOT balloon "free_mem" — that lies   │
   │      about Linux page cache; use `free -h` inside VM)   │
   │    disk space on container volumes                      │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
                  ┌─────────┴─────────┐
                  │ All clean?        │
                  └─────────┬─────────┘
                            │ yes
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 3. Attempt restart                                      │
   │    podman restart <container>                           │
   └────────────────────────┬────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │ exit code 0?              │
              └─────────────┬─────────────┘
                            │ no — error contains
                            │ "iptables: Chain already exists"
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 4. Firewall-backend split classification                │
   │    podman --log-level=debug start <container>           │
   │      → grep "Add extra isolate rules" / chain names     │
   │    strace -f -e execve podman start <container>         │
   │      → capture exact failing `iptables -N <CHAIN>`      │
   │    iptables -t filter -L <CHAIN> -n                     │
   │      → "incompatible, use 'nft' tool" = positive ID     │
   │    nft list chain ip filter <CHAIN>                     │
   │      → confirms rules live in native nft                │
   └────────────────────────┬────────────────────────────────┘
                            │ classified as
                            ▼
                CONTAINER_FIREWALL_BACKEND_DEADLOCK
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 5. Recovery selection                                   │
   │                                                         │
   │ probe nftables support:                                 │
   │   NETAVARK_FW=nftables podman start <container>         │
   │   → "nftables support presently not available" means    │
   │     this netavark binary cannot use nft. Skip A.        │
   │                                                         │
   │ A. DRIVER-SWITCH (preferred if supported)               │
   │    write /etc/containers/containers.conf.d/firewall.conf│
   │    [network]                                            │
   │    firewall_driver = "nftables"                         │
   │    retry podman start                                   │
   │                                                         │
   │ B. COORDINATED-RESTART                                  │
   │    list every container on affected network             │
   │    stop them all                                        │
   │    nft flush chain ip filter NETAVARK_FORWARD           │
   │    nft delete chain ip filter NETAVARK_FORWARD          │
   │    repeat for NETAVARK_ISOLATION_1/2                    │
   │    start containers (compose up / podman start each)    │
   │                                                         │
   │ C. HOST-REBOOT                                          │
   │    confirm every container has restart=unless-stopped   │
   │    or always; otherwise flag.                           │
   │    reboot the VM (`reboot`, not `qm reset`).            │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 6. Verify                                               │
   │    podman ps --filter name=<container>                  │
   │    curl -sS -o /dev/null -w '%{http_code}:%{time_total}'│
   │      http://localhost:<port>/health                     │
   │    ss -tln '( sport = :<port> )'  → Recv-Q back to 0    │
   └─────────────────────────────────────────────────────────┘
```

---

## Tier policy

| Command                                          | Tier            | Index | Auto-execute?                              |
| ------------------------------------------------ | --------------- | ----- | ------------------------------------------ |
| `podman ps` / `podman inspect` / `podman logs`   | `read`          | 0     | Yes                                        |
| `ss`, `iptables -L`, `nft list`, `strace`        | `read`          | 0     | Yes                                        |
| `podman restart <name>`                          | `safe_write`    | 2     | Yes (first attempt only)                   |
| Writing `containers.conf.d/*.conf`               | `safe_write`    | 2     | Yes (under `/etc/containers/`)             |
| `podman rm <name>` + `podman run` recreate       | `risky_write`   | 3     | Operator approval                          |
| `nft delete chain` on a `NETAVARK_*` chain       | `risky_write`   | 3     | Operator approval; stack must be stopped   |
| Bulk stop of every container on a network        | `risky_write`   | 3     | Operator approval; lists members in plan   |
| `reboot` of the host VM                          | `destructive`   | 4     | Separate approval gate                     |
| `qm reset` (from outside the guest)              | `destructive`   | 4     | Fallback only; separate approval           |
| `iptables -X` on a referenced chain              | `never`         | 5     | **Always blocked**                         |
| `nft flush ruleset` / `nft delete table`         | `never`         | 5     | **Always blocked**                         |

### Hard rules

`validateRemediationCandidate()` rejects any of:

1. **No global firewall flush.** `nft flush ruleset`, `iptables -F`, or any
   variant. Strands every container, host networking, and the SSH session
   the agent is using.
2. **No `iptables -X` on a chain with non-zero references.** Detectable
   from `iptables -L | grep "Chain X (N references)"` where N > 0.
3. **No `nft delete chain` while any container on the network is
   running.** Plan must include the stop step first.
4. **No `podman system reset`.** Deletes all containers and volumes.
5. **No reboot proposed before resource ruleout has run.** Reboots
   without ruling out the obvious (out of disk, OOM-killed) mask root
   causes that will recur on next boot.

---

## Proactive monitor

`ContainerHealthMonitor` polls each known rootful container on the host
and emits:

- `ContainerWedgeWarning` when `Recv-Q` on the container's published port
  exceeds `RHODES_PODMAN_RECVQ_WARN` (default `5`) for two consecutive
  polls AND `voluntary_ctxt_switches` delta is below
  `RHODES_PODMAN_CTXSW_FLOOR` (default `100`) over the same interval.
- `FirewallBackendSplitDetected` when `iptables -t filter -L NETAVARK_FORWARD`
  fails with "incompatible, use 'nft' tool" while `nft list chain` succeeds.
  This is a **pre-incident** check — fires before any restart attempt.

### Config env vars

| Env var                                | Default | Meaning                                          |
| -------------------------------------- | ------- | ------------------------------------------------ |
| `RHODES_PODMAN_POLL_SECS`              | `60`    | Container health poll interval                   |
| `RHODES_PODMAN_RECVQ_WARN`             | `5`     | Recv-Q threshold for wedge warning               |
| `RHODES_PODMAN_CTXSW_FLOOR`            | `100`   | ctxt-switch delta below which "stuck" is asserted|
| `RHODES_PODMAN_FW_SPLIT_CHECK_HOURS`   | `6`     | How often to run the pre-incident split probe    |
| `RHODES_PODMAN_REBOOT_REQUIRES_APPROVE`| `true`  | Always require operator OK before host reboot    |

---

## Example transcript

A real recovery as RHODES would narrate it — distilled from the 2026-05-12
jellyfin incident:

```
[autopilot] anomaly: container_listener_backpressure, severity=warn
            labels={vm: jellyfin, vmid: 101, container: jellyfin, port: 8096}
[probe]     ss -tln :8096 → Recv-Q=25 Send-Q=4096
[probe]     /proc/3478/status → State=S voluntary_ctxt_switches=1833 (5d uptime)
[classify]  WEDGED_CONTAINER (low ctxsw + high recv-q + idle host)

[probe]     ruleout: host load=4.74 (host has 62 GiB free, no contention)
[probe]     ruleout: guest free=13 GiB, iowait=0.00, disk 85% (warn, not cause)
[playbook]  attempt restart (tier=safe_write, auto)
[exec]      podman restart jellyfin
[result]    netavark: "iptables: Chain already exists"
[classify]  upgrade → CONTAINER_FIREWALL_BACKEND_DEADLOCK

[probe]     podman --log-level=debug start jellyfin
            → fails at varktables NETAVARK_FORWARD create
[probe]     iptables -t filter -L NETAVARK_FORWARD
            → "incompatible, use 'nft' tool"
[probe]     nft list chain ip filter NETAVARK_FORWARD
            → 5 rules, ~36M packets forwarded
[verdict]   firewall-backend split: rules live in native nft,
            netavark binary uses iptables-legacy

[probe]     NETAVARK_FW=nftables podman start jellyfin
            → "nftables support presently not available"
            → DRIVER-SWITCH path (A) unavailable
[playbook]  candidates remaining: COORDINATED-RESTART, HOST-REBOOT
[playbook]  network media-stack_default has 9 running containers:
              qbittorrent, sonarr, radarr, flaresolverr, sabnzbd,
              jackett, homarr, readarr, jellyseerr
[playbook]  blast radius: COORDINATED-RESTART ≈ 30s downtime, 9 services
[playbook]  blast radius: HOST-REBOOT       ≈ 60s downtime, full VM
[playbook]  recommendation: HOST-REBOOT — every container has
            restart: unless-stopped, single-purpose VM, simpler invariant.

[operator]  APPROVED reboot

[exec]      reboot (vmid=101, tier=destructive)
[wait]      ssh becomes available
[verify]    podman ps → 10 containers Up
[verify]    curl localhost:8096/health → 200 in 10ms
[verify]    ss -tln :8096 → Recv-Q=0
[done]      MTTR 4m12s, root cause logged, monitor armed for recurrence
```

---

## Notes for future maintainers

- The wedge detection in step 1 is reused by other container playbooks
  (e.g. `arr-stack-wedge.md` if/when written). Keep it in a shared
  diagnostic module, not inlined.
- The `iptables -L <CHAIN>` "incompatible, use 'nft' tool" error string
  is the canonical fingerprint. Match on substring `"incompatible, use 'nft'"`
  — kernel may localize the rest of the message.
- Do **not** rely on `podman info` to report the active firewall driver;
  in 4.9.3 it omits that field. Probe by attempting an env-var override.
- This playbook does not attempt to repair the underlying split
  permanently. After recovery, file a follow-up to either rebuild netavark
  with nft support or `podman system reset` during a maintenance window.
