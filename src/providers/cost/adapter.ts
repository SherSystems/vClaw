// ============================================================
// RHODES — Cost Adapter
// ------------------------------------------------------------
// Service adapter (no infra ownership) that exposes cost
// estimation tools across AWS, Azure, Proxmox, and vSphere.
// The agent planner calls these whenever a goal mentions cost,
// budget, savings, or a migration that crosses provider lines.
// ============================================================

import type {
  AdapterKind,
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
} from "../types.js";
import {
  estimateMonthly,
  estimateOneTimeMigration,
  type Provider,
} from "./pricing.js";

const PROVIDERS: Provider[] = ["aws", "azure", "proxmox", "vmware"];

export class CostAdapter implements InfraAdapter {
  name = "cost";
  kind: AdapterKind = "service";
  private _connected = false;

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: "estimate_vm_cost",
        description:
          "Estimate the monthly $ cost of running a workload on a target provider, including the picked instance type and a compute/storage breakdown. Use whenever a user asks how much something costs to run, or before recommending a target during a migration plan.",
        tier: "read",
        adapter: "cost",
        params: [
          { name: "provider", type: "string", required: true, description: 'Target: "aws" | "azure" | "proxmox" | "vmware"' },
          { name: "vcpu", type: "number", required: true, description: "vCPU count required" },
          { name: "ram_gb", type: "number", required: true, description: "RAM in GB" },
          { name: "disk_gb", type: "number", required: true, description: "Disk in GB" },
          { name: "prefer_family", type: "string", required: false, description: 'Optional family bias: "t3"|"m5"|"c5"|"r5" (AWS) or "B"|"D"|"E" (Azure)' },
        ],
        returns: "{ provider, monthly_usd, instance, breakdown }",
      },
      {
        name: "estimate_migration_cost",
        description:
          "Estimate the full $ impact of migrating one or more VMs from a source provider to a target provider. Returns one-time migration cost (staging, conversion) plus a monthly delta (target monthly - source monthly). Always call this before executing any cross-provider migration.",
        tier: "read",
        adapter: "cost",
        params: [
          { name: "source_provider", type: "string", required: true, description: 'Source: "aws"|"azure"|"proxmox"|"vmware"' },
          { name: "target_provider", type: "string", required: true, description: 'Target: "aws"|"azure"|"proxmox"|"vmware"' },
          { name: "vcpu", type: "number", required: true, description: "vCPU count" },
          { name: "ram_gb", type: "number", required: true, description: "RAM in GB" },
          { name: "disk_gb", type: "number", required: true, description: "Disk in GB" },
          { name: "vm_name", type: "string", required: false, description: "Optional VM identifier for the report" },
        ],
        returns: "{ source_monthly_usd, target_monthly_usd, delta_monthly_usd, delta_pct, one_time_usd, payback_months, recommendation }",
      },
      {
        name: "compare_providers",
        description:
          "Run the same workload spec across all supported providers (AWS, Azure, Proxmox, vSphere) and return a ranked monthly cost comparison. Use for 'where is the cheapest place to run X' questions.",
        tier: "read",
        adapter: "cost",
        params: [
          { name: "vcpu", type: "number", required: true, description: "vCPU count" },
          { name: "ram_gb", type: "number", required: true, description: "RAM in GB" },
          { name: "disk_gb", type: "number", required: true, description: "Disk in GB" },
        ],
        returns: "{ ranked: [{ provider, monthly_usd, instance, breakdown }, ...], cheapest, most_expensive, spread_pct }",
      },
    ];
  }

  async execute(tool: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      switch (tool) {
        case "estimate_vm_cost":
          return this.estimateVmCost(params);
        case "estimate_migration_cost":
          return this.estimateMigrationCost(params);
        case "compare_providers":
          return this.compareProviders(params);
        default:
          return { success: false, error: `Unknown tool: ${tool}` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getClusterState(): Promise<ClusterState> {
    // Service adapter — no infra ownership.
    return {
      adapter: this.name,
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  // ── Tool implementations ───────────────────────────────────

  private estimateVmCost(params: Record<string, unknown>): ToolCallResult {
    const provider = this.requireProvider(params.provider, "provider");
    const vcpu = this.requireNumber(params.vcpu, "vcpu");
    const ram_gb = this.requireNumber(params.ram_gb, "ram_gb");
    const disk_gb = this.requireNumber(params.disk_gb, "disk_gb");
    const preferFamily =
      typeof params.prefer_family === "string" ? params.prefer_family : undefined;

    const result = estimateMonthly(provider, vcpu, ram_gb, disk_gb, preferFamily);
    if (result.breakdown.error === -1) {
      return {
        success: false,
        error: `No instance available on ${provider} that fits ${vcpu} vCPU / ${ram_gb} GB RAM`,
      };
    }
    return {
      success: true,
      data: {
        provider,
        monthly_usd: result.monthly_usd,
        instance: result.instance ?? null,
        breakdown: result.breakdown,
      },
    };
  }

  private estimateMigrationCost(params: Record<string, unknown>): ToolCallResult {
    const source = this.requireProvider(params.source_provider, "source_provider");
    const target = this.requireProvider(params.target_provider, "target_provider");
    const vcpu = this.requireNumber(params.vcpu, "vcpu");
    const ram_gb = this.requireNumber(params.ram_gb, "ram_gb");
    const disk_gb = this.requireNumber(params.disk_gb, "disk_gb");
    const vmName = typeof params.vm_name === "string" ? params.vm_name : undefined;

    const sourceCost = estimateMonthly(source, vcpu, ram_gb, disk_gb);
    const targetCost = estimateMonthly(target, vcpu, ram_gb, disk_gb);
    const oneTime = estimateOneTimeMigration(target, disk_gb);

    if (sourceCost.breakdown.error === -1 || targetCost.breakdown.error === -1) {
      return { success: false, error: `No fitting instance on one or both providers for ${vcpu} vCPU / ${ram_gb} GB` };
    }

    const delta = round2(targetCost.monthly_usd - sourceCost.monthly_usd);
    const deltaPct =
      sourceCost.monthly_usd === 0
        ? 0
        : round2((delta / sourceCost.monthly_usd) * 100);

    // Payback only meaningful when target is cheaper (delta < 0)
    const monthlySavings = -delta;
    const payback = monthlySavings > 0 ? round2(oneTime / monthlySavings) : null;

    let recommendation: string;
    if (delta < 0) {
      recommendation = `Target is $${Math.abs(delta).toFixed(2)}/mo cheaper (${Math.abs(deltaPct).toFixed(1)}% saving)`;
      if (payback !== null && payback > 0) {
        recommendation += `. Migration cost pays back in ${payback} month${payback === 1 ? "" : "s"}.`;
      }
    } else if (delta > 0) {
      recommendation = `Target is $${delta.toFixed(2)}/mo more expensive (${deltaPct.toFixed(1)}% increase)`;
    } else {
      recommendation = `Cost is roughly the same on both providers`;
    }

    return {
      success: true,
      data: {
        vm_name: vmName ?? null,
        source_provider: source,
        target_provider: target,
        source_monthly_usd: sourceCost.monthly_usd,
        target_monthly_usd: targetCost.monthly_usd,
        delta_monthly_usd: delta,
        delta_pct: deltaPct,
        one_time_usd: oneTime,
        payback_months: payback,
        target_instance: targetCost.instance ?? null,
        recommendation,
      },
    };
  }

  private compareProviders(params: Record<string, unknown>): ToolCallResult {
    const vcpu = this.requireNumber(params.vcpu, "vcpu");
    const ram_gb = this.requireNumber(params.ram_gb, "ram_gb");
    const disk_gb = this.requireNumber(params.disk_gb, "disk_gb");

    const results = PROVIDERS.map((p) => {
      const r = estimateMonthly(p, vcpu, ram_gb, disk_gb);
      return {
        provider: p,
        monthly_usd: r.monthly_usd,
        instance: r.instance ?? null,
        breakdown: r.breakdown,
        fits: r.breakdown.error !== -1,
      };
    }).filter((r) => r.fits);

    if (results.length === 0) {
      return {
        success: false,
        error: `No provider has an instance that fits ${vcpu} vCPU / ${ram_gb} GB RAM`,
      };
    }

    const ranked = results.sort((a, b) => a.monthly_usd - b.monthly_usd);
    const cheapest = ranked[0];
    const mostExpensive = ranked[ranked.length - 1];
    const spreadPct =
      cheapest.monthly_usd === 0
        ? 0
        : round2(((mostExpensive.monthly_usd - cheapest.monthly_usd) / cheapest.monthly_usd) * 100);

    return {
      success: true,
      data: {
        ranked,
        cheapest: { provider: cheapest.provider, monthly_usd: cheapest.monthly_usd },
        most_expensive: { provider: mostExpensive.provider, monthly_usd: mostExpensive.monthly_usd },
        spread_pct: spreadPct,
      },
    };
  }

  // ── Param validation ───────────────────────────────────────

  private requireProvider(v: unknown, field: string): Provider {
    if (typeof v !== "string" || !PROVIDERS.includes(v as Provider)) {
      throw new Error(
        `${field} must be one of ${PROVIDERS.join(", ")} (got: ${String(v)})`,
      );
    }
    return v as Provider;
  }

  private requireNumber(v: unknown, field: string): number {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${field} must be a non-negative number (got: ${String(v)})`);
    }
    return n;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
