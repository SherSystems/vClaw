// ============================================================
// vClaw — SSH Adapter
//
// First-class shell-execution surface against a registry of named
// SSH targets. Every command flows through the safety classifier
// and (in production) the GovernanceEngine before being dispatched
// to the SSH client.
//
// Discriminator: "service" — this adapter does NOT own cluster state
// (no nodes, VMs, or storage). It's a utility surface, alongside
// system/migration/topology/provisioning.
// ============================================================

import type {
  AdapterKind,
  ClusterState,
  InfraAdapter,
  ToolCallResult,
  ToolDefinition,
} from "../types.js";
import type {
  SshAdapterOptions,
  SshClassification,
  SshExecResult,
  SshTarget,
} from "./types.js";
import type { SpawnFn } from "./client.js";
import { runRemoteCommand } from "./client.js";
import { classifyCommand } from "./safety.js";

// ── Governance hook ──────────────────────────────────────────
//
// The adapter is constructed with an optional `governanceEvaluator`.
// The real GovernanceEngine.evaluate() lives in src/governance/index.ts
// and depends on a PolicyConfig + AgentMode that the *agent* owns —
// not the adapter. To keep the adapter testable in isolation we
// inject a thin function that returns approval. In production this
// is wired up by the agent (see src/agent/executor.ts integration
// in a future iteration); for now the adapter still classifies and
// surfaces tier in the result so the executor's existing governance
// path picks it up (the executor calls the same classifyAction()).
//
// CRITICAL CONSTRAINT: even with the kill-switch on, destructive
// commands MUST still be approved per-call. The kill-switch only
// permits them to be PROPOSED at all.

export type SshGovernanceEvaluator = (
  classification: SshClassification,
  request: { target_id: string; command: string },
) => Promise<{ allowed: boolean; reason: string }>;

// ── Tool definitions ────────────────────────────────────────

const ADAPTER_NAME = "ssh";

function tool(
  name: string,
  description: string,
  tier: ToolDefinition["tier"],
  params: ToolDefinition["params"] = [],
  returns = "object",
): ToolDefinition {
  return { name, description, tier, adapter: ADAPTER_NAME, params, returns };
}

// We register the *base* tier of `ssh_exec` as `risky_write` so the
// agent's standard tool-list view conveys "this is not free". The
// runtime tier is decided per-call by the safety classifier and can
// elevate all the way to `destructive`.
const TOOL_DEFINITIONS: ToolDefinition[] = [
  tool(
    "ssh_exec",
    "Execute a shell command on a registered SSH target. The command is classified by the SSH safety classifier and run through governance. Read-only commands auto-approve under most modes; risky/destructive commands require human approval. Output is capped at the configured byte limit.",
    "risky_write",
    [
      { name: "target_id", type: "string", required: true, description: "Id of a registered SSH target (see ssh_list_targets)." },
      { name: "command", type: "string", required: true, description: "The exact shell command to run on the remote host. No shell metacharacters allowed for safe tiers." },
      { name: "timeout_s", type: "number", required: false, description: "Override the per-call timeout in seconds." },
    ],
    "SshExecResult",
  ),
  tool(
    "ssh_list_targets",
    "List all configured SSH targets with their (non-secret) connection details. Used by the agent to discover what hosts it can shell into.",
    "read",
    [],
    "SshTarget[]",
  ),
  tool(
    "ssh_dry_run",
    "Classify a shell command without executing it. Returns the inferred governance tier and the reason. Use this BEFORE ssh_exec so the agent can plan around the safety budget.",
    "read",
    [
      { name: "command", type: "string", required: true, description: "The command to classify." },
    ],
    "SshClassification",
  ),
];

// ── Adapter ──────────────────────────────────────────────────

export class SshAdapter implements InfraAdapter {
  readonly name = ADAPTER_NAME;
  readonly kind: AdapterKind = "service";

  private connected = false;
  private readonly targets: Map<string, SshTarget>;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutS: number;
  private readonly allowDestructive: boolean;
  private readonly strictHostKeyChecking: boolean;
  private readonly governanceEvaluator: SshGovernanceEvaluator | undefined;
  /** Test seam — let test inject a fake child_process.spawn. */
  private readonly spawnFn: SpawnFn | undefined;

