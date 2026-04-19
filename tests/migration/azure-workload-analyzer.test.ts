import { describe, expect, it } from "vitest";
import { AzureWorkloadAnalyzer } from "../../src/migration/azure-workload-analyzer.js";

function bytes(gb: number): number {
  return gb * 1024 * 1024 * 1024;
}

describe("AzureWorkloadAnalyzer", () => {
  it("returns recommended sizing with at least one cheaper and one larger alternative", () => {
    const analysis = AzureWorkloadAnalyzer.analyzeVMForAzure(
      {
        name: "api-1",
        cpuCount: 2,
        memoryMiB: 4096,
        disks: [{ capacityBytes: bytes(40) }],
        nics: [],
        firmware: "bios",
      },
      "eastus",
    );

    expect(analysis.target.recommended.vmSize).toBeTruthy();
    expect(analysis.target.recommended.estimatedMonthlyCost).toBeGreaterThan(0);
    expect(analysis.target.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(
      analysis.target.alternatives.some(
        (candidate) => candidate.estimatedMonthlyCost < analysis.target.recommended.estimatedMonthlyCost,
      ),
    ).toBe(true);
    expect(
      analysis.target.alternatives.some(
        (candidate) => candidate.estimatedMonthlyCost > analysis.target.recommended.estimatedMonthlyCost,
      ),
    ).toBe(true);
    expect(analysis.storage.currentGB).toBe(40);
  });

  it("uses premium disk sku for larger workloads and includes storage breakdown", () => {
    const analysis = AzureWorkloadAnalyzer.analyzeVMForAzure(
      {
        name: "db-1",
        cpuCount: 8,
        memoryMiB: 32768,
        disks: [{ capacityBytes: bytes(200) }, { capacityBytes: bytes(100) }],
        nics: [{ label: "nic-1" }, { label: "nic-2" }],
        firmware: "efi",
      },
      "eastus2",
    );

    expect(analysis.target.recommended.diskSku).toBe("Premium_LRS");
    expect(analysis.storage.diskSku).toBe("Premium_LRS");
    expect(analysis.storage.currentGB).toBe(300);
    expect(analysis.storage.estimatedMonthlyCost).toBeCloseTo(36, 2);
    expect(analysis.costEstimate.breakdown.compute).toBeGreaterThan(0);
    expect(analysis.costEstimate.breakdown.storage).toBeGreaterThan(0);
    expect(analysis.risks.some((risk) => risk.includes("NICs"))).toBe(true);
  });

  it("provides vm size specs lookup for adapter reverse-mapping", () => {
    expect(AzureWorkloadAnalyzer.getVMSizeSpecs("Standard_B2s")).toEqual({
      vCPU: 2,
      memoryMiB: 4096,
      hourlyRate: 0.0416,
    });
    expect(AzureWorkloadAnalyzer.getVMSizeSpecs("Standard_DOES_NOT_EXIST")).toBeNull();
  });
});
