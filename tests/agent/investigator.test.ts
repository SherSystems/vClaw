import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentEventType } from "../../src/types.js";

const { callLLMMock } = vi.hoisted(() => ({
  callLLMMock: vi.fn(),
}));

vi.mock("../../src/agent/llm.js", () => ({
  callLLM: callLLMMock,
}));

import { Investigator, type InvestigationContext } from "../../src/agent/investigator.js";

function makeContext(
  overrides: Partial<InvestigationContext> = {},
): InvestigationContext {
  return {
    clusterState: null,
    recentEvents: [],
    recentAudit: [],
    config: {
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-test",
    },
    ...overrides,
  };
}

describe("Investigator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds investigation output with mapped findings and proposed fix steps", async () => {
    callLLMMock.mockResolvedValueOnce(
      JSON.stringify({
        root_cause: "Single-node storage controller reset",
        findings: [
          {
            source: "events",
            detail: "Repeated I/O timeout alerts on pve1",
            severity: "critical",
          },
        ],
        proposed_fix: {
          description: "Fail over workloads and restart storage services",
          steps: [
            {
              id: "",
              action: "migrate_vm",
              params: { vmid: 101, node: "pve2" },
              description: "Move impacted VM away from node",
            },
            {
              id: "custom_fix_step",
              action: "restart_service",
              params: { node: "pve1", service: "pvestatd" },
              description: "Restart storage stat service",
              depends_on: ["fix_1"],
            },
          ],
          confidence: "high",
        },
      }),
    );

    const investigator = new Investigator();
    const context = makeContext({
      clusterState: {
        adapter: "proxmox",
        nodes: [{ node: "pve1", status: "online" }],
        vms: [],
        containers: [],
        storage: [],
        timestamp: "2026-03-31T00:00:00.000Z",
      } as any,
      recentEvents: [
        {
          type: AgentEventType.StepFailed,
          timestamp: "2026-03-31T00:00:10.000Z",
          data: { step: "check_storage", error: "timeout" },
        } as any,
      ],
      recentAudit: [
        {
          id: "a1",
          timestamp: "2026-03-31T00:00:20.000Z",
          action: "check_storage",
          tier: "read",
          reasoning: "verify health",
          params: {},
          result: "failed",
          error: "deadline exceeded",
          duration_ms: 1200,
        } as any,
      ],
    });

    const result = await investigator.investigate("VM unreachable", context);

    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const llmArgs = callLLMMock.mock.calls[0][0];
    expect(llmArgs.user).toContain("VM unreachable");
    expect(llmArgs.system).toContain("pve1");
    expect(llmArgs.system).toContain("step_failed");
    expect(llmArgs.system).toContain("deadline exceeded");

    expect(result.id).toMatch(/[0-9a-f-]{36}/);
    expect(result.root_cause).toBe("Single-node storage controller reset");
    expect(result.findings).toEqual([
      {
        source: "events",
        detail: "Repeated I/O timeout alerts on pve1",
        severity: "critical",
      },
    ]);
    expect(result.proposed_fix).toEqual({
      description: "Fail over workloads and restart storage services",
      steps: [
        {
          id: "fix_1",
          action: "migrate_vm",
          params: { vmid: 101, node: "pve2" },
          description: "Move impacted VM away from node",
          depends_on: [],
          status: "pending",
          tier: "read",
        },
        {
          id: "custom_fix_step",
          action: "restart_service",
          params: { node: "pve1", service: "pvestatd" },
          description: "Restart storage stat service",
          depends_on: ["fix_1"],
          status: "pending",
          tier: "read",
        },
      ],
      confidence: "high",
      requires_approval: true,
    });
  });

  it("uses fallback summaries and root cause when LLM omits optional fields", async () => {
    callLLMMock.mockResolvedValueOnce(JSON.stringify({ root_cause: "" }));

    const investigator = new Investigator();
    const result = await investigator.investigate(
      "Intermittent API slowness",
      makeContext(),
    );

    const llmArgs = callLLMMock.mock.calls[0][0];
    expect(llmArgs.system).toContain("No cluster state available.");
    expect(llmArgs.system).toContain("No recent events.");
    expect(llmArgs.system).toContain("No recent audit entries.");

    expect(result.findings).toEqual([]);
    expect(result.proposed_fix).toBeUndefined();
    expect(result.root_cause).toBe("Unable to determine root cause");
  });

  it("throws a parse error when LLM response is not valid JSON", async () => {
    callLLMMock.mockResolvedValueOnce("not-json-response");

    const investigator = new Investigator();

    await expect(
      investigator.investigate("Node unreachable", makeContext()),
    ).rejects.toThrow(
      "Failed to parse investigation response as JSON: not-json-response",
    );
  });
});
