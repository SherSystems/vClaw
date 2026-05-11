# SSH Adapter

## What it is

`SshAdapter` is a first-class shell-execution surface for RHODES. It lets the agent log into any **registered** SSH target the same way a human SRE would: open a session, run a command, capture stdout/stderr/exit-code, hand the result back. It complements (not replaces) the existing API-based provider adapters (Proxmox REST, vSphere, AWS, Azure, Kubernetes).

It lives at `src/providers/ssh/` and registers as a `kind: "service"` adapter — so it does **not** show up as a hypervisor in the dashboard provider list (no nodes/VMs/storage to surface).

## Why

The autopilot can't fix everything via API.

- A vCenter that's gone catatonic still has an `esxcli` shell.
- A wedged Proxmox node responds to `qm stop 200 --skiplock` over SSH long after the REST API gives up.
- Most "diagnose this weird symptom" loops are five `cat`/`grep`/`journalctl` commands away from a root cause.

Without an SSH surface RHODES has to escalate to a human for the "boring" 80% of incident response. With one, it can investigate, gather evidence, and propose remediation — all under the same governance regime as every other tool call.

## Safety model

Every call goes through three gates:

1. **Classifier** (`src/providers/ssh/safety.ts`). The raw command string is mapped to a governance tier:
   - `read` — `cat`, `ls`, `head`, `tail`, `grep`, `find`, `journalctl`, `systemctl status`, `qm list/status/config`, `pct list`, `df`, `free`, `uptime`, `ps`, `top -b -n1`, `uname`, `cat /proc/...`, `vmkfstools`, `esxcli ... list/get`, `vim-cmd ... get*`.
   - `safe_write` — `mkdir`, `touch`, `cp`, `chmod`, `chown`, `ln -s`.
   - `risky_write` — `qm start/stop/shutdown/reboot/reset`, `pct start/stop/...`, `systemctl restart/reload/start/stop`, `service ... restart`, `kill <pid>`, `pkill`, `killall`, `esxcli ... set/add/remove`, `vim-cmd vmsvc/power.*`.
   - `destructive` — `qm destroy/delete`, `pct destroy`, `rm -rf`, `dd of=`, `mkfs`, `fdisk`, `parted`, `wipefs`, `iptables -F`, `firewall-cmd --reload`, `reboot`/`shutdown`/`poweroff`/`halt`, `init 0`/`init 6`, anything touching `/dev/sd*` etc.
   - `never` — empty / whitespace.

   **Fail closed.** Any command that doesn't match a known pattern is classified as `destructive`. Any command containing shell metacharacters (`;`, `|`, `&`, `` ` ``, `$()`, `${}`, `<`, `>`) or output redirection is *also* bumped to `destructive` — we can't statically reason about pipelines or substitutions.

2. **Kill-switch** (`ssh.allow_destructive`, default `false`). When off, destructive commands are refused outright before any approval flow runs. When on, they can be **proposed** but still require explicit per-call approval. There is no path that auto-runs a destructive shell command.

3. **Governance integration**. `SshAdapter` accepts an optional `governanceEvaluator` injected by the agent. The adapter calls it with the classified tier and the command; if it returns `allowed: false`, execution is short-circuited. The adapter never bypasses governance.

## Configuration

Targets are loaded from a JSON file (preferred — keeps secrets out of `process.env`) or inline JSON:

```bash
# Recommended: file
export RHODES_SSH_TARGETS_FILE=/etc/rhodes/ssh-targets.json

# Acceptable for one-off scripts
export RHODES_SSH_TARGETS='[{"id":"self","host":"127.0.0.1","user":"rhodes"}]'

# Optional knobs (sensible defaults)
export RHODES_SSH_MAX_OUTPUT_BYTES=65536
export RHODES_SSH_DEFAULT_TIMEOUT_S=30
export RHODES_SSH_ALLOW_DESTRUCTIVE=false
export RHODES_SSH_STRICT_HOST_KEY_CHECKING=true
```

The targets file looks like:

