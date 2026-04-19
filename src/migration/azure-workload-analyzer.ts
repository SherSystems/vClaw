import type { DiskFormat, MigrationDisk } from "./types.js";

interface AzureVMSpec {
  name: string;
  family: "B" | "D" | "E" | "F";
  vCPU: number;
  memoryMiB: number;
  hourlyRate: number;
}

type AzureDiskSku = "Standard_LRS" | "Premium_LRS";

export interface AzureTargetRecommendation {
  vmSize: string;
  diskSku: AzureDiskSku;
  location: string;
  estimatedMonthlyCost: number;
  notes: string[];
}

export interface AzureWorkloadAnalysis {
  target: {
    provider: "azure-vm";
    recommended: AzureTargetRecommendation;
    alternatives: AzureTargetRecommendation[];
  };
  storage: {
    currentGB: number;
    estimatedTargetGB: number;
    format: DiskFormat;
    diskSku: AzureDiskSku;
    estimatedMonthlyCost: number;
  };
  network: { considerations: string[] };
  costEstimate: { monthlyUSD: number; breakdown: Record<string, number> };
  risks: string[];
  migrationTimeEstimateMinutes: number;
}

interface AzureAnalysisVMConfig {
  name: string;
  cpuCount: number;
  memoryMiB: number;
  disks: Array<Pick<MigrationDisk, "capacityBytes">>;
  nics: Array<unknown>;
  firmware: "bios" | "efi";
}

const AZURE_VM_CATALOG: AzureVMSpec[] = [
  { name: "Standard_B1s", family: "B", vCPU: 1, memoryMiB: 1024, hourlyRate: 0.0104 },
  { name: "Standard_B1ms", family: "B", vCPU: 1, memoryMiB: 2048, hourlyRate: 0.0208 },
  { name: "Standard_B2s", family: "B", vCPU: 2, memoryMiB: 4096, hourlyRate: 0.0416 },
  { name: "Standard_B2ms", family: "B", vCPU: 2, memoryMiB: 8192, hourlyRate: 0.0832 },
  { name: "Standard_B4ms", family: "B", vCPU: 4, memoryMiB: 16384, hourlyRate: 0.166 },
  { name: "Standard_D2s_v5", family: "D", vCPU: 2, memoryMiB: 8192, hourlyRate: 0.096 },
  { name: "Standard_D4s_v5", family: "D", vCPU: 4, memoryMiB: 16384, hourlyRate: 0.192 },
  { name: "Standard_D8s_v5", family: "D", vCPU: 8, memoryMiB: 32768, hourlyRate: 0.384 },
  { name: "Standard_D16s_v5", family: "D", vCPU: 16, memoryMiB: 65536, hourlyRate: 0.768 },
  { name: "Standard_E2s_v5", family: "E", vCPU: 2, memoryMiB: 16384, hourlyRate: 0.126 },
  { name: "Standard_E4s_v5", family: "E", vCPU: 4, memoryMiB: 32768, hourlyRate: 0.252 },
  { name: "Standard_F2s_v2", family: "F", vCPU: 2, memoryMiB: 4096, hourlyRate: 0.084 },
  { name: "Standard_F4s_v2", family: "F", vCPU: 4, memoryMiB: 8192, hourlyRate: 0.169 },
];

const HOURS_PER_MONTH = 730;
const STANDARD_LRS_COST_PER_GB = 0.04;
const PREMIUM_LRS_COST_PER_GB = 0.12;
const TRANSFER_SPEED_MB_PER_SEC = 100;
const IMPORT_OVERHEAD_MINUTES = 30;

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function bytesToGB(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024 * 1024));
}

function totalDiskGB(disks: Array<Pick<MigrationDisk, "capacityBytes">>): number {
  const total = disks.reduce((sum, disk) => sum + bytesToGB(Math.max(0, disk.capacityBytes)), 0);
  return Math.max(1, total);
}

