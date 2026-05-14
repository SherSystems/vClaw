# Runbook: NUC → Proxmox SSH key bootstrap

**Audience:** operator with physical or local-network access to the
target Proxmox host.

**Estimated time:** ~5 minutes (steps 1, 3, 4, 5, 6 take seconds each;
step 2 is the only one that requires you to be on a machine with
existing access to the Proxmox host).

## Why this runbook exists

When a RHODES playbook step goes through the SSH adapter against a
Proxmox host (e.g. `qm resume` as a fallback when the Proxmox API
isn't enough), the agent host needs an authorized key on the Proxmox
node. The agent **cannot** install its own public key — it has no
existing SSH access. The operator does step 2 below.

This runbook walks through bootstrapping that trust the first time.
Everything except step 2 is automatable; we've kept it on rails so
re-runs are deterministic.

## Configuration

These placeholders appear throughout the runbook. Set them once for
your environment:

```bash
export RHODES_HOST=<your-rhodes-host>           # the host running rhodes.service (NUC, VM, container)
export RHODES_USER=<your-rhodes-user>           # SSH user on RHODES_HOST (typically the operator account)
export PROXMOX_HOST=<your-proxmox-host>         # the Proxmox node's IP or hostname on the LAN
export TARGET_NAME=<symbolic-target-name>       # name registered in ssh-targets.json (e.g. "pve-01")
```

The example commands below use `${RHODES_HOST}`, `${RHODES_USER}`,
etc. — substitute or `export` them in your shell first.

## What the agent has already done

Before you start this runbook, the RHODES install script /
provisioning flow has typically already done:

| Action | Where |
|---|---|
| Generated ed25519 keypair `~/.ssh/rhodes-${TARGET_NAME}{,.pub}` | `${RHODES_HOST}`, user `${RHODES_USER}` |
| Created `~/.config/rhodes/ssh-targets.json` with a `${TARGET_NAME}` entry | `${RHODES_HOST}` |
| Appended `RHODES_SSH_TARGETS_FILE=...` to `~/rhodes/.env` | `${RHODES_HOST}` |

The RHODES service is **not** automatically restarted by the bootstrap
— it picks up the new target on its next restart, which the operator
controls.

## Prerequisites

- You have password or existing-key access to `root@${PROXMOX_HOST}`
  from at least one machine on the local network.
- You can SSH into `${RHODES_HOST}` as `${RHODES_USER}` (key-based;
  password auth is typically disabled).

## The public key

The public half that needs to land in
`root@${PROXMOX_HOST}:~/.ssh/authorized_keys`:

```bash
ssh ${RHODES_USER}@${RHODES_HOST} cat ~/.ssh/rhodes-${TARGET_NAME}.pub
```

(The private half lives only on `${RHODES_HOST}` at
`/home/${RHODES_USER}/.ssh/rhodes-${TARGET_NAME}` with mode `600`. It
never leaves the agent host.)

## Step 1 — Sanity-check the artifacts on the RHODES host

```bash
ssh ${RHODES_USER}@${RHODES_HOST} \
  'ls -la ~/.ssh/rhodes-* ~/.config/rhodes/ssh-targets.json && grep RHODES_SSH_TARGETS_FILE ~/rhodes/.env'
```

You should see:

- `rhodes-${TARGET_NAME}` mode `600`, owned by `${RHODES_USER}`
- `rhodes-${TARGET_NAME}.pub` readable
- `ssh-targets.json` mode `600`, containing the `${TARGET_NAME}` entry
- `RHODES_SSH_TARGETS_FILE=/home/${RHODES_USER}/.config/rhodes/ssh-targets.json` in `.env`

If any of those is missing, stop and re-run the bootstrap step in the
install flow before continuing.

## Step 2 — Install the public key on the Proxmox host

Pick one of the paths below. (a) is the fastest if you're sitting at
a machine that already has access; (b) and (c) are fallbacks for
locked-down environments.

### (a) From a machine with existing password/key access to `root@${PROXMOX_HOST}`

```bash
PUBKEY=$(ssh ${RHODES_USER}@${RHODES_HOST} cat ~/.ssh/rhodes-${TARGET_NAME}.pub)

echo "${PUBKEY}" \
  | ssh root@${PROXMOX_HOST} \
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

If password auth is required and you have `sshpass` installed locally,
read the password from your secrets manager — **do not hardcode it in
shell scripts** and **do not paste it into a file that lives in a
repo**:

```bash
PROXMOX_PASS=$(pass show proxmox/root)   # or `op read`, `keyring get`, etc.
echo "${PUBKEY}" \
  | sshpass -p "${PROXMOX_PASS}" ssh -o StrictHostKeyChecking=no root@${PROXMOX_HOST} \
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

### (b) Proxmox web UI shell

1. Open `https://${PROXMOX_HOST}:8006` in a browser.
2. Open the node-level shell: Datacenter → `<node>` → `>_ Shell`.
3. In the shell, paste:
   ```bash
   echo '<paste the public key here>' >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```

### (c) Physical console / IPMI

Same one-liner as (b) above, just typed at the console.

## Step 3 — Verify from the RHODES host

```bash
ssh ${RHODES_USER}@${RHODES_HOST} \
  "ssh -o BatchMode=yes -i ~/.ssh/rhodes-${TARGET_NAME} -o StrictHostKeyChecking=accept-new root@${PROXMOX_HOST} pveversion"
```

Expect a single line like `pve-manager/8.x.y/...`. `BatchMode=yes`
ensures it fails fast if the key is still not trusted (no password
prompt).

If you see `Permission denied (publickey)`, step 2 didn't take.
Re-run.

## Step 4 — Restart RHODES so the SSH adapter picks up the new target

```bash
ssh ${RHODES_USER}@${RHODES_HOST} \
  'systemctl --user restart rhodes && sleep 2 && systemctl --user status rhodes --no-pager | head -15'
```

The new target only registers at adapter init time, so a restart is
required. Time this restart for when RHODES is idle — a restart
mid-plan clears `current_plan` state, and you don't want to drop an
in-flight remediation.

## Step 5 — Smoke-test via the supplied script

```bash
ssh ${RHODES_USER}@${RHODES_HOST} \
  'cd ~/rhodes && npx tsx scripts/test-ssh-to-pranavlab.ts'
```

(The script name is historical; it accepts any `${TARGET_NAME}` via
its argv or by reading `ssh-targets.json`. See the script for usage.)

Expected output ends with:

```
[OK] <target> reachable via SSH adapter.
```

The script does an offline classify (`ssh_dry_run`) of `pveversion`
and then a real `ssh_exec`. If it fails, the printed `[FAIL] ...`
line maps to a specific cause (auth, host-key, network, missing
target). Fix accordingly and re-run.

## Step 6 — Confirm the audit log

Open the RHODES dashboard → **Audit Log** tab. Filter on `SshExec`.
You should see a row from ~30 seconds ago:

- `target=${TARGET_NAME}`
- `command=pveversion`
- `tier=read`
- `exit_code=0`

If the row is present, the SSH adapter is wired end-to-end and the
next autonomous remediation plan that needs `qm <verb>` will succeed.

## Rollback

If for any reason the new target causes problems and the daemon needs
to forget it:

```bash
ssh ${RHODES_USER}@${RHODES_HOST} \
  'mv ~/.config/rhodes/ssh-targets.json ~/.config/rhodes/ssh-targets.json.disabled && systemctl --user restart rhodes'
```

The adapter falls back to its prior state (no SSH targets, adapter
not registered at all).

To revoke the key on the Proxmox host, delete the matching line from
`/root/.ssh/authorized_keys` (the trailing comment `rhodes@<host> ->
<target>` makes it easy to find).

## Security notes

- The public key is fine to commit/share. The private key never
  leaves `${RHODES_HOST}` and is mode `600`.
- `sshpass` reads passwords from the command line, which leaks them
  into shell history and process listings. Source the value from a
  password manager (`pass`, `op`, `keyring`, etc.) and avoid
  persisting it anywhere. If you've ever committed a literal password
  into a runbook in this repo, **rotate it immediately** — git
  history retains it even after redaction commits.
- `BatchMode=yes` on the verification step is intentional: it ensures
  step 3 fails loudly with `Permission denied (publickey)` instead of
  silently prompting for a password and creating a misleading "it
  worked" feeling.
- Per-target tier overrides + sudo allowlist are in
  `ssh-targets.json` — the adapter classifies `qm <verb>` calls
  through the safety classifier before execution. See
  `docs/ssh-governance.md`.