```json
[
  {
    "id": "pve-01",
    "host": "10.0.0.10",
    "user": "root",
    "identity_file": "/etc/rhodes/keys/pve-01",
    "description": "Lab Proxmox primary"
  },
  {
    "id": "esxi-lab",
    "host": "esxi.lab.internal",
    "user": "root",
    "jump_host": "bastion@10.0.0.99",
    "identity_file": "/etc/rhodes/keys/esxi"
  }
]
```

`identity_file` paths are **never** logged or returned by `ssh_list_targets`. Operators see only `has_identity_file: true`.

## Tools

The adapter registers three tools:

| Tool               | Tier (base) | Purpose                                                                                                      |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `ssh_list_targets` | `read`      | Returns configured targets (without `identity_file`).                                                        |
| `ssh_dry_run`      | `read`      | Classifies a command and returns `{ tier, reason, match }` without running it. Use this BEFORE `ssh_exec`.   |
| `ssh_exec`         | `risky_write` | Runs `command` on `target_id`. Real tier is decided per-call by the classifier and may elevate to `destructive`. |

`ssh_exec` returns:

```ts
{
  exit_code: number,    // 0 success; 124 timed out; 127 spawn error
  stdout: string,       // capped at max_output_bytes
  stderr: string,       // capped at max_output_bytes
  truncated: boolean,   // true if either was capped
  duration_ms: number,
  timed_out: boolean,
  classification: SshClassification,
  target_id: string,
}
```

## Security warnings

- Commands run with whatever shell power the configured user has on the remote host. **Don't run as `root`** if you can avoid it. Most diagnostic tasks work fine as a dedicated `rhodes` user with `sudo` on a small allowlist.
- Configure `identity_file` per target. SSH-agent forwarding is not enabled (`BatchMode=yes`) — passwords aren't even prompted for, so a misconfigured target fails fast instead of hanging.
- The adapter uses the system `ssh` binary (no third-party SSH library), inheriting your `~/.ssh/config` and known-hosts behaviour. Set `strict_host_key_checking: true` (the default) for any target you actually care about.
- Never put real secrets in `RHODES_SSH_TARGETS` (process env is world-readable on shared hosts via `/proc/<pid>/environ`). Use the file form.
- Audit logs (when wired in — see TODO list) will capture command + classification + target_id; redact accordingly.

## Hello world

```
npx tsx scripts/ssh-hello.ts
```

This loads config, builds a single-target adapter pointed at `127.0.0.1`, runs `ssh_list_targets`, dry-runs a destructive command, and tries `uptime`. Prints the structured result either way.

## TODO — next iteration

In rough priority order:

1. **Per-target tier overrides.** Some operators want `qm stop` to be `safe_write` on a sandbox PVE but `risky_write` on prod. Allow `targets[*].tier_overrides` keyed by command pattern.
2. **Pre-built playbook tools.** `esxi_diagnose` (run a fixed set of read-only commands and summarize), `proxmox_node_health`, `vm_log_grep`. These compose `ssh_exec` calls and ship as their own tools so the agent doesn't have to reason about command shapes from scratch.
3. **Audit-trail integration** with `src/governance/audit.ts`. Emit `AuditEntry` rows on every `ssh_exec` invocation including classification + truncation status. Today the adapter relies on the executor's existing audit path; making it explicit would make the SSH lane greppable.
4. **Log redaction.** Pre-execution scrub of obvious secrets in stdout (AWS keys, JWTs, password regex). Plus opt-in stdout-only logging for read commands.
5. **SSH cert auth.** Support `CertificateFile=` for short-lived signed certs from a step-ca / Vault SSH-CA backend instead of long-lived keys.
6. **Per-target connection pooling** (`ControlMaster=auto`) to amortize handshake cost when an investigation runs ten commands on one host.
7. **Agent-driven remediation playbooks.** Today `ssh_exec` is single-shot. The next phase: a remediation skill ("diagnose unreachable ESXi") that orchestrates a sequence of `ssh_exec` calls with conditional branching, each of which is approved at the playbook level rather than per-command.
8. **Dashboard panel.** Surface configured targets and recent execs (with classification badges) in the dashboard UI. `kind: "service"` adapters are filtered out of the provider list today; we'd add a dedicated SSH section.
9. **Allowlist as YAML.** Instead of editing `safety.ts`, let operators ship a YAML allowlist alongside `policies/default.yaml` — same shape (regex + tier + tag).
