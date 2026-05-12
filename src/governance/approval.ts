// ============================================================
// Approval Gate — Controls what actions require human sign-off
// ============================================================

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type {
  ActionTier,
  AgentMode,
  ApprovalRequest,
  ApprovalResponse,
  PolicyConfig,
} from "../types.js";

// ── Approval Matrix ─────────────────────────────────────────
// Maps (ApprovalMode × ActionTier) → needs approval?

type ApprovalMode = PolicyConfig["approval"]["build_mode"];

/**
 * Tiers that require approval under each approval mode.
 * "read" is always auto-approved regardless of mode.
 */
const APPROVAL_MATRIX: Record<ApprovalMode, Set<ActionTier>> = {
  approve_all: new Set(["safe_write", "risky_write", "destructive"]),
  approve_plan: new Set(["safe_write", "risky_write", "destructive"]),
  approve_risky: new Set(["risky_write", "destructive"]),
  auto: new Set(["destructive"]),
};

// ── External Approval Handler ───────────────────────────────

export type ExternalApprovalHandler = (
  request: ApprovalRequest,
) => Promise<boolean>;

export type PlanApprovalHandler = (
  planId: string,
  goal: string,
  steps: { id: string; action: string; description: string; tier: string }[],
  reasoning: string,
) => Promise<boolean>;

/**
 * Listener invoked when the gate begins waiting on a human decision.
 * The dashboard subscribes to this to emit `AwaitingApproval` events
 * and to surface the request in /api/agent/pending-approvals.
 */
export type AwaitingApprovalListener = (entry: PendingApprovalEntry) => void;

export interface PendingApprovalEntry {
  plan_id: string;
  request_id: string;
  action: string;
  tier: ActionTier;
  params: Record<string, unknown>;
  reasoning: string;
  requested_at: string;
  /** When true, this is a plan-level approval (covers all steps).
   *  When false/undefined, this is a per-step approval gate. */
  scope: "plan" | "step";
}

export interface ApprovalDecisionRecord {
  plan_id: string;
  decision: "approve" | "reject";
  operator: string;
  timestamp: string;
}

// ── ApprovalGate Class ──────────────────────────────────────

export class ApprovalGate {
  private externalHandler: ExternalApprovalHandler | null = null;
  private planApprovalHandler: PlanApprovalHandler | null = null;
  /** Plan IDs that have been approved at plan-level — steps skip individual approval */
  private approvedPlans: Set<string> = new Set();

  // ── API-driven approval plumbing ───────────────────────────
  /** Pending approval gates keyed by plan_id, awaiting an API decision. */
  private pendingResolvers: Map<
    string,
    { entry: PendingApprovalEntry; resolve: (approved: boolean) => void }
  > = new Map();
  /** Latest decision per plan_id, used for idempotent re-approval and history. */
  private decisions: Map<string, ApprovalDecisionRecord> = new Map();
  /** Listeners notified whenever an approval becomes pending. */
  private awaitingListeners: Set<AwaitingApprovalListener> = new Set();

  /**
   * Set an external approval handler (e.g., the CLI's readline).
   * When set, approvals are routed through this handler instead of
   * creating a separate readline instance.
   */
  setExternalHandler(handler: ExternalApprovalHandler): void {
    this.externalHandler = handler;
  }

  clearExternalHandler(): void {
    this.externalHandler = null;
  }

  /**
   * Set a plan-level approval handler (e.g., Dashboard shows full plan).
   * When a plan is approved at plan-level, individual steps skip approval.
   */
  setPlanApprovalHandler(handler: PlanApprovalHandler): void {
    this.planApprovalHandler = handler;
  }

  /**
   * Subscribe to AwaitingApproval notifications. Used by the dashboard
   * to emit SSE events and seed /api/agent/pending-approvals.
   */
  onAwaitingApproval(listener: AwaitingApprovalListener): () => void {
    this.awaitingListeners.add(listener);
    return () => this.awaitingListeners.delete(listener);
  }

  /**
   * Snapshot of every approval gate currently blocking execution.
   */
  getPendingApprovals(): PendingApprovalEntry[] {
    return Array.from(this.pendingResolvers.values()).map((p) => p.entry);
  }

