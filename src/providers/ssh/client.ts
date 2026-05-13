// ============================================================
// RHODES — SSH Client
//
// Thin wrapper around the system `ssh` binary. We deliberately do NOT
// pull in an SSH library — rhodes already shells out via `spawn('ssh', ...)`
// in src/migration/vmware-importer.ts and src/index.ts, so we follow
// the same precedent.
//
// Responsibilities:
//   * Build the right argv from an SshTarget (port, identity_file,
//     jump_host, strict-host-key handling).
//   * Cap stdout+stderr at max_output_bytes (prevent runaway memory).
//   * Enforce a hard timeout via SIGKILL if SIGTERM is ignored.
//   * Capture exit code and duration.
//   * NEVER log credentials or identity-file paths. Argv that contains
//     them is constructed locally and not returned.
// ============================================================

import { spawn, type SpawnOptions } from "node:child_process";
import type {
  SshExecResult,
  SshExecWithEscalationResult,
  SshTarget,
} from "./types.js";
import { classifyCommand } from "./safety.js";
import type { ActionTier } from "../types.js";

export interface RunCommandOptions {
  target: SshTarget;
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
  strictHostKeyChecking: boolean;
  /**
   * Test seam — defaults to node:child_process spawn. Tests inject
   * a fake spawn that never touches the network.
   */
  spawnFn?: SpawnFn;
}

/** Subset of child_process.spawn we need. Lets us mock it cleanly. */
export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  options?: SpawnOptions,
) => SpawnedProcess;

