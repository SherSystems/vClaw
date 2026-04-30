// ============================================================
// vClaw — SSH Adapter Types
// First-class shell-execution surface against registered SSH targets.
// ============================================================

import type { ActionTier } from "../types.js";

/**
 * A registered SSH target. Targets are configured up front (via env or
 * config file) and addressed by stable id thereafter — tools never take
 * raw host strings, only target ids. This gives operators a single
 * inventory surface and prevents the agent from SSH'ing to arbitrary
 * hosts at will.
 */
export interface SshTarget {
  /** Stable identifier used by tools (e.g. "pve-01", "esxi-lab"). */
  id: string;
  /** Hostname or IP. */
  host: string;
  /** Optional port (defaults to 22). */
  port?: number;
  /** SSH user. */
  user: string;
  /**
   * Optional path to private key. Never logged. If unset, falls back
   * to the system ssh-agent / ~/.ssh defaults.
   */
  identity_file?: string;
  /**
   * Optional jump host (`-J user@host`). Useful for reaching ESXi /
   * Proxmox boxes that aren't directly reachable from the agent host.
   */
  jump_host?: string;
  /** Free-form description shown to operators in approval prompts. */
  description?: string;
}

export interface SshExecRequest {
  /** Id of a registered target. */
  target_id: string;
  /** Shell command to execute. */
  command: string;
  /** Override the default timeout (seconds). */
  timeout_s?: number;
}

export interface SshExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  /** True if either stdout or stderr was truncated at max_output_bytes. */
  truncated: boolean;
  duration_ms: number;
  /** Whether the command was killed by the timeout. */
  timed_out: boolean;
}

/** Result of classifying a command without executing it. */
export interface SshClassification {
  tier: ActionTier;
  /** Human-readable reason matching the chosen tier. */
  reason: string;
  /**
   * Optional tag identifying which heuristic fired
   * (used by tests, logged for audit).
   */
  match?: string;
}

export interface SshAdapterOptions {
  targets: SshTarget[];
  /** Cap on total stdout+stderr captured. Defaults to 64 KiB. */
  max_output_bytes?: number;
  /** Per-call timeout default in seconds. Defaults to 30. */
  default_timeout_s?: number;
  /**
   * Global kill-switch. When false, destructive-tier commands are
   * refused outright and never even forwarded to governance for
   * approval. Defaults to false (fail closed).
   */
  allow_destructive?: boolean;
  /**
   * Strict host-key checking. Defaults to true. If false, falls back
   * to UserKnownHostsFile=/dev/null (homelab convenience only).
   */
  strict_host_key_checking?: boolean;
}
