// ============================================================
// RHODES — pranavlab SSH smoke-test
//
// Verifies that the SSH adapter on this host can reach the
// Proxmox box at the `pranavlab` target id. Designed to be run
// from the homelab NUC AFTER the operator has installed the
// rhodes-pranavlab public key in root@pranavlab:~/.ssh/authorized_keys.
//
// What this script does, in order:
//
//   1. Loads the configured SshTargets via getConfig() — so it
//      sees the same `pranavlab` entry the daemon would see.
//   2. Confirms a target with id="pranavlab" is registered, and
//      that it carries an `identity_file` (otherwise the agent
//      cannot reach an authorized-keys-only host).
//   3. Asks the adapter to `ssh_dry_run` a harmless `pveversion`
//      command and prints the classification — this is a fully
//      offline check; it never touches the network.
//   4. Runs `ssh_exec` with the same command, capturing exit
//      code, duration, and stderr. Prints the result and a
//      diagnostic if the call failed.
//
// Run from the NUC:
//   cd ~/rhodes && npx tsx scripts/test-ssh-to-pranavlab.ts
//
// Exit codes:
//   0 — pveversion succeeded
//   1 — config / target missing
//   2 — dry-run classified as something unexpected (never/destructive)
//   3 — ssh_exec failed (auth, network, etc.) — stderr is printed
//
// This script is read-only: the only command it issues is
// `pveversion`, which classifies as `read` on every host.
// ============================================================

import "dotenv/config";
import { getConfig } from "../src/config.js";
import { SshAdapter } from "../src/providers/ssh/adapter.js";
import type { SshExecResult } from "../src/providers/ssh/types.js";

const TARGET_ID = "pranavlab";
const PROBE_COMMAND = "pveversion";

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function diagnoseExecFailure(result: SshExecResult): string {
  if (result.timed_out) {
    return "Timed out — pranavlab unreachable from this host. Check that 192.168.86.50 is on the same LAN segment, or that a jump_host is configured.";
  }
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes("permission denied")) {
    return "Permission denied — the public key has not been installed in root@pranavlab:~/.ssh/authorized_keys, OR the identity_file path is wrong. Re-run step 2 of the runbook.";
  }
  if (stderr.includes("host key verification failed")) {
    return "Host key mismatch — pranavlab's host key changed (or was never recorded). Run `ssh-keyscan -H 192.168.86.50 >> ~/.ssh/known_hosts` from the NUC, or set SYSTEM_SSH_STRICT_HOST_KEY_CHECK=false in ~/rhodes/.env.";
  }
  if (stderr.includes("no route to host") || stderr.includes("network is unreachable")) {
    return "No route to host — pranavlab is offline or the NUC has no path to 192.168.86.50.";
  }
  if (stderr.includes("connection refused")) {
    return "Connection refused on port 22 — sshd is down on pranavlab, or a firewall blocks it.";
  }
  if (result.exit_code === 127) {
    return "exit_code=127 — `pveversion` not found. Is this actually a Proxmox host? Re-check `host` in ~/.config/rhodes/ssh-targets.json.";
  }
  return `Unexpected failure (exit_code=${result.exit_code}). Inspect stderr above.`;
}

async function main() {
  const config = getConfig();
  const targets = config.ssh.targets;

  console.log("=== RHODES SSH smoke-test → pranavlab ===");
  console.log(`Configured SSH targets: ${targets.length === 0 ? "(none)" : targets.map((t) => t.id).join(", ")}`);

  const target = targets.find((t) => t.id === TARGET_ID);
  if (!target) {
    console.error(
      `\n[FAIL] No SSH target with id="${TARGET_ID}" is configured.\n` +
        `       Make sure RHODES_SSH_TARGETS_FILE in ~/rhodes/.env points at a JSON\n` +
        `       file that contains a "${TARGET_ID}" entry. See\n` +
        `       docs/runbooks/nuc-ssh-to-pranavlab-bootstrap.md.`,
    );
    process.exit(1);
  }

  if (!target.identity_file) {
    console.error(
      `\n[FAIL] Target "${TARGET_ID}" has no identity_file set.\n` +
        `       The NUC has no key on the SSH agent for pranavlab, so it MUST\n` +
        `       use an explicit identity_file. Edit ~/.config/rhodes/ssh-targets.json\n` +
        `       and add: "identity_file": "/home/pranav/.ssh/rhodes-pranavlab".`,
    );
    process.exit(1);
  }

  console.log(`Target: ${target.user}@${target.host}:${target.port ?? 22}`);
  console.log(`identity_file: ${target.identity_file}`);
  console.log(`description: ${target.description ?? "(none)"}`);

  const adapter = new SshAdapter({
    targets: [target],
    strict_host_key_checking: config.ssh.strict_host_key_checking,
    default_timeout_s: config.ssh.default_timeout_s ?? 10,
  });
  await adapter.connect();

  // Step 1 — offline classification.
  console.log(`\n[1/2] ssh_dry_run("${PROBE_COMMAND}")`);
  const dry = await adapter.execute("ssh_dry_run", {
    command: PROBE_COMMAND,
    target_id: TARGET_ID,
  });
  if (!dry.success) {
    console.error(`      dry_run errored: ${dry.error}`);
    await adapter.disconnect();
    process.exit(2);
  }
  const classification = dry.data as { tier: string; reason: string; match?: string };
  console.log(
    `      tier=${classification.tier} match=${classification.match ?? "(none)"} reason="${classification.reason}"`,
  );
  if (classification.tier !== "read") {
    console.error(
      `\n[FAIL] Expected pveversion to classify as "read" but got "${classification.tier}".\n` +
        `       This means a tier_override is misconfigured on the pranavlab target.`,
    );
    await adapter.disconnect();
    process.exit(2);
  }

  // Step 2 — actual exec.
  console.log(`\n[2/2] ssh_exec target=${TARGET_ID} command="${PROBE_COMMAND}"`);
  const t0 = Date.now();
  const execResult = await adapter.execute("ssh_exec", {
    target_id: TARGET_ID,
    command: PROBE_COMMAND,
  });
  const wallMs = Date.now() - t0;

  const result = (execResult.data as SshExecResult | undefined) ?? null;
  if (!execResult.success || !result) {
    console.error(`      ssh_exec failed: ${execResult.error ?? "no result returned"}`);
    if (result) {
      console.error(`      stderr: ${result.stderr.trim() || "(empty)"}`);
      console.error(`      ${diagnoseExecFailure(result)}`);
    }
    await adapter.disconnect();
    process.exit(3);
  }

  console.log(
    `      exit_code=${result.exit_code} duration=${fmtMs(result.duration_ms)} (wall=${fmtMs(wallMs)}) timed_out=${result.timed_out}`,
  );
  if (result.stdout.trim()) console.log(`      stdout: ${result.stdout.trim().split("\n")[0]}`);
  if (result.stderr.trim()) console.log(`      stderr: ${result.stderr.trim()}`);

  await adapter.disconnect();

  if (result.exit_code !== 0 || result.timed_out) {
    console.error(`\n[FAIL] ${diagnoseExecFailure(result)}`);
    process.exit(3);
  }

  console.log(`\n[OK] pranavlab reachable via SSH adapter.`);
  console.log(`     Next: confirm the dashboard audit log shows an SshExec event with target=${TARGET_ID}.`);
}

main().catch((err) => {
  console.error("test-ssh-to-pranavlab errored:", err);
  process.exit(1);
});