export interface SpawnedProcess {
  stdout: NodeReadable | null;
  stderr: NodeReadable | null;
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface NodeReadable {
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

// Marker appended to truncated output so callers can see the cap fired.
const TRUNCATION_MARKER = "\n...[truncated by rhodes at max_output_bytes]";

/**
 * Build the argv to invoke ssh.
 *
 * IMPORTANT: identity_file values must NOT be logged anywhere — this
 * function is internal. Callers receiving the argv (e.g. tests) are
 * trusted; production code never persists it.
 */
export function buildSshArgs(
  target: SshTarget,
  command: string,
  timeoutSeconds: number,
  strictHostKeyChecking: boolean,
): string[] {
  const args: string[] = [];

  // Strict-host-key handling — match the convention used elsewhere
  // in rhodes (StrictHostKeyChecking + UserKnownHostsFile=/dev/null
  // when relaxed).
  if (strictHostKeyChecking) {
    args.push("-o", "StrictHostKeyChecking=yes");
  } else {
    args.push("-o", "StrictHostKeyChecking=no");
    args.push("-o", "UserKnownHostsFile=/dev/null");
  }

  args.push("-o", "BatchMode=yes"); // never prompt for password
  args.push("-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutSeconds))}`);
  args.push("-o", "LogLevel=ERROR");

  if (target.port && target.port !== 22) {
    args.push("-p", String(target.port));
  }
  if (target.identity_file) {
    args.push("-i", target.identity_file);
    args.push("-o", "IdentitiesOnly=yes");
  }
  if (target.jump_host) {
    args.push("-J", target.jump_host);
  }

  args.push(`${target.user}@${target.host}`);
  args.push(command);

  return args;
}

/**
 * Execute `command` on `target` and return a structured result.
 *
 * The promise NEVER rejects — protocol-level failures (host unreachable,
 * spawn error) are surfaced via exit_code !== 0 and stderr. This keeps
 * callers (tools, agents) on a single happy path.
 */
export async function runRemoteCommand(opts: RunCommandOptions): Promise<SshExecResult> {
  const {
    target,
    command,
    timeoutMs,
    maxOutputBytes,
    strictHostKeyChecking,
    spawnFn = spawn as unknown as SpawnFn,
  } = opts;

  const args = buildSshArgs(target, command, Math.ceil(timeoutMs / 1000), strictHostKeyChecking);

  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let truncatedStdout = false;
  let truncatedStderr = false;
  let timedOut = false;

  return new Promise<SshExecResult>((resolve) => {
    let proc: SpawnedProcess;
    try {
      proc = spawnFn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        exit_code: 127,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        truncated: false,
        timed_out: false,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    let settled = false;
    const settle = (result: SshExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(softKill);
      clearTimeout(hardKill);
      resolve(result);
    };

    const softKill = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
    }, timeoutMs);

    // Belt-and-braces: if SIGTERM is ignored, SIGKILL after a grace.
    const hardKill = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
    }, timeoutMs + 2000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (truncatedStdout) return;
      const remaining = maxOutputBytes - stdout.length;
      if (chunk.length <= remaining) {
        stdout += chunk.toString("utf8");
      } else {
        stdout += chunk.slice(0, remaining).toString("utf8") + TRUNCATION_MARKER;
        truncatedStdout = true;
        try { proc.kill("SIGTERM"); } catch { /* noop */ }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (truncatedStderr) return;
      const remaining = maxOutputBytes - stderr.length;
      if (chunk.length <= remaining) {
        stderr += chunk.toString("utf8");
      } else {
        stderr += chunk.slice(0, remaining).toString("utf8") + TRUNCATION_MARKER;
        truncatedStderr = true;
      }
    });

    proc.on("error", (err) => {
      settle({
        exit_code: 127,
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + err.message,
        truncated: truncatedStdout || truncatedStderr,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
      });
    });

    proc.on("close", (code) => {
      const exitCode = timedOut ? 124 : code ?? 1;
      settle({
        exit_code: exitCode,
        stdout,
        stderr,
        truncated: truncatedStdout || truncatedStderr,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Alias for {@link runRemoteCommand}. The sudo-fallback ladder calls
 * `runSshCommand(opts)` for both the unprivileged attempt and the
 * `sudo -n` retry; the historical name `runRemoteCommand` is kept as
 * the canonical export to avoid churning every existing call site.
 */
export const runSshCommand = runRemoteCommand;

// ============================================================
// Sudo-fallback ladder
// ============================================================
//
// Some operations want to run unprivileged first and only escalate to
// `sudo -n <command>` if the unprivileged attempt fails with a
// permission error AND the target has been explicitly opted into
// NOPASSWD execution for that verb.
//
// This is two-layer fail-closed:
//   1. The retry is ONLY attempted when stderr matches a known
//      permission-denied signature. Anything else (the command really
//      doesn't exist, the binary segfaulted, etc.) is returned as-is.
//   2. The retry is ONLY attempted when the FIRST verb of the command
//      (post-trim, post-split) is in `target.sudo_allowlist`. No
//      allowlist → no escalation, ever.
//
// Additionally, the sudo'd version of the command is re-classified
// through `classifyCommand`. If the classification jumps to a higher
// tier than the original (e.g. a verb that looked safe becomes
// dangerous when prefixed with `sudo`), the ladder REFUSES the
// escalation and returns `requiresApproval: true`. The caller already
// passed governance on the lower tier — the ladder must not silently
// promote the action.

/**
 * Patterns we treat as "this failed because we lack privilege" — and
 * therefore as a signal to (maybe) retry with sudo. Conservative on
 * purpose: anything not matching one of these stays as a plain failure.
 *
 * Cases (case-insensitive):
 *   - generic POSIX "permission denied"
 *   - "operation not permitted" (EPERM, e.g. unmount as non-root)
 *   - "must be root" / "must be run as root" / "are you root?"
 *   - "sudo: a password is required" (sudo not configured NOPASSWD)
 *   - "are you root?" (some daemons)
 */
const PERMISSION_ERROR_PATTERNS: readonly RegExp[] = [
  /permission denied/i,
  /operation not permitted/i,
  /must be (run as )?root/i,
  /are you root\??/i,
  /sudo: a password is required/i,
  /requires? (root|superuser) privilege/i,
];

function looksLikePermissionError(stderr: string): boolean {
  if (!stderr) return false;
  for (const re of PERMISSION_ERROR_PATTERNS) {
    if (re.test(stderr)) return true;
  }
  return false;
}

/**
 * Extract the first whitespace-separated token of a trimmed command.
 * Used to match against `sudo_allowlist`.
 */
function firstVerb(command: string): string {
  const trimmed = (command ?? "").trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0]!;
}

/**
 * Rank an ActionTier on a low-to-high risk scale. Kept local to avoid
 * importing the safety-internal table.
 */
const TIER_RANK: Record<ActionTier, number> = {
  read: 0,
  safe_write: 1,
  risky_write: 2,
  destructive: 3,
  never: 99,
};

/**
 * Execute a command via SSH, falling back to `sudo -n <command>` when
 * the unprivileged attempt fails with a permission error AND the verb
 * is in the target's `sudo_allowlist`.
 *
 * See {@link SshExecWithEscalationResult} for the contract.
 *
 * The promise NEVER rejects: protocol failures are surfaced as
 * non-zero exit codes on the wrapped exec result.
 */
export async function runSshCommandWithSudoFallback(
  opts: RunCommandOptions,
): Promise<SshExecWithEscalationResult> {
  // 1. Always run the unprivileged attempt first.
  const first = await runSshCommand(opts);

  // Happy path — succeeded without sudo.
  if (first.exit_code === 0) {
    return { ...first, escalated: false, requiresApproval: false };
  }

  // 2. Did it fail in a way that smells like a privilege problem?
  if (!looksLikePermissionError(first.stderr)) {
    return { ...first, escalated: false, requiresApproval: false };
  }

  // 3. Is the verb opted in?
  const allowlist = opts.target.sudo_allowlist ?? [];
  const verb = firstVerb(opts.command);
  if (!verb || !allowlist.includes(verb)) {
    // No allowlist entry — return the original failure untouched.
    // Caller sees the perm-denied stderr and can surface it.
    return { ...first, escalated: false, requiresApproval: false };
  }

  // 4. Re-classify the sudo-prefixed command. If it jumps tier, refuse
  //    the escalation — the caller's governance approval was for the
  //    lower tier only.
  const sudoCommand = `sudo -n ${opts.command.trim()}`;
  const baseClassification = classifyCommand(opts.command);
  const sudoClassification = classifyCommand(sudoCommand);
  if (TIER_RANK[sudoClassification.tier] > TIER_RANK[baseClassification.tier]) {
    return {
      ...first,
      escalated: false,
      requiresApproval: true,
      original_exit_code: first.exit_code,
    };
  }

  // 5. Retry with sudo -n. Use the same opts but swap the command.
  const second = await runSshCommand({ ...opts, command: sudoCommand });
  return {
    ...second,
    escalated: true,
    original_exit_code: first.exit_code,
    requiresApproval: false,
  };
}