function diskCostPerGB(diskSku: AzureDiskSku): number {
  return diskSku === "Premium_LRS" ? PREMIUM_LRS_COST_PER_GB : STANDARD_LRS_COST_PER_GB;
}

function determinePreferredFamily(cpuCount: number, memoryMiB: number): AzureVMSpec["family"] {
  const memoryGiB = memoryMiB / 1024;
  const ratioGBPerCore = memoryGiB / Math.max(1, cpuCount);

  if (ratioGBPerCore >= 6) return "E";
  if (cpuCount >= 4 && ratioGBPerCore <= 3) return "F";
  if (cpuCount <= 2 && memoryMiB <= 8192) return "B";
  return "D";
}

function chooseDiskSku(cpuCount: number, memoryMiB: number, diskGB: number): AzureDiskSku {
  if (cpuCount >= 4 || memoryMiB >= 16384 || diskGB >= 256) return "Premium_LRS";
  return "Standard_LRS";
}

function toRecommendation(
  vm: AzureVMSpec,
  diskGB: number,
  diskSku: AzureDiskSku,
  location: string,
  notes: string[],
): AzureTargetRecommendation {
  const computeCost = vm.hourlyRate * HOURS_PER_MONTH;
  const storageCost = diskGB * diskCostPerGB(diskSku);
  return {
    vmSize: vm.name,
    diskSku,
    location,
    estimatedMonthlyCost: roundCurrency(computeCost + storageCost),
    notes,
  };
}

export class AzureWorkloadAnalyzer {
  static getVMSizeSpecs(vmSize: string): { vCPU: number; memoryMiB: number; hourlyRate: number } | null {
    const match = AZURE_VM_CATALOG.find((entry) => entry.name === vmSize);
    if (!match) return null;
    return {
      vCPU: match.vCPU,
      memoryMiB: match.memoryMiB,
      hourlyRate: match.hourlyRate,
    };
  }

