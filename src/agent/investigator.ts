// ============================================================
// vClaw — Investigator
// Root cause analysis engine for infrastructure issues
// ============================================================

import { randomUUID } from "node:crypto";
import type {
  Investigation,
  InvestigationFinding,
  ProposedFix,
  ClusterState,
  AgentEvent,
  AuditEntry,
  PlanStep,
} from "../types.js";
import { callLLM, type AIConfig } from "./llm.js";
import { INVESTIGATOR_PROMPT } from "./prompts.js";

export interface InvestigationContext {
  clusterState: ClusterState | null;
  recentEvents: AgentEvent[];
  recentAudit: AuditEntry[];
  config: AIConfig;
}

interface LLMInvestigationResponse {
  root_cause: string;
  findings: Array<{
    source: string;
    detail: string;
    severity: "info" | "warning" | "critical";
  }>;
  proposed_fix?: {
    description: string;
    steps: Array<{
      id: string;
      action: string;
      params: Record<string, unknown>;
      description: string;
      depends_on: string[];
    }>;
    confidence: "low" | "medium" | "high";
  };
}

export class Investigator {
  /**
   * Perform root cause analysis for a given trigger (symptom description).
   */
  async investigate(
    trigger: string,
    context: InvestigationContext,
  ): Promise<Investigation> {
    const clusterSummary = context.clusterState
      ? JSON.stringify(context.clusterState, null, 2)
      : "No cluster state available.";

    const eventsSummary = context.recentEvents.length > 0
      ? context.recentEvents
          .map((e) => `[${e.timestamp}] ${e.type}: ${JSON.stringify(e.data)}`)
          .join("\n")
      : "No recent events.";

    const auditSummary = context.recentAudit.length > 0
      ? context.recentAudit
          .map(
            (a) =>
              `[${a.timestamp}] ${a.action} (${a.tier}): ${a.result}${a.error ? ` — ${a.error}` : ""}`,
          )
          .join("\n")
      : "No recent audit entries.";

    const systemPrompt = INVESTIGATOR_PROMPT({
      clusterStateSummary: clusterSummary,
      recentEvents: eventsSummary,
      recentAudit: auditSummary,
    });

    const userMessage = `Investigate the following issue:\n\n${trigger}`;

    const response = await callLLM({
      system: systemPrompt,
      user: userMessage,
      config: context.config,
    });

    const parsed = parseInvestigationResponse(response);

    const findings: InvestigationFinding[] = (parsed.findings || []).map(
      (f) => ({
        source: f.source,
        detail: f.detail,
        severity: f.severity,
      }),
    );

    let proposedFix: ProposedFix | undefined;
    if (parsed.proposed_fix) {
      const fixSteps: PlanStep[] = (parsed.proposed_fix.steps || []).map(
        (s, i) => ({
          id: s.id || `fix_${i + 1}`,
          action: s.action,
          params: s.params,
          description: s.description,
          depends_on: s.depends_on || [],
          status: "pending" as const,
          tier: "read" as const, // Will be re-evaluated by governance at execution time
        }),
      );

      proposedFix = {
        description: parsed.proposed_fix.description,
        steps: fixSteps,
        confidence: parsed.proposed_fix.confidence || "low",
        requires_approval: true, // Investigations always require approval for fixes
      };
    }

    return {
      id: randomUUID(),
      trigger,
      findings,
      root_cause: parsed.root_cause || "Unable to determine root cause",
      proposed_fix: proposedFix,
      timestamp: new Date().toISOString(),
    };
  }
}

function parseInvestigationResponse(raw: string): LLMInvestigationResponse {
  try {
    return JSON.parse(raw) as LLMInvestigationResponse;
  } catch {
    throw new Error(
      `Failed to parse investigation response as JSON: ${raw.slice(0, 500)}`,
    );
  }
}
