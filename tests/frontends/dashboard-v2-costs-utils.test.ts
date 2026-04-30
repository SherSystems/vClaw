import { describe, expect, it } from "vitest";
import { buildStackedCostSeries, sortCostResourcesByMonthlyCost } from "../../dashboard-v2/src/lib/costs";
import type { CostTimeseriesPoint, CostTopResource } from "../../dashboard-v2/src/types";

describe("dashboard-v2 costs view-model helpers", () => {
  it("builds stacked layers and totals for 30-day chart", () => {
    const points: CostTimeseriesPoint[] = [
      { date: "2026-04-01", provider: "aws", costUsd: 10 },
      { date: "2026-04-01", provider: "azure", costUsd: 4 },
      { date: "2026-04-02", provider: "aws", costUsd: 8 },
      { date: "2026-04-02", provider: "azure", costUsd: 5 },
    ];

    const stacked = buildStackedCostSeries(points, 30);

    expect(stacked.dates).toEqual(["2026-04-01", "2026-04-02"]);
    expect(stacked.providers).toEqual(["aws", "azure"]);
    expect(stacked.totals).toEqual([14, 13]);
    expect(stacked.layers.aws[0]).toEqual({
      date: "2026-04-01",
      y0: 0,
      y1: 10,
      value: 10,
    });
    expect(stacked.layers.azure[0]).toEqual({
      date: "2026-04-01",
      y0: 10,
      y1: 14,
      value: 4,
    });
  });

  it("sorts top resources by monthly cost in both directions", () => {
    const resources: CostTopResource[] = [
      { id: "1", name: "api", provider: "aws", resourceType: "ec2", monthlyCostUsd: 50 },
      { id: "2", name: "db", provider: "azure", resourceType: "vm", monthlyCostUsd: 80 },
      { id: "3", name: "cache", provider: "aws", resourceType: "ec2", monthlyCostUsd: 20 },
    ];

    const descending = sortCostResourcesByMonthlyCost(resources, "desc");
    const ascending = sortCostResourcesByMonthlyCost(resources, "asc");

    expect(descending.map((r) => r.id)).toEqual(["2", "1", "3"]);
    expect(ascending.map((r) => r.id)).toEqual(["3", "1", "2"]);
  });
});
