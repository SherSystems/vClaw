// ============================================================
// RHODES — Cost Adapter / Pricing Tables
// ------------------------------------------------------------
// Hardcoded reference prices for popular instance families,
// storage, and hidden-cost line items across AWS, Azure, and
// generic on-prem (Proxmox / vSphere). Numbers are approximate
// on-demand list prices in USD as of late 2025; refresh when
// providers re-rate. The point isn't penny-precision — it's
// directionally correct estimates that flag obvious surprises
// before a migration runs.
// ============================================================

export type Provider = "aws" | "azure" | "proxmox" | "vmware";

export interface InstanceSpec {
  /** Provider-native instance/SKU name, e.g. "t3.large" or "Standard_D4s_v3". */
  name: string;
  vcpu: number;
  ram_gb: number;
  /** Monthly on-demand price in USD, in the default region for this provider. */
  monthly_usd: number;
  family?: string;
}

// ── AWS · us-east-1 · on-demand · Linux ──────────────────────
// monthly_usd = hourly * 730
export const AWS_INSTANCES: InstanceSpec[] = [
  // T3 — burstable general purpose
  { name: "t3.nano",    vcpu: 2,  ram_gb: 0.5,  monthly_usd:   3.80, family: "t3" },
  { name: "t3.micro",   vcpu: 2,  ram_gb: 1,    monthly_usd:   7.59, family: "t3" },
  { name: "t3.small",   vcpu: 2,  ram_gb: 2,    monthly_usd:  15.18, family: "t3" },
  { name: "t3.medium",  vcpu: 2,  ram_gb: 4,    monthly_usd:  30.37, family: "t3" },
  { name: "t3.large",   vcpu: 2,  ram_gb: 8,    monthly_usd:  60.74, family: "t3" },
  { name: "t3.xlarge",  vcpu: 4,  ram_gb: 16,   monthly_usd: 121.47, family: "t3" },
  { name: "t3.2xlarge", vcpu: 8,  ram_gb: 32,   monthly_usd: 242.94, family: "t3" },
  // M5 — general purpose, sustained
  { name: "m5.large",    vcpu: 2,  ram_gb: 8,   monthly_usd:  69.84, family: "m5" },
  { name: "m5.xlarge",   vcpu: 4,  ram_gb: 16,  monthly_usd: 139.68, family: "m5" },
  { name: "m5.2xlarge",  vcpu: 8,  ram_gb: 32,  monthly_usd: 279.37, family: "m5" },
  { name: "m5.4xlarge",  vcpu: 16, ram_gb: 64,  monthly_usd: 558.74, family: "m5" },
  { name: "m5.8xlarge",  vcpu: 32, ram_gb: 128, monthly_usd: 1117.48, family: "m5" },
  // C5 — compute optimized
  { name: "c5.large",    vcpu: 2,  ram_gb: 4,   monthly_usd:  61.98, family: "c5" },
  { name: "c5.xlarge",   vcpu: 4,  ram_gb: 8,   monthly_usd: 123.97, family: "c5" },
  { name: "c5.2xlarge",  vcpu: 8,  ram_gb: 16,  monthly_usd: 247.94, family: "c5" },
  { name: "c5.4xlarge",  vcpu: 16, ram_gb: 32,  monthly_usd: 495.88, family: "c5" },
  // R5 — memory optimized
  { name: "r5.large",    vcpu: 2,  ram_gb: 16,  monthly_usd:  91.98, family: "r5" },
  { name: "r5.xlarge",   vcpu: 4,  ram_gb: 32,  monthly_usd: 183.96, family: "r5" },
  { name: "r5.2xlarge",  vcpu: 8,  ram_gb: 64,  monthly_usd: 367.92, family: "r5" },
];