  static analyzeVMForAzure(vmConfig: AzureAnalysisVMConfig, location: string): AzureWorkloadAnalysis {
    const requiredCPU = Math.max(1, vmConfig.cpuCount);
    const requiredMemoryMiB = Math.max(1024, vmConfig.memoryMiB);
    const preferredFamily = determinePreferredFamily(requiredCPU, requiredMemoryMiB);
    const diskGB = totalDiskGB(vmConfig.disks);
    const defaultDiskSku = chooseDiskSku(requiredCPU, requiredMemoryMiB, diskGB);

    const fitting = AZURE_VM_CATALOG.filter(
      (entry) => entry.vCPU >= requiredCPU && entry.memoryMiB >= requiredMemoryMiB,
    );
    const sortedFitting = [...fitting].sort((a, b) => a.hourlyRate - b.hourlyRate);
    const preferredFitting = sortedFitting.filter((entry) => entry.family === preferredFamily);
    const primary = (preferredFitting[0] ?? sortedFitting[0] ?? [...AZURE_VM_CATALOG].sort((a, b) => b.hourlyRate - a.hourlyRate)[0]);

    const cheaperFit = sortedFitting
      .filter((entry) => entry.hourlyRate < primary.hourlyRate)
      .sort((a, b) => b.hourlyRate - a.hourlyRate)[0];
    const cheaperAny = [...AZURE_VM_CATALOG]
      .filter((entry) => entry.hourlyRate < primary.hourlyRate)
      .sort((a, b) => b.hourlyRate - a.hourlyRate)[0];
    const cheaper = cheaperFit ?? cheaperAny ?? null;

    const largerFit = sortedFitting.find(
      (entry) =>
        entry.hourlyRate > primary.hourlyRate &&
        (entry.vCPU > primary.vCPU || entry.memoryMiB > primary.memoryMiB),
    );
    const largerAny = [...AZURE_VM_CATALOG]
      .filter((entry) => entry.hourlyRate > primary.hourlyRate)
      .sort((a, b) => a.hourlyRate - b.hourlyRate)[0];
    const larger = largerFit ?? largerAny ?? null;

    const alternatives: AzureTargetRecommendation[] = [];
    if (cheaper && cheaper.name !== primary.name) {
      const underSized = cheaper.vCPU < requiredCPU || cheaper.memoryMiB < requiredMemoryMiB;
      alternatives.push(
        toRecommendation(
          cheaper,
          diskGB,
          "Standard_LRS",
          location,
          [
            `Cheaper alternative: ${cheaper.name} (${cheaper.vCPU} vCPU, ${cheaper.memoryMiB} MiB).`,
            underSized
              ? `Lower than required ${requiredCPU} vCPU / ${requiredMemoryMiB} MiB; use only for bursty or dev workloads.`
              : "Meets current capacity needs with lower monthly spend.",
          ],
        ),
      );
    }
    if (larger && larger.name !== primary.name) {
      alternatives.push(
        toRecommendation(
          larger,
          diskGB,
          chooseDiskSku(larger.vCPU, larger.memoryMiB, diskGB),
          location,
          [
            `Larger alternative: ${larger.name} (${larger.vCPU} vCPU, ${larger.memoryMiB} MiB).`,
            "Use for headroom on CPU/memory growth or sustained peaks.",
          ],
        ),
      );
    }

    if (alternatives.length < 2) {
      const fallback = sortedFitting.find(
        (entry) =>
          entry.name !== primary.name &&
          !alternatives.some((candidate) => candidate.vmSize === entry.name),
      );
      if (fallback) {
        alternatives.push(
          toRecommendation(
            fallback,
            diskGB,
            chooseDiskSku(fallback.vCPU, fallback.memoryMiB, diskGB),
            location,
            [`Alternative: ${fallback.name} (${fallback.vCPU} vCPU, ${fallback.memoryMiB} MiB).`],
          ),
        );
      }
    }

    const recommended = toRecommendation(
      primary,
      diskGB,
      defaultDiskSku,
      location,
      [
        `Maps ${requiredCPU} vCPU / ${requiredMemoryMiB} MiB to ${primary.name}.`,
        `${vmConfig.disks.length} disk(s) -> Azure managed disk (${defaultDiskSku}), ${diskGB} GB total.`,
      ],
    );

    const computeMonthly = primary.hourlyRate * HOURS_PER_MONTH;
    const storageMonthly = diskGB * diskCostPerGB(defaultDiskSku);
    const transferMinutes = (diskGB * 1024) / (TRANSFER_SPEED_MB_PER_SEC * 60);

    const risks = [
      "Cross-cloud transfer throughput and egress pricing can extend cutover windows.",
      "Guest drivers/network adapters should be validated post-cutover in Azure.",
    ];
    if (vmConfig.firmware === "efi") {
      risks.push("UEFI/Secure Boot settings may require image-level validation before production cutover.");
    }
    if (vmConfig.nics.length > 1) {
      risks.push(`Source VM has ${vmConfig.nics.length} NICs; validate Azure NIC limits and subnet mapping.`);
    }

    return {
      target: {
        provider: "azure-vm",
        recommended,
        alternatives: alternatives.slice(0, 2),
      },
      storage: {
        currentGB: diskGB,
        estimatedTargetGB: diskGB,
        format: "vhd",
        diskSku: defaultDiskSku,
        estimatedMonthlyCost: roundCurrency(storageMonthly),
      },
      network: {
        considerations: [
          "Select target VNet/subnet and NSG rules before execution.",
          "Validate private IP assumptions and service endpoints after migration.",
        ],
      },
      costEstimate: {
        monthlyUSD: roundCurrency(computeMonthly + storageMonthly),
        breakdown: {
          compute: roundCurrency(computeMonthly),
          storage: roundCurrency(storageMonthly),
        },
      },
      risks,
      migrationTimeEstimateMinutes: Math.ceil(transferMinutes + IMPORT_OVERHEAD_MINUTES),
    };
  }
}