  /**
   * API-side hook: register an operator decision for a plan that is
   * currently blocked at an approval gate. Returns the prior decision
   * for idempotency, or `null` if no matching pending plan exists.
   */
  submitApiDecision(
    planId: string,
    decision: "approve" | "reject",
    operator: string,
  ): { ok: true; resolved: boolean; record: ApprovalDecisionRecord } | { ok: false; reason: "unknown_plan" } {
    const existing = this.decisions.get(planId);
    const pending = this.pendingResolvers.get(planId);

    // Idempotency: if a decision was already recorded and matches, keep it.
    if (existing && !pending) {
      return { ok: true, resolved: false, record: existing };
    }

    if (!pending && !existing) {
      return { ok: false, reason: "unknown_plan" };
    }

    const record: ApprovalDecisionRecord = {
      plan_id: planId,
      decision,
      operator,
      timestamp: new Date().toISOString(),
    };
    this.decisions.set(planId, record);

    if (pending) {
      this.pendingResolvers.delete(planId);
      pending.resolve(decision === "approve");
    }

    return { ok: true, resolved: pending !== undefined, record };
  }

  /**
   * Request plan-level approval. Returns true if approved.
   * Flow:
   *   1. If a plan-level handler (e.g. CLI) is set, ask it.
   *   2. Otherwise, register the request in the pending queue and wait
   *      for either an API decision (POST /api/agent/approve) or a
   *      pre-existing decision to resolve us.
   *   3. With no handler and no API consumer, auto-approve so unit
   *      tests and library use stay backwards-compatible.
   */
  async requestPlanApproval(
    planId: string,
    goal: string,
    steps: { id: string; action: string; description: string; tier: string }[],
    reasoning: string,
  ): Promise<boolean> {
    if (this.planApprovalHandler) {
      const approved = await this.planApprovalHandler(planId, goal, steps, reasoning);
      if (approved) {
        this.approvedPlans.add(planId);
      }
      return approved;
    }

    // No CLI handler — try the API path if anyone is listening.
    if (this.awaitingListeners.size > 0) {
      // Pre-existing decision (e.g., an operator pre-approved before
      // the planner enqueued the gate): honour it immediately.
      const prior = this.decisions.get(planId);
      if (prior) {
        const approved = prior.decision === "approve";
        if (approved) this.approvedPlans.add(planId);
        return approved;
      }

      const entry: PendingApprovalEntry = {
        plan_id: planId,
        request_id: `plan:${planId}`,
        action: "plan_approval",
        tier: "destructive",
        params: { goal, steps },
        reasoning,
        requested_at: new Date().toISOString(),
        scope: "plan",
      };

      const approved = await new Promise<boolean>((resolve) => {
        this.pendingResolvers.set(planId, { entry, resolve });
        this.emitAwaiting(entry);
      });

      if (approved) this.approvedPlans.add(planId);
      return approved;
    }

    // No handler, no API listener — auto-approve (backwards compatible).
    this.approvedPlans.add(planId);
    return true;
  }

  /**
   * Check if a plan was already approved at plan-level.
   */
  isPlanApproved(planId: string): boolean {
    return this.approvedPlans.has(planId);
  }
  requiresExplicitApproval(
    tier: ActionTier,
    policy: PolicyConfig,
  ): boolean {
    if (tier === "never") return false;
    return policy.orchestration.approval.explicit_tiers.includes(tier);
  }

  /**
   * Determine whether an action at a given tier needs human approval
   * under the current agent mode and policy.
   */
  needsApproval(
    tier: ActionTier,
    mode: AgentMode,
    policy: PolicyConfig,
  ): boolean {
    // Read actions never need approval
    if (tier === "read") return false;

    // "never" tier actions are always blocked — not approvable
    if (tier === "never") return false;

    if (this.requiresExplicitApproval(tier, policy)) {
      return true;
    }

    const approvalMode = this.getApprovalMode(mode, policy);
    return APPROVAL_MATRIX[approvalMode]?.has(tier) ?? true;
  }

