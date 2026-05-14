# Runbook: NUC → pranavlab SSH key bootstrap

**Audience:** operator with physical or local-network access to `pranavlab`
(the Proxmox host at `192.168.86.50`).

**Estimated time:** ~5 minutes (steps 1, 3, 4, 5, 6 take seconds each;
step 2 is the only one that requires you to be on a machine with
existing access).

## Problem

On 2026-05-13 an autonomous RHODES remediation plan failed at step 10
(`ssh_exec qm resume 200`) with `Exit code: 255`. Root cause: the RHODES
instance running on the homelab NUC (`100.73.129.96`) had no SSH key
trusted by `root@pranavlab`. Any playbook step that goes through the
SSH adapter against `pranavlab` therefore fails, and the operator has
to finish recovery by hitting the Proxmox API directly. We need a
key-auth path from the NUC to `pranavlab` so `qm` fallbacks work
unattended.

The agent **cannot** install its own public key — it has no existing
SSH access and password auth from the NUC is blocked
(see `~/.claude/projects/-home-pranav/memory/reference_proxmox_ssh_jump.md`).
The operator does step 2 below. Everything else has already been
prepared by the agent.

## What the agent has already done

| Action | Where | When |
|---|---|---|
| Generated ed25519 keypair `~/.ssh/rhodes-pranavlab{,.pub}` | NUC (`100.73.129.96`, user `pranav`) | 2026-05-14 |
| Created `~/.config/rhodes/ssh-targets.json` with a `pranavlab` entry | NUC | 2026-05-14 |
| Appended `RHODES_SSH_TARGETS_FILE=/home/pranav/.config/rhodes/ssh-targets.json` to `~/rhodes/.env` (backup saved as `~/rhodes/.env.bak.<ts>`) | NUC | 2026-05-14 |
| Wrote this runbook + `scripts/test-ssh-to-pranavlab.ts` | repo branch `feature/nuc-ssh-key-runbook` | 2026-05-14 |

The RHODES service on the NUC was **not** restarted — it is still
running with the old in-memory config (no `pranavlab` target). It will
pick up the new target on its next restart.

## Prerequisites

- You have password (or existing key) access to `root@192.168.86.50`
  from at least one machine on the local network. `pranavserver`
  qualifies (it has `sshpass` installed per
  `reference_proxmox_ssh_jump.md`).
- You can SSH into the NUC as `pranav` (Tailscale → `100.73.129.96`).

## The public key

This is what needs to land in `root@pranavlab:~/.ssh/authorized_keys`:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPAenk24SCpgVe/3m2xdFVCMQ+2AFw/F8TqVCKkbX+Qq rhodes@homelab -> pranavlab
```

(The private half lives only on the NUC at `/home/pranav/.ssh/rhodes-pranavlab`
with mode `600`. It never leaves the NUC.)

## Step 1 — Sanity-check the artifacts on the NUC

From any machine that can SSH the NUC as `pranav`:

```bash
ssh pranav@100.73.129.96 'ls -la ~/.ssh/rhodes-pranavlab* ~/.config/rhodes/ssh-targets.json && grep RHODES_SSH_TARGETS_FILE ~/rhodes/.env'
```

You should see:

- `rhodes-pranavlab` mode `600`, owned by `pranav`
- `rhodes-pranavlab.pub` readable
- `ssh-targets.json` mode `600`, containing the `pranavlab` entry
- `RHODES_SSH_TARGETS_FILE=/home/pranav/.config/rhodes/ssh-targets.json` in `.env`

If any of those is missing, stop and re-run the bootstrap.

## Step 2 — Install the public key on pranavlab

Pick one of the paths below. (a) is the fastest if you're sitting at
`pranavserver` or any machine that already has access; (b) and (c)
are fallbacks.

### (a) From a machine with existing password/key access to root@pranavlab

```bash
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPAenk24SCpgVe/3m2xdFVCMQ+2AFw/F8TqVCKkbX+Qq rhodes@homelab -> pranavlab' \
  | ssh root@192.168.86.50 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

If you're on `pranavserver` and password is required, pipe through `sshpass`:

```bash
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPAenk24SCpgVe/3m2xdFVCMQ+2AFw/F8TqVCKkbX+Qq rhodes@homelab -> pranavlab' \
  | sshpass -p 'Patel@0606' ssh -o StrictHostKeyChecking=no root@192.168.86.50 \
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

### (b) Proxmox web UI

1. Open `https://192.168.86.50:8006` in a browser.
2. Datacenter → Permissions → Users → `root@pam` does not directly let
   you paste an SSH key; instead open the **node-level** shell:
   Datacenter → `pranavlab` (node) → `>_ Shell`.
3. In the shell, paste:
   ```bash
   echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPAenk24SCpgVe/3m2xdFVCMQ+2AFw/F8TqVCKkbX+Qq rhodes@homelab -> pranavlab' >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```

### (c) Physical console / IPMI

Same one-liner as (b) above, just typed at the console.

## Step 3 — Verify from the NUC

```bash
ssh pranav@100.73.129.96 'ssh -o BatchMode=yes -i ~/.ssh/rhodes-pranavlab -o StrictHostKeyChecking=accept-new root@192.168.86.50 pveversion'
```

Expect a single line like `pve-manager/8.x.y/...`. `BatchMode=yes`
ensures it fails fast if the key is still not trusted (no password
prompt).

If you see `Permission denied (publickey)`, step 2 didn't take. Re-run.

## Step 4 — Restart RHODES so the SSH adapter picks up the new target

```bash
ssh pranav@100.73.129.96 'systemctl --user restart rhodes && sleep 2 && systemctl --user status rhodes --no-pager | head -15'
```

The new `pranavlab` target only registers at adapter init time, so a
restart is required. (We held off doing this autonomously while the
NUC was in shadow-off mode with a live `current_plan` — at runbook
time the operator is awake and aware of the restart cost.)

## Step 5 — Smoke-test via the new script

```bash
ssh pranav@100.73.129.96 'cd ~/rhodes && npx tsx scripts/test-ssh-to-pranavlab.ts'
```

Expected output ends with:

```
[OK] pranavlab reachable via SSH adapter.
```

The script does an offline classify (`ssh_dry_run`) of `pveversion`
and then a real `ssh_exec`. If it fails, the printed `[FAIL] ...`
line maps to a specific cause (auth, host-key, network, missing
target). Fix accordingly and re-run.

## Step 6 — Confirm the audit log

Open the RHODES dashboard (homelab port `7412` over Tailscale) →
**Audit Log** tab. Filter on `SshExec`. You should see a row from
~30 seconds ago:

- `target=pranavlab`
- `command=pveversion`
- `tier=read`
- `exit_code=0`

If the row is present, the SSH adapter is wired end-to-end and the
next autonomous remediation plan that needs `qm resume` will succeed.

## Rollback

If for any reason the new target causes problems and the daemon needs
to forget pranavlab:

```bash
ssh pranav@100.73.129.96 'mv ~/.config/rhodes/ssh-targets.json ~/.config/rhodes/ssh-targets.json.disabled && systemctl --user restart rhodes'
```

The adapter falls back to its prior state (zero SSH targets, adapter
not registered at all).

To revoke the key on `pranavlab`, delete the matching line from
`/root/.ssh/authorized_keys` (the comment `rhodes@homelab -> pranavlab`
makes it easy to find).
