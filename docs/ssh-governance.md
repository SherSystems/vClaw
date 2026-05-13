# SSH Governance (v0.4.3)

Audience: operators and platform engineers running RHODES against
real SSH targets.

The SSH adapter's classifier + tier model is documented in
[`docs/ssh-adapter.md`](./ssh-adapter.md). This document covers the
v0.4.3 additions: per-target tier overrides, sudo-fallback ladder, and
the audit-trail events the adapter now emits on every call.

If you only have time to read one section, read the **Sudo-fallback
ladder** below — it is the change that lets RHODES diagnose VMs
without a permanent root SSH session and is the most operationally
load-bearing piece of v0.4.3.

---

## Per-target tier overrides

Every SSH target may now carry a `tier_overrides` block. The schema
is in [`src/providers/ssh/types.ts`](../src/providers/ssh/types.ts) as
`SshTierOverrides`. Two shapes are supported and may be combined:

| Field | Type | Effect |
|---|---|---|
| `default` | `ActionTier` | Floor tier. Every command on this target classifies at least this risky. If the base classifier returns a lower tier, it's bumped up. |
| `commands` | `Record<string, ActionTier>` | Per-tag / per-command map. Keys match either the classifier `match` tag (e.g. `"systemctl-mutate"`) or the trimmed command string verbatim. Values override the classifier's verdict. |

Both directions are supported: overrides can raise OR lower the base
classification. An operator can declare a production target
"everything here is `risky_write` even for `ls`", or unlock a specific
allowlisted command on an otherwise-locked target.

### The one rule overrides cannot break

The `never` tier is non-negotiable. The classifier returns `never`
for empty / whitespace-only commands and for anything the classifier
explicitly bans. An override CANNOT lower a `never` verdict to
anything else. This is the floor below which no per-target opt-in can
reach.

### What the audit trail records

When an override actually changes the verdict, the classification
result carries both fields:

- `base_tier` — the tier the base classifier originally returned
- `override` — the key that fired (a tag like `systemctl-mutate`, an
  exact command, or the literal string `"default"`)

These appear on every `SshExec` AgentEvent (see the audit-trail
section below) so an auditor can answer "this `systemctl restart`
would normally have been `risky_write` — why did RHODES treat it as
`safe_write` on this host?" in one log lookup.

## Sudo-fallback ladder

The ladder is exported as `runSshCommandWithSudoFallback` from
[`src/providers/ssh/client.ts`](../src/providers/ssh/client.ts). Every
SSH adapter call goes through it. It removes the awkward middle
ground where the agent's user has *enough* privilege for diagnostic
reads but not for the specific verb at hand — without forcing
operators to grant a permanent root login.

### The ladder, in three steps

1. **Try unprivileged first.** Run the command as the configured SSH
   user (`user` on the target). On success, return the result and
   stop. The escalation never fires on the happy path.
2. **Recognize a permission error.** If the unprivileged attempt
   failed with `permission denied`, `operation not permitted`, `must
   be root`, `are you root?`, `sudo: a password is required`, or
   `requires (root|superuser) privilege` in stderr — AND the leading
   verb of the command (post-trim, post-split) is in the target's
   `sudo_allowlist` — proceed to step 3. Otherwise return the
   original failure untouched.
3. **Retry with `sudo -n`.** Run `sudo -n <command>`. The `-n` flag
   forces sudo to refuse to prompt for a password — if the operator
   hasn't provisioned a NOPASSWD sudoers line, the retry fails fast
   and the original permission error surfaces. The retry result is
   returned wrapped in `SshExecWithEscalationResult` with
   `escalated: true` and `original_exit_code` set to the first
   attempt's exit code so the audit log captures the full sequence.

The leading-`sudo` strip in the classifier (one level, bounded) means
that an allowlisted read like `sudo -n df` classifies as `read` (same
as `df`), not as the fail-closed destructive default. The bound is
deliberate: `sudo sudo rm -rf /` still classifies as destructive.

### Tier-reclassification refusal

The ladder re-classifies the sudo-prefixed command through the same
classifier. If the sudo'd form lands at a *higher* tier than the
unprivileged form, the ladder refuses the retry:

- Returns `requiresApproval: true` on the result envelope
- Leaves the result fields as the original failed unprivileged attempt
- Surfaces the refusal in the caller-facing error string:
  `(sudo escalation refused — would jump tier; re-approve at higher tier)`

Rationale: the caller already passed governance on the *lower* tier.
Silently retrying at a higher tier would let the ladder bypass the
approval the operator actually granted. The caller must seek fresh
approval at the higher tier before another attempt.

In practice this is mostly defense-in-depth — the verbs operators
typically put in `sudo_allowlist` (read tooling and service-control
verbs) don't change tier with a `sudo` prefix. But the gate exists
so the audit trail can prove the constraint held.

## Audit trail — every call emits one event