  /**
   * Request human approval via CLI prompt.
   * Returns an ApprovalResponse with the user's decision.
   */
  async requestApproval(
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> {
    const tierLabel = this.formatTier(request.tier);

    // Print the approval box to stderr
    console.error("\n┌─────────────────────────────────────────────");
    console.error("│ APPROVAL REQUIRED");
    console.error("├─────────────────────────────────────────────");
    console.error(`│ Action:    ${request.action}`);
    console.error(`│ Tier:      ${tierLabel}`);
    console.error(`│ Reasoning: ${request.reasoning}`);
    if (request.plan_id) {
      console.error(`│ Plan:      ${request.plan_id}`);
    }
    console.error(`│ Params:    ${JSON.stringify(request.params, null, 2).replace(/\n/g, "\n│            ")}`);
    console.error("└─────────────────────────────────────────────");

    // If an external handler is set (e.g. CLI REPL), use it
    if (this.externalHandler) {
      const approved = await this.externalHandler(request);
      return {
        request_id: request.id,
        approved,
        approved_by: approved ? "cli_user" : undefined,
        method: "cli",
        timestamp: new Date().toISOString(),
      };
    }

    // API path — only valid when a plan_id binds the request to a known
    // operator queue. The dashboard / any subscriber gets notified via
    // AwaitingApproval, and submitApiDecision() resolves the promise.
    if (request.plan_id && this.awaitingListeners.size > 0) {
      const planId = request.plan_id;
      const prior = this.decisions.get(planId);
      const approved = await (prior
        ? Promise.resolve(prior.decision === "approve")
        : new Promise<boolean>((resolve) => {
            const entry: PendingApprovalEntry = {
              plan_id: planId,
              request_id: request.id,
              action: request.action,
              tier: request.tier,
              params: request.params,
              reasoning: request.reasoning,
              requested_at: request.timestamp,
              scope: "step",
            };
            this.pendingResolvers.set(planId, { entry, resolve });
            this.emitAwaiting(entry);
          }));

      const operator = this.decisions.get(planId)?.operator;
      return {
        request_id: request.id,
        approved,
        approved_by: approved ? operator ?? "api_operator" : undefined,
        method: "dashboard",
        timestamp: new Date().toISOString(),
      };
    }

    // Fallback: own readline (for non-REPL contexts like one-shot mode).
    // Under systemd this blocks forever because stdin is /dev/null — that's
    // the historic v0.4.1 bug. Operators running RHODES as a daemon should
    // wire an awaitingApproval listener so the API path is used instead.
    if (!process.stdin.isTTY) {
      console.error(
        "[approval] stdin is not a TTY and no API listener is registered — auto-rejecting to avoid deadlock",
      );
      return {
        request_id: request.id,
        approved: false,
        method: "auto",
        timestamp: new Date().toISOString(),
      };
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question("\n  Approve? [y/N] ", (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });

    const approved = answer === "y" || answer === "yes";

    return {
      request_id: request.id,
      approved,
      approved_by: approved ? "cli_user" : undefined,
      method: "cli",
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private Helpers ─────────────────────────────────────────

  private emitAwaiting(entry: PendingApprovalEntry): void {
    for (const listener of this.awaitingListeners) {
      try {
        listener(entry);
      } catch (err) {
        console.error("[approval] awaiting listener threw:", err);
      }
    }
  }

  /**
   * Create a pre-approved auto-response (for auto-approved tiers).
   */
  autoApprove(requestId: string): ApprovalResponse {
    return {
      request_id: requestId,
      approved: true,
      approved_by: "system",
      method: "auto",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a rejection response for blocked actions.
   */
  reject(requestId: string, reason: string): ApprovalResponse {
    return {
      request_id: requestId,
      approved: false,
      method: "auto",
      timestamp: new Date().toISOString(),
    };
  }

  private getApprovalMode(mode: AgentMode, policy: PolicyConfig): ApprovalMode {
    switch (mode) {
      case "build":
        return policy.approval.build_mode;
      case "watch":
        return policy.approval.watch_mode;
      case "investigate":
        return policy.approval.investigate_mode;
      default:
        return "approve_all"; // Safest default
    }
  }

  private formatTier(tier: ActionTier): string {
    switch (tier) {
      case "read":
        return "READ (safe)";
      case "safe_write":
        return "SAFE WRITE";
      case "risky_write":
        return "RISKY WRITE ⚠";
      case "destructive":
        return "DESTRUCTIVE ✘";
      case "never":
        return "FORBIDDEN ✘✘";
      default:
        return tier;
    }
  }
}
