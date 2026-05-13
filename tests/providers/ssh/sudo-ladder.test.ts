// ============================================================
// RHODES — sudo-fallback ladder (runSshCommandWithSudoFallback)
//
// These tests drive the ladder through every documented branch via
// the `spawnFn` test seam. The ladder MUST:
//   1. Run the unprivileged command first.
//   2. Only retry with `sudo -n` if stderr matches a permission
//      pattern AND the verb is in the target's sudo_allowlist.
//   3. Refuse to escalate if the sudo'd command classifies HIGHER
//      than the original (caller already passed governance at the
//      lower tier).
//   4. Surface escalation status via `escalated` / `original_exit_code`
//      / `requiresApproval` audit fields.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  runSshCommandWithSudoFallback,
} from "../../../src/providers/ssh/client.js";
import type {
  SpawnFn,
  SpawnedProcess,
} from "../../../src/providers/ssh/client.js";
import type { SshTarget } from "../../../src/providers/ssh/types.js";

// ── Programmable fake spawn ──────────────────────────────────
//
// The ladder calls spawn at most twice: once for the unprivileged
// attempt, optionally once for the sudo retry. We give the test a
// FIFO queue of "this is what the next ssh call should look like"
// behaviours and capture the commands actually sent so we can assert
// on them.

interface FakeProc extends SpawnedProcess {
  killed: boolean;
}

interface Step {
  /** Bytes to push to stdout before close. */
  stdout?: string;
  /** Bytes to push to stderr before close. */
  stderr?: string;
  /** Exit code to emit. */
  exit: number;
}

/**
 * Build a spawn that pops the next Step from `steps` on each
 * invocation. Records the command (last arg of argv) into
 * `seenCommands` so tests can assert "the ladder retried with
 * `sudo -n <X>`" or "the ladder did NOT retry".
 */
function makeQueuedSpawn(steps: Step[]): {
  fn: SpawnFn;
  seenCommands: string[];
  invocations: () => number;
} {
  const seenCommands: string[] = [];
  let invocations = 0;
  const fn: SpawnFn = (_cmd, args) => {
    invocations += 1;
    // ssh argv ends with the destination (user@host) then the command;
    // the command is always the last arg.
    seenCommands.push(args[args.length - 1] as string);

    const step = steps.shift() ?? { exit: 0 };
    const stdoutE = new EventEmitter();
    const stderrE = new EventEmitter();
    const procE = new EventEmitter();
    const proc: FakeProc = {
      stdout: stdoutE as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
      stderr: stderrE as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
      on: ((e: string, cb: (...a: unknown[]) => void) => procE.on(e, cb)) as SpawnedProcess["on"],
      kill: () => { proc.killed = true; return true; },
      killed: false,
    };
    setImmediate(() => {
      if (step.stdout) stdoutE.emit("data", Buffer.from(step.stdout));
      if (step.stderr) stderrE.emit("data", Buffer.from(step.stderr));
      procE.emit("close", step.exit);
    });
    return proc;
  };
  return { fn, seenCommands, invocations: () => invocations };
}

const baseTarget: SshTarget = {
  id: "lab",
  host: "10.0.0.10",
  user: "ops",
};

const baseOpts = {
  target: baseTarget,
  command: "df -h",
  timeoutMs: 5000,
  maxOutputBytes: 65536,
  strictHostKeyChecking: true,
};

// ── Tests ────────────────────────────────────────────────────