  constructor(
    options: SshAdapterOptions,
    deps: {
      governanceEvaluator?: SshGovernanceEvaluator;
      spawnFn?: SpawnFn;
    } = {},
  ) {
    this.targets = new Map(options.targets.map((t) => [t.id, normalizeTarget(t)]));
    this.maxOutputBytes = options.max_output_bytes ?? 64 * 1024;
    this.defaultTimeoutS = options.default_timeout_s ?? 30;
    this.allowDestructive = options.allow_destructive ?? false;
    this.strictHostKeyChecking = options.strict_host_key_checking ?? true;
    this.governanceEvaluator = deps.governanceEvaluator;
    this.spawnFn = deps.spawnFn;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !k.startsWith("_")),
    );
    try {
      switch (toolName) {
        case "ssh_list_targets":
          return { success: true, data: this.listTargets() };
        case "ssh_dry_run":
          return this.dryRun(cleanParams);
        case "ssh_exec":
          return await this.execCommand(cleanParams);
        default:
          return { success: false, error: `Unknown SSH tool: ${toolName}` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Service adapter — no cluster state. */
  async getClusterState(): Promise<ClusterState> {
    return {
      adapter: ADAPTER_NAME,
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  // ── Tool implementations ──────────────────────────────────

  /**
   * Return targets stripped of any sensitive fields (identity_file).
   * Operators or the agent should never see filesystem paths to keys.
   */
  listTargets(): Array<Omit<SshTarget, "identity_file"> & { has_identity_file: boolean }> {
    return Array.from(this.targets.values()).map((t) => ({
      id: t.id,
      host: t.host,
      port: t.port,
      user: t.user,
      jump_host: t.jump_host,
      description: t.description,
      has_identity_file: !!t.identity_file,
    }));
  }

  private dryRun(params: Record<string, unknown>): ToolCallResult {
    const command = params.command as string | undefined;
    if (typeof command !== "string") {
      return { success: false, error: "command (string) is required" };
    }
    const classification = classifyCommand(command);
    return { success: true, data: classification };
  }

  private async execCommand(params: Record<string, unknown>): Promise<ToolCallResult> {
    const targetId = params.target_id as string | undefined;
    const command = params.command as string | undefined;
    const timeoutOverride = params.timeout_s as number | undefined;

    if (!targetId || typeof targetId !== "string") {
      return { success: false, error: "target_id (string) is required" };
    }
    if (!command || typeof command !== "string") {
      return { success: false, error: "command (string) is required" };
    }

    const target = this.targets.get(targetId);
    if (!target) {
      return {
        success: false,
        error: `Unknown SSH target: "${targetId}". Configured targets: ${this.listTargetIds().join(", ") || "(none)"}.`,
      };
    }

    // 1. Classify
    const classification = classifyCommand(command);

    // 2. Forbidden tier — never executes, no approval flow.
    if (classification.tier === "never") {
      return {
        success: false,
        error: `Command refused: ${classification.reason}`,
        data: { classification },
      };
    }

    // 3. Kill-switch for destructive — refuse outright unless enabled.
    if (classification.tier === "destructive" && !this.allowDestructive) {
      return {
        success: false,
        error:
          `Command classified as destructive (${classification.match}) ` +
          `and ssh.allow_destructive is false. Enable the kill-switch in config to allow ` +
          `destructive commands to be PROPOSED — they still require explicit per-call approval.`,
        data: { classification },
      };
    }

    // 4. Governance gate. If no evaluator was injected we trust the
    //    surrounding executor (which calls classifyAction on the tool
    //    metadata) — but we always surface the tier so audit logs are
    //    accurate.
    if (this.governanceEvaluator) {
      const decision = await this.governanceEvaluator(classification, {
        target_id: targetId,
        command,
      });
      if (!decision.allowed) {
        return {
          success: false,
          error: `Governance denied: ${decision.reason}`,
          data: { classification },
        };
      }
    }

    // 5. Execute via SSH client.
    const timeoutS = clampTimeout(timeoutOverride ?? this.defaultTimeoutS);
    const result = await runRemoteCommand({
      target,
      command,
      timeoutMs: timeoutS * 1000,
      maxOutputBytes: this.maxOutputBytes,
      strictHostKeyChecking: this.strictHostKeyChecking,
      spawnFn: this.spawnFn,
    });

    return {
      success: result.exit_code === 0,
      data: {
        ...result,
        classification,
        target_id: targetId,
      } satisfies SshExecResult & {
        classification: SshClassification;
        target_id: string;
      },
      error: result.exit_code !== 0
        ? `ssh_exec exit_code=${result.exit_code}${result.timed_out ? " (timed out)" : ""}`
        : undefined,
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  private listTargetIds(): string[] {
    return Array.from(this.targets.keys()).sort();
  }
}

function normalizeTarget(t: SshTarget): SshTarget {
  return {
    id: t.id,
    host: t.host,
    user: t.user,
    port: t.port,
    identity_file: t.identity_file,
    jump_host: t.jump_host,
    description: t.description,
  };
}

function clampTimeout(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 30;
  // Keep a hard ceiling so a runaway plan can't stall the executor.
  return Math.min(seconds, 600);
}