Every `ssh_exec` invocation emits exactly one `AgentEvent` of type
`SshExec` (`AgentEventType.SshExec = "ssh_exec"`). Listener exceptions
are swallowed — audit MUST NOT break execution.

Sample event payload (the `data` field is a flat record; keys are
omitted when not relevant to the call):

```json
{
  "type": "ssh_exec",
  "timestamp": "2026-05-13T18:42:13.117Z",
  "data": {
    "target_id": "esxi-02",
    "command": "systemctl restart jellyfin",
    "tier": "safe_write",
    "match": "systemctl-mutate",
    "dry_run": false,
    "base_tier": "risky_write",
    "override": "systemctl-mutate",
    "outcome": "executed",
    "exit_code": 0,
    "duration_ms": 412,
    "timed_out": false,
    "truncated": false,
    "escalated": true,
    "original_exit_code": 1
  }
}
```

Field-by-field:

| Field | Always present | Meaning |
|---|---|---|
| `target_id` | yes | Registered target id, or `null` for un-routed calls |
| `command` | yes | The literal command as it would have been sent |
| `tier` | yes | Final tier after override resolution |
| `match` | when classified | Classifier tag (e.g. `journalctl`, `qm-read`) |
| `dry_run` | yes | `true` for `ssh_dry_run`, `false` for `ssh_exec` |
| `base_tier` | when override fired | Tier the base classifier returned |
| `override` | when override fired | Key that fired (`default` or a `commands.*` key) |
| `outcome` | yes | `executed` / `failed` / `refused` / `denied` |
| `exit_code`, `duration_ms`, `timed_out`, `truncated` | when executed | Standard exec metadata |
| `escalated` | when the ladder retried | `true` iff the result reflects a `sudo -n` retry |
| `original_exit_code` | when escalated | Exit code of the unprivileged first attempt |
| `requires_approval` | when ladder refused | `true` iff the ladder declined to escalate (tier jump) |
| `error` | on failure | Human-readable error reason |

## Sudo-allowlist verbs

The allowlist takes command verbs — first whitespace-separated tokens
— not full command strings. The verbs RHODES expects to see in
operator-provisioned NOPASSWD sudoers lines today:

| Verb | Typical use | Example sudo'd form |
|---|---|---|
| `systemctl` | Service control | `sudo -n systemctl restart jellyfin` |
| `journalctl` | Log inspection + vacuum | `sudo -n journalctl --vacuum-size=500M` |
| `ufw` | Firewall rule mutation (v0.4.3 classifier rule) | `sudo -n ufw allow 8096` |
| `apt` | Package cache maintenance | `sudo -n apt-get clean` |
| `df` | Disk inspection when the user lacks mount-namespace visibility | `sudo -n df -h` |
| `du` | Disk-usage walk on root-owned trees | `sudo -n du -sh /var/log` |
| `truncate` | Log truncation | `sudo -n truncate -s 0 /var/log/foo.log` |
| `mount` | Mount inspection / probe | `sudo -n mount` |
| `umount` | Unmount (typically in remediation) | `sudo -n umount /mnt/foo` |
| `dmesg` | Kernel ring buffer (root-only on hardened kernels) | `sudo -n dmesg -T --level=err` |

Adding a verb to a target's `sudo_allowlist` is an *assertion* by the
operator that the SSH user has a corresponding `NOPASSWD` sudoers
line for that verb. If the assertion is wrong, the `sudo -n` retry
fails with `sudo: a password is required` and the original failure
surfaces — fail-closed by design.

## Example `.env` JSON for a target

`RHODES_SSH_TARGETS_FILE` points at a JSON file. A target with full
v0.4.3 capabilities looks like:

```json
{
  "targets": [
    {
      "id": "jellyfin-server",
      "host": "10.0.0.101",
      "port": 22,
      "user": "rhodes",
      "identity_file": "/home/rhodes/.ssh/id_ed25519",
      "description": "Jellyfin media server (vmid 101)",
      "tier_overrides": {
        "default": "read",
        "commands": {
          "systemctl-mutate": "risky_write"
        }
      },
      "sudo_allowlist": [
        "systemctl",
        "journalctl",
        "apt",
        "df",
        "dmesg"
      ]
    }
  ]
}
```

What this configuration says:

- The target's user `rhodes` has NOPASSWD sudoers for `systemctl`,
  `journalctl`, `apt`, `df`, and `dmesg`.
- The base classifier verdict is honored, but every command floors at
  `read` (no `never`-style classification can be downgraded to
  unclassified).
- `systemctl restart/stop/start` style mutations explicitly stay at
  `risky_write` (here this matches the classifier default — included
  as documentation of intent, and as a safety net if the classifier
  table ever loosens).

The schema is validated through `SshTargetSchema` (Zod) in
[`src/config.ts`](../src/config.ts) at process startup. Configuration
errors fail fast with a precise message — no silent fallthrough.