describe("runSshCommandWithSudoFallback", () => {
  // 1. Happy path: perm denied → sudo retry → success.
  it("retries with sudo -n when stderr says 'permission denied' and verb is allowlisted", async () => {
    const { fn, seenCommands, invocations } = makeQueuedSpawn([
      { exit: 1, stderr: "df: cannot read /root: Permission denied\n" },
      { exit: 0, stdout: "Filesystem  Size\n/dev/sda1   100G\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["df"] },
      command: "df -h",
      spawnFn: fn,
    });

    expect(invocations()).toBe(2);
    expect(seenCommands[0]).toBe("df -h");
    expect(seenCommands[1]).toBe("sudo -n df -h");
    expect(result.exit_code).toBe(0);
    expect(result.escalated).toBe(true);
    expect(result.original_exit_code).toBe(1);
    expect(result.requiresApproval).toBe(false);
    expect(result.stdout).toContain("/dev/sda1");
  });

  // 2. No-retry happy path: first attempt succeeds — ladder is a noop.
  it("does NOT retry when the first attempt succeeds", async () => {
    const { fn, invocations } = makeQueuedSpawn([
      { exit: 0, stdout: "up 1 day\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["df", "uptime"] },
      command: "uptime",
      spawnFn: fn,
    });

    expect(invocations()).toBe(1);
    expect(result.exit_code).toBe(0);
    expect(result.escalated).toBe(false);
    expect(result.original_exit_code).toBeUndefined();
    expect(result.requiresApproval).toBe(false);
  });

  // 3. Refused: verb not in allowlist → original failure returned, no retry.
  it("does NOT retry when the failed verb is absent from sudo_allowlist", async () => {
    const { fn, invocations, seenCommands } = makeQueuedSpawn([
      { exit: 13, stderr: "mount: only root can do that\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      // allowlist exists but doesn't cover the verb `mount`.
      target: { ...baseTarget, sudo_allowlist: ["df", "journalctl"] },
      command: "mount /dev/sdb1 /mnt",
      spawnFn: fn,
    });

    expect(invocations()).toBe(1);
    expect(seenCommands).toEqual(["mount /dev/sdb1 /mnt"]);
    expect(result.exit_code).toBe(13);
    expect(result.escalated).toBe(false);
    expect(result.requiresApproval).toBe(false);
    expect(result.stderr).toContain("only root");
  });

  // 4. No allowlist at all — fail-closed default.
  it("does NOT retry when target has no sudo_allowlist (fail-closed default)", async () => {
    const { fn, invocations } = makeQueuedSpawn([
      { exit: 1, stderr: "Permission denied\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      // No sudo_allowlist field at all.
      target: baseTarget,
      command: "journalctl -u nginx",
      spawnFn: fn,
    });

    expect(invocations()).toBe(1);
    expect(result.exit_code).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  // 5. Permission-denied-but-no-allowlist (empty list) — also no retry.
  it("does NOT retry when sudo_allowlist is the empty array", async () => {
    const { fn, invocations } = makeQueuedSpawn([
      { exit: 1, stderr: "permission denied\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: [] },
      command: "df -h",
      spawnFn: fn,
    });

    expect(invocations()).toBe(1);
    expect(result.escalated).toBe(false);
  });

  // 6. First attempt fails for non-permission reasons — no retry.
  it("does NOT retry when stderr does not look like a permission error", async () => {
    const { fn, invocations, seenCommands } = makeQueuedSpawn([
      { exit: 127, stderr: "bash: dfx: command not found\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["dfx"] },
      command: "dfx --version",
      spawnFn: fn,
    });

    expect(invocations()).toBe(1);
    expect(seenCommands).toEqual(["dfx --version"]);
    expect(result.exit_code).toBe(127);
    expect(result.escalated).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  // 7. Sudo retry itself fails — propagate that failure with escalated=true.
  it("propagates the sudo retry's failure when sudo itself can't authenticate", async () => {
    const { fn, invocations } = makeQueuedSpawn([
      { exit: 1, stderr: "Permission denied\n" },
      { exit: 1, stderr: "sudo: a password is required\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["df"] },
      command: "df -h",
      spawnFn: fn,
    });

    expect(invocations()).toBe(2);
    expect(result.exit_code).toBe(1);
    expect(result.escalated).toBe(true);
    expect(result.original_exit_code).toBe(1);
    expect(result.stderr).toContain("password is required");
    expect(result.requiresApproval).toBe(false);
  });

  // 8. Recognises EPERM-flavoured stderr ("operation not permitted").
  it("recognises 'operation not permitted' as a permission error", async () => {
    const { fn, invocations, seenCommands } = makeQueuedSpawn([
      { exit: 1, stderr: "umount: /mnt: operation not permitted\n" },
      { exit: 0, stdout: "" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["umount"] },
      command: "umount /mnt",
      spawnFn: fn,
    });
    expect(invocations()).toBe(2);
    expect(seenCommands[1]).toBe("sudo -n umount /mnt");
    expect(result.escalated).toBe(true);
    expect(result.exit_code).toBe(0);
  });

  // 9. "must be root" pattern triggers retry.
  it("recognises 'must be root' as a permission error", async () => {
    const { fn, invocations } = makeQueuedSpawn([
      { exit: 1, stderr: "ERROR: you must be root to run this\n" },
      { exit: 0, stdout: "ok\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["dmesg"] },
      command: "dmesg",
      spawnFn: fn,
    });
    expect(invocations()).toBe(2);
    expect(result.escalated).toBe(true);
  });

  // 10. Multi-token commands: the verb is the FIRST whitespace-split token.
  it("matches the verb against the first whitespace-split token only", async () => {
    const { fn, invocations, seenCommands } = makeQueuedSpawn([
      { exit: 1, stderr: "Permission denied\n" },
      { exit: 0, stdout: "ok\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      // The verb is `journalctl`, not `-u`.
      target: { ...baseTarget, sudo_allowlist: ["journalctl"] },
      command: "journalctl -u nginx --since '5 min ago'",
      spawnFn: fn,
    });
    expect(invocations()).toBe(2);
    expect(seenCommands[1]).toBe(
      "sudo -n journalctl -u nginx --since '5 min ago'",
    );
    expect(result.escalated).toBe(true);
  });

  // 11. Permission-error pattern matching is case-insensitive.
  it("matches permission-error patterns case-insensitively", async () => {
    const { fn, invocations } = makeQueuedSpawn([
      { exit: 1, stderr: "PERMISSION DENIED\n" },
      { exit: 0, stdout: "ok\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["df"] },
      command: "df -h",
      spawnFn: fn,
    });
    expect(invocations()).toBe(2);
    expect(result.escalated).toBe(true);
  });
});

// ── Refused-by-tier-jump path ─────────────────────────────────
//
// The tier-reclassification gate is the load-bearing safety check in
// the ladder. The classifier strips ONE leading `sudo` / `sudo -n`,
// so when the agent passes a command that ALREADY starts with `sudo`,
// the ladder's `sudo -n <command>` prepend produces a doubled-sudo
// string whose strip resolves to `sudo <verb>` — and that doesn't
// match the anchored read/safe-write rule tables. Net effect: the
// bare command classifies at its natural (low) tier and the sudo'd
// retry would classify destructive (fail-closed default). The ladder
// must REFUSE this escalation and return requiresApproval=true.
describe("runSshCommandWithSudoFallback — tier-jump refusal", () => {
  it("refuses escalation when sudo'd command classifies HIGHER than the original", async () => {
    const { fn, invocations, seenCommands } = makeQueuedSpawn([
      // Unprivileged attempt fails with perm-denied stderr…
      { exit: 1, stderr: "Permission denied\n" },
      // …but the ladder must NOT reach this second step.
      { exit: 0, stdout: "should-not-run\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["sudo"] },
      // Bare `sudo systemctl status nginx` strips to
      // `systemctl status nginx` → read.
      // The ladder would retry as `sudo -n sudo systemctl status nginx`
      // which strips to `sudo systemctl status nginx` — that doesn't
      // match the anchored systemctl-read rule and falls through to
      // destructive (fail-closed). Tier jump read → destructive →
      // REFUSED.
      command: "sudo systemctl status nginx",
      spawnFn: fn,
    });

    expect(invocations()).toBe(1);
    expect(seenCommands).toEqual(["sudo systemctl status nginx"]);
    expect(result.requiresApproval).toBe(true);
    expect(result.escalated).toBe(false);
    expect(result.original_exit_code).toBe(1);
    // The returned SshExecResult is the unprivileged failure verbatim.
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("Permission denied");
  });

  it("DOES escalate when bare and sudo'd classifications are equal (normal allowlist verb path)", async () => {
    const { fn, invocations } = makeQueuedSpawn([
      { exit: 1, stderr: "Permission denied\n" },
      { exit: 0, stdout: "ok\n" },
    ]);
    const result = await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["systemctl"] },
      // Bare `systemctl restart nginx` → risky_write (matches systemctl-mutate).
      // `sudo -n systemctl restart nginx` strips to the same → risky_write.
      // Equal tiers → escalation allowed.
      command: "systemctl restart nginx",
      spawnFn: fn,
    });
    expect(invocations()).toBe(2);
    expect(result.escalated).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });
});

// ── Invocation hygiene ───────────────────────────────────────
describe("runSshCommandWithSudoFallback — invocation hygiene", () => {
  it("never invokes spawn a third time", async () => {
    const spawnFnInner = vi.fn(((_cmd: string, args: readonly string[]) => {
      const stdoutE = new EventEmitter();
      const stderrE = new EventEmitter();
      const procE = new EventEmitter();
      const proc = {
        stdout: stdoutE as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
        stderr: stderrE as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
        on: ((e: string, cb: (...a: unknown[]) => void) => procE.on(e, cb)) as SpawnedProcess["on"],
        kill: () => true,
      } satisfies SpawnedProcess;
      setImmediate(() => {
        const cmd = args[args.length - 1] as string;
        if (cmd.startsWith("sudo -n")) {
          stdoutE.emit("data", Buffer.from("ok\n"));
          procE.emit("close", 0);
        } else {
          stderrE.emit("data", Buffer.from("Permission denied\n"));
          procE.emit("close", 1);
        }
      });
      return proc;
    }) as SpawnFn);

    await runSshCommandWithSudoFallback({
      ...baseOpts,
      target: { ...baseTarget, sudo_allowlist: ["df"] },
      command: "df -h",
      spawnFn: spawnFnInner,
    });
    expect(spawnFnInner).toHaveBeenCalledTimes(2);
  });
});