// ── Azure · East US · pay-as-you-go · Linux ──────────────────
export const AZURE_INSTANCES: InstanceSpec[] = [
  // B-series — burstable
  { name: "Standard_B1s",     vcpu: 1,  ram_gb: 1,   monthly_usd:   7.59, family: "B" },
  { name: "Standard_B2s",     vcpu: 2,  ram_gb: 4,   monthly_usd:  30.37, family: "B" },
  { name: "Standard_B2ms",    vcpu: 2,  ram_gb: 8,   monthly_usd:  60.74, family: "B" },
  { name: "Standard_B4ms",    vcpu: 4,  ram_gb: 16,  monthly_usd: 121.47, family: "B" },
  { name: "Standard_B8ms",    vcpu: 8,  ram_gb: 32,  monthly_usd: 242.94, family: "B" },
  // Dsv3 — general purpose
  { name: "Standard_D2s_v3",  vcpu: 2,  ram_gb: 8,   monthly_usd:  70.08, family: "D" },
  { name: "Standard_D4s_v3",  vcpu: 4,  ram_gb: 16,  monthly_usd: 140.16, family: "D" },
  { name: "Standard_D8s_v3",  vcpu: 8,  ram_gb: 32,  monthly_usd: 280.32, family: "D" },
  { name: "Standard_D16s_v3", vcpu: 16, ram_gb: 64,  monthly_usd: 560.64, family: "D" },
  // Esv3 — memory optimized
  { name: "Standard_E2s_v3",  vcpu: 2,  ram_gb: 16,  monthly_usd:  92.71, family: "E" },
  { name: "Standard_E4s_v3",  vcpu: 4,  ram_gb: 32,  monthly_usd: 185.42, family: "E" },
  { name: "Standard_E8s_v3",  vcpu: 8,  ram_gb: 64,  monthly_usd: 370.84, family: "E" },
];

// ── Storage ($/GB-month) ─────────────────────────────────────
export const STORAGE_PRICING = {
  aws_gp3:           0.080,  // EBS gp3
  aws_gp2:           0.100,  // EBS gp2 (legacy)
  aws_io2:           0.125,  // EBS io2 (provisioned)
  aws_s3_standard:   0.023,  // S3 standard
  azure_premium_ssd: 0.150,  // Azure Premium SSD (P-series, blended)
  azure_standard_ssd:0.075,  // Azure Standard SSD
  proxmox_local_zfs: 0.020,  // commodity hardware amortized + power
  vmware_vsan:       0.025,  // similar but with vSAN licensing baked in
};

// ── On-prem TCO ($/unit-month) ───────────────────────────────
// Rough TCO baseline for self-hosted compute. Includes a 5-year
// hardware amortization, power, cooling, and rack space, but not
// licensing (that's added separately for vSphere).
export const ONPREM_TCO = {
  proxmox: { vcpu_usd: 5.0,  ram_gb_usd: 0.50, license_per_vcpu_usd: 0 },
  // VMware/vSphere: VVF Standard ~$135/core/year ≈ $11.25/core/month under
  // Broadcom subscription pricing. License cost is per physical core, but
  // we approximate per vCPU as a planning shorthand.
  vmware:  { vcpu_usd: 5.0,  ram_gb_usd: 0.50, license_per_vcpu_usd: 11.25 },
};

// ── Cross-cutting line items ─────────────────────────────────
export const NETWORK_PRICING = {
  aws_alb_base_monthly_usd:   16.20,
  aws_nat_gateway_monthly:    32.40,
  aws_data_egress_per_gb:      0.090,
  azure_lb_standard_monthly:  18.25,
  azure_data_egress_per_gb:    0.087,
};

// ── Migration one-time cost (per GB transferred) ─────────────
// Covers staging in S3/Azure Blob + snapshot creation. Heavy
// approximation — most migrations land between these bounds.
export const MIGRATION_ONE_TIME = {
  aws_per_gb_usd:   0.15, // S3 staging ~7 days + EBS snapshot create
  azure_per_gb_usd: 0.13, // Blob staging ~7 days + managed disk import
  proxmox_per_gb_usd: 0.00, // local-to-local move
  vmware_per_gb_usd:  0.00,
};

