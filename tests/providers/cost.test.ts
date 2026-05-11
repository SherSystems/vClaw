import { describe, it, expect } from "vitest";
import { CostAdapter } from "../../src/providers/cost/adapter.js";
import {
  pickInstance,
  estimateMonthly,
  estimateOneTimeMigration,
  AWS_INSTANCES,
  AZURE_INSTANCES,
} from "../../src/providers/cost/pricing.js";

describe("pricing.pickInstance", () => {
  it("picks the smallest fitting AWS instance for a small workload", () => {
    const inst = pickInstance("aws", 2, 4, 50);
    expect(inst).not.toBeNull();
    expect(inst!.vcpu).toBeGreaterThanOrEqual(2);
    expect(inst!.ram_gb).toBeGreaterThanOrEqual(4);
    // Should be the cheapest option that fits — t3.medium at ~$30
    expect(inst!.name).toBe("t3.medium");
  });

  it("picks an Azure instance for a medium workload", () => {
    const inst = pickInstance("azure", 4, 16, 200);
    expect(inst).not.toBeNull();
    expect(inst!.vcpu).toBeGreaterThanOrEqual(4);
    expect(inst!.ram_gb).toBeGreaterThanOrEqual(16);
  });

  it("respects family preference when feasible", () => {
    const inst = pickInstance("aws", 2, 8, "m5");
    expect(inst).not.toBeNull();
    expect(inst!.family).toBe("m5");
  });

  it("falls back to any family when preferred doesn't fit", () => {
    // Ask for r5 family but with a workload too large for any r5 in catalog
    const inst = pickInstance("aws", 64, 256, "r5");
    // Still returns something if anything fits — or null if nothing does
    if (inst !== null) {
      expect(inst.vcpu).toBeGreaterThanOrEqual(64);
    }
  });

  it("returns null when nothing fits", () => {
    const inst = pickInstance("aws", 999, 999);
    expect(inst).toBeNull();
  });

  it("returns null for non-cloud providers (catalog empty)", () => {
    expect(pickInstance("proxmox", 2, 4)).toBeNull();
    expect(pickInstance("vmware", 2, 4)).toBeNull();
  });
});

describe("pricing.estimateMonthly", () => {
  it("computes AWS monthly with compute + storage breakdown", () => {
    const r = estimateMonthly("aws", 2, 8, 100);
    expect(r.monthly_usd).toBeGreaterThan(0);
    expect(r.instance).toBeDefined();
    expect(r.breakdown.compute).toBeGreaterThan(0);
    expect(r.breakdown.storage).toBeGreaterThan(0);
    // Storage at $0.08/GB * 100 = $8
    expect(r.breakdown.storage).toBeCloseTo(8.0, 1);
  });

  it("computes Proxmox via TCO (no license cost)", () => {
    const r = estimateMonthly("proxmox", 4, 16, 200);
    expect(r.monthly_usd).toBeGreaterThan(0);
    expect(r.breakdown.license).toBe(0);
    expect(r.breakdown.compute).toBeGreaterThan(0);
  });

  it("computes vSphere TCO with Broadcom license cost included", () => {
    const r = estimateMonthly("vmware", 4, 16, 200);
    expect(r.breakdown.license).toBeGreaterThan(0);
    // 4 vCPU * $11.25 = $45 license
    expect(r.breakdown.license).toBeCloseTo(45.0, 1);
  });

  it("Proxmox is cheaper than vSphere for the same workload (no license)", () => {
    const px = estimateMonthly("proxmox", 8, 32, 500);
    const vs = estimateMonthly("vmware", 8, 32, 500);
    expect(vs.monthly_usd).toBeGreaterThan(px.monthly_usd);
  });
});

describe("pricing.estimateOneTimeMigration", () => {
  it("scales linearly with disk size for AWS", () => {
    const a = estimateOneTimeMigration("aws", 100);
    const b = estimateOneTimeMigration("aws", 200);
    expect(b).toBeCloseTo(a * 2, 2);
  });

  it("returns 0 for on-prem-to-on-prem", () => {
    expect(estimateOneTimeMigration("proxmox", 500)).toBe(0);
    expect(estimateOneTimeMigration("vmware", 500)).toBe(0);
  });
});

describe("CostAdapter — tool surface", () => {
  it("exposes the three pricing tools at the read tier", () => {
    const a = new CostAdapter();
    const tools = a.getTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "compare_providers",
      "estimate_migration_cost",
      "estimate_vm_cost",
    ]);
    for (const t of tools) {
      expect(t.tier).toBe("read");
      expect(t.adapter).toBe("cost");
    }
  });

  it("identifies as a service adapter (not hypervisor)", () => {
    const a = new CostAdapter();
    expect(a.kind).toBe("service");
  });
});

