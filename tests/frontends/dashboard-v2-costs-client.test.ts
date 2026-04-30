import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCostSummary,
  fetchCostTimeseries,
  fetchCostTopResources,
} from "../../dashboard-v2/src/api/client";

function mockJsonResponse(body: unknown, ok = true, status = 200, statusText = "OK") {
  return {
    ok,
    status,
    statusText,
    json: vi.fn(async () => body),
  } as any;
}

describe("dashboard-v2 costs API client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes summary payload and filters on-prem providers in cloud mode", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockJsonResponse({
        providers: [
          { provider: "AWS", monthly_cost_usd: 420.11 },
          { provider: "Azure", monthlyCostUsd: 180.55 },
          { provider: "Proxmox", monthlyCostUsd: 94.02 },
        ],
      }),
    );

    const summary = await fetchCostSummary("cloud");

    expect(summary).toEqual([
      expect.objectContaining({ provider: "AWS", monthlyCostUsd: 420.11 }),
      expect.objectContaining({ provider: "Azure", monthlyCostUsd: 180.55 }),
    ]);
  });

  it("normalizes date-bucket timeseries shape into provider points", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockJsonResponse([
        { date: "2026-04-01", aws: 11.25, azure: 7.5, proxmox: 2.2 },
        { date: "2026-04-02", aws: 12.5, azure: 8.4, proxmox: 2.7 },
      ]),
    );

    const points = await fetchCostTimeseries("hybrid");

    expect(points).toContainEqual({ date: "2026-04-01", provider: "aws", costUsd: 11.25 });
    expect(points).toContainEqual({ date: "2026-04-02", provider: "azure", costUsd: 8.4 });
    expect(points).toContainEqual({ date: "2026-04-02", provider: "proxmox", costUsd: 2.7 });
  });

  it("normalizes top resources and applies cloud mode filtering", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      mockJsonResponse({
        items: [
          { id: "i-1", name: "api-prod-1", provider: "aws", type: "ec2", monthly_cost_usd: 85.3 },
          { id: "vm-100", name: "onprem-app", provider: "vmware", type: "vm", monthly_cost_usd: 40.1 },
        ],
      }),
    );

    const resources = await fetchCostTopResources("cloud", 10);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toEqual(
      expect.objectContaining({
        id: "i-1",
        name: "api-prod-1",
        provider: "aws",
        resourceType: "ec2",
        monthlyCostUsd: 85.3,
      }),
    );
  });
});