// ── Helpers ─────────────────────────────────────────────────

export function getInstanceCatalog(provider: Provider): InstanceSpec[] {
  if (provider === "aws") return AWS_INSTANCES;
  if (provider === "azure") return AZURE_INSTANCES;
  return [];
}

/**
 * Pick the smallest instance from the catalog that satisfies the workload's
 * vCPU and RAM requirements. Optional `preferFamily` biases toward a family
 * (e.g. "m5" for sustained load, "t3" for burstable, "r5" for memory-heavy).
 * Falls back to any qualifying instance if the preferred family doesn't fit.
 */
export function pickInstance(
  provider: Provider,
  vcpu: number,
  ram_gb: number,
  preferFamily?: string,
): InstanceSpec | null {
  const catalog = getInstanceCatalog(provider);
  if (catalog.length === 0) return null;

  const fits = catalog.filter((i) => i.vcpu >= vcpu && i.ram_gb >= ram_gb);
  if (fits.length === 0) return null;

  if (preferFamily) {
    const preferred = fits.filter((i) => i.family === preferFamily);
    if (preferred.length > 0) {
      return preferred.sort((a, b) => a.monthly_usd - b.monthly_usd)[0];
    }
  }
  return fits.sort((a, b) => a.monthly_usd - b.monthly_usd)[0];
}

/**
 * Estimate monthly $ for a workload on a given provider. For cloud, picks
 * an instance + sums storage. For on-prem, applies the TCO formula.
 */
export function estimateMonthly(
  provider: Provider,
  vcpu: number,
  ram_gb: number,
  disk_gb: number,
  preferFamily?: string,
): { monthly_usd: number; instance?: InstanceSpec; breakdown: Record<string, number> } {
  if (provider === "aws") {
    const inst = pickInstance("aws", vcpu, ram_gb, preferFamily);
    if (!inst) {
      return { monthly_usd: 0, breakdown: { error: -1 } };
    }
    const compute = inst.monthly_usd;
    const storage = disk_gb * STORAGE_PRICING.aws_gp3;
    return {
      monthly_usd: round2(compute + storage),
      instance: inst,
      breakdown: { compute: round2(compute), storage: round2(storage) },
    };
  }
  if (provider === "azure") {
    const inst = pickInstance("azure", vcpu, ram_gb, preferFamily);
    if (!inst) {
      return { monthly_usd: 0, breakdown: { error: -1 } };
    }
    const compute = inst.monthly_usd;
    const storage = disk_gb * STORAGE_PRICING.azure_premium_ssd;
    return {
      monthly_usd: round2(compute + storage),
      instance: inst,
      breakdown: { compute: round2(compute), storage: round2(storage) },
    };
  }
  // On-prem (Proxmox or VMware): compute = vCPU + RAM TCO + license; storage by family
  const tco = ONPREM_TCO[provider];
  const license = vcpu * tco.license_per_vcpu_usd;
  const compute = vcpu * tco.vcpu_usd + ram_gb * tco.ram_gb_usd;
  const storageRate =
    provider === "vmware" ? STORAGE_PRICING.vmware_vsan : STORAGE_PRICING.proxmox_local_zfs;
  const storage = disk_gb * storageRate;
  return {
    monthly_usd: round2(compute + storage + license),
    breakdown: {
      compute: round2(compute),
      storage: round2(storage),
      license: round2(license),
    },
  };
}

/**
 * One-time migration cost — staging + snapshot/import overhead.
 */
export function estimateOneTimeMigration(target: Provider, disk_gb: number): number {
  const rate = MIGRATION_ONE_TIME[`${target}_per_gb_usd` as keyof typeof MIGRATION_ONE_TIME];
  return round2(disk_gb * (rate ?? 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