describe("CostAdapter — estimate_vm_cost", () => {
  it("returns a successful estimate for a valid AWS workload", async () => {
    const a = new CostAdapter();
    const r = await a.execute("estimate_vm_cost", {
      provider: "aws",
      vcpu: 2,
      ram_gb: 8,
      disk_gb: 100,
    });
    expect(r.success).toBe(true);
    expect((r.data as any).monthly_usd).toBeGreaterThan(0);
    expect((r.data as any).instance).toBeDefined();
    expect((r.data as any).breakdown.compute).toBeGreaterThan(0);
  });

  it("rejects an unknown provider", async () => {
    const a = new CostAdapter();
    const r = await a.execute("estimate_vm_cost", {
      provider: "gcp",
      vcpu: 2,
      ram_gb: 8,
      disk_gb: 100,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/provider must be one of/);
  });

  it("rejects negative numbers", async () => {
    const a = new CostAdapter();
    const r = await a.execute("estimate_vm_cost", {
      provider: "aws",
      vcpu: -2,
      ram_gb: 8,
      disk_gb: 100,
    });
    expect(r.success).toBe(false);
  });
});

describe("CostAdapter — estimate_migration_cost", () => {
  it("flags AWS-from-Proxmox as more expensive (typical case)", async () => {
    const a = new CostAdapter();
    const r = await a.execute("estimate_migration_cost", {
      source_provider: "proxmox",
      target_provider: "aws",
      vcpu: 4,
      ram_gb: 16,
      disk_gb: 200,
      vm_name: "test-vm",
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.delta_monthly_usd).toBeGreaterThan(0); // AWS is more expensive than self-hosted
    expect(d.recommendation).toMatch(/more expensive|increase/);
    expect(d.one_time_usd).toBeGreaterThan(0); // there's staging cost
    expect(d.target_instance).toBeDefined();
  });

  it("flags vSphere → Proxmox as cheaper, with payback period", async () => {
    const a = new CostAdapter();
    const r = await a.execute("estimate_migration_cost", {
      source_provider: "vmware",
      target_provider: "proxmox",
      vcpu: 8,
      ram_gb: 32,
      disk_gb: 500,
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.delta_monthly_usd).toBeLessThan(0); // saving
    expect(d.recommendation).toMatch(/cheaper|saving/);
    // Proxmox-as-target is a free move (per pricing table), so payback = 0
    expect(d.payback_months).toBe(0);
  });
});

describe("CostAdapter — compare_providers", () => {
  it("ranks all providers cheapest → most expensive", async () => {
    const a = new CostAdapter();
    const r = await a.execute("compare_providers", {
      vcpu: 4,
      ram_gb: 16,
      disk_gb: 200,
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.ranked.length).toBeGreaterThan(1);
    // Verify monotonic ascending
    for (let i = 1; i < d.ranked.length; i++) {
      expect(d.ranked[i].monthly_usd).toBeGreaterThanOrEqual(d.ranked[i - 1].monthly_usd);
    }
    expect(d.cheapest.provider).toBe(d.ranked[0].provider);
    expect(d.spread_pct).toBeGreaterThan(0);
  });

  it("typical comparison: Proxmox is cheapest, AWS/Azure cost more", async () => {
    const a = new CostAdapter();
    const r = await a.execute("compare_providers", {
      vcpu: 4,
      ram_gb: 16,
      disk_gb: 200,
    });
    const d = r.data as any;
    expect(d.cheapest.provider).toBe("proxmox");
  });
});

describe("CostAdapter — error paths", () => {
  it("returns success:false for unknown tool", async () => {
    const a = new CostAdapter();
    const r = await a.execute("does_not_exist", {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Unknown tool/);
  });

  it("getClusterState returns empty state (service adapter)", async () => {
    const a = new CostAdapter();
    const s = await a.getClusterState();
    expect(s.adapter).toBe("cost");
    expect(s.vms).toEqual([]);
    expect(s.nodes).toEqual([]);
  });
});

describe("Pricing tables — sanity", () => {
  it("AWS catalog is monotonic-ish in price within a family", () => {
    const t3 = AWS_INSTANCES.filter((i) => i.family === "t3").sort((a, b) => a.vcpu - b.vcpu);
    for (let i = 1; i < t3.length; i++) {
      expect(t3[i].monthly_usd).toBeGreaterThanOrEqual(t3[i - 1].monthly_usd);
    }
  });

  it("Azure catalog has at least one B and one D series instance", () => {
    expect(AZURE_INSTANCES.some((i) => i.family === "B")).toBe(true);
    expect(AZURE_INSTANCES.some((i) => i.family === "D")).toBe(true);
  });
});
