import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeChaos, fetchChaosHistory, fetchChaosStatus, simulateChaos } from "../../dashboard-v2/src/api/client";

function mockJsonResponse(body: unknown, ok = true, status = 200, statusText = "OK") {
  return {
    ok,
    status,
    statusText,
    json: vi.fn(async () => body),
  } as any;
}

describe("dashboard-v2 chaos API client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes simulate response from backend run shape", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockJsonResponse({
        id: "run-1",
        scenario: {
          id: "vm_kill",
          name: "Kill VM",
          description: "",
          severity: "high",
          target_type: "vm",
          requires_approval: true,
          reversible: false,
        },
        status: "pending",
        started_at: "2026-04-18T00:00:00.000Z",
        simulation: {
          blast_radius: {
            affected_vms: [
              { vmid: "101", name: "api-1", will_be_affected: true },
              { vmid: "102", name: "db-1", will_be_affected: false },
            ],
          },
          predicted_recovery_time_s: 95,
          risk_score: 72,
          recommendation: "Too risky",
        },
      }),
    );

    const simulation = await simulateChaos("vm_kill", { vmid: "101" });

    expect(simulation.scenario_id).toBe("vm_kill");
    expect(simulation.predicted_recovery_time_s).toBe(95);
    expect(simulation.risk_score).toBe(72);
    expect(simulation.affected_vms).toEqual([
      { vmid: "101", name: "api-1", impact: "direct" },
      { vmid: "102", name: "db-1", impact: "safe" },
    ]);
  });

  it("normalizes execute/status/history chaos run fields", async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(
        mockJsonResponse({
          id: "run-2",
          status: "completed",
          started_at: "2026-04-18T00:01:00.000Z",
          completed_at: "2026-04-18T00:02:00.000Z",
          scenario: {
            id: "random_vm_kill",
            name: "Random VM Kill",
            severity: "medium",
            target_type: "vm",
            requires_approval: false,
            reversible: true,
          },
          simulation: {
            blast_radius: { affected_vms: [] },
            predicted_recovery_time_s: 40,
            risk_score: 20,
            recommendation: "Safe",
          },
          actual: { recovery_time_s: 33 },
          score: { resilience_pct: 88, verdict: "pass" },
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse(null))
      .mockResolvedValueOnce(
        mockJsonResponse([
          {
            id: "run-3",
            status: "failed",
            started_at: "2026-04-18T00:03:00.000Z",
            scenario: {
              id: "vm_kill",
              name: "Kill VM",
              severity: "high",
              target_type: "vm",
              requires_approval: true,
              reversible: false,
            },
            simulation: {
              blast_radius: { affected_vms: [] },
              predicted_recovery_time_s: 55,
              risk_score: 77,
              recommendation: "High risk",
            },
            score: { resilience_pct: 11, verdict: "fail" },
          },
        ]),
      );

    const run = await executeChaos("random_vm_kill", {});
    const status = await fetchChaosStatus();
    const history = await fetchChaosHistory();

    expect(run.actual_recovery_time_s).toBe(33);
    expect(run.resilience_score).toBe(88);
    expect(run.verdict).toBe("pass");
    expect(run.blast_radius?.predicted_recovery_time_s).toBe(40);

    expect(status).toBeNull();

    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("run-3");
    expect(history[0].resilience_score).toBe(11);
    expect(history[0].verdict).toBe("fail");
  });
});
