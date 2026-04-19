import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AWSClient } from "../../src/providers/aws/client.js";
import type { MigrationVMConfig } from "../../src/migration/types.js";

const cloudUploaderMocks = vi.hoisted(() => ({
  uploadDiskFromSSHToS3: vi.fn(async () => undefined),
}));

vi.mock("../../src/migration/cloud-uploader.js", () => ({
  uploadDiskFromSSHToS3: cloudUploaderMocks.uploadDiskFromSSHToS3,
}));

import { AWSImporter } from "../../src/migration/aws-importer.js";

const vmConfig: MigrationVMConfig = {
  name: "Migration-TestVM",
  cpuCount: 2,
  coresPerSocket: 1,
  memoryMiB: 4096,
  guestOS: "OTHER_LINUX_64",
  disks: [{
    label: "disk0",
    capacityBytes: 10 * 1024 * 1024 * 1024,
    sourcePath: "/dev/pve/vm-101-disk-0",
    sourceFormat: "raw",
    targetFormat: "raw",
  }],
  nics: [{
    label: "net0",
    macAddress: "BC:24:11:F7:A4:00",
    networkName: "vmbr0",
    adapterType: "virtio",
  }],
  firmware: "bios",
};

describe("AWSImporter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cloudUploaderMocks.uploadDiskFromSSHToS3.mockReset();
    cloudUploaderMocks.uploadDiskFromSSHToS3.mockResolvedValue(undefined);
  });

  it("uses ImportSnapshot + RegisterImage path for raw disks by default", async () => {
    const mockClient = {
      importSnapshot: vi.fn(async () => "import-snap-1"),
      describeImportSnapshotTasks: vi.fn(async () => [{
        importTaskId: "import-snap-1",
        status: "completed",
        snapshotId: "snap-1",
      }]),
      registerImageFromSnapshot: vi.fn(async () => "ami-snap-1"),
      importImage: vi.fn(async () => "import-image-1"),
      describeImportTasks: vi.fn(async () => [{
        importTaskId: "import-image-1",
        status: "completed",
        imageId: "ami-image-1",
      }]),
      describeImages: vi.fn(async () => []),
      launchInstance: vi.fn(async () => ({
        instanceId: "i-1",
        privateIp: "10.0.0.10",
      })),
      headObject: vi.fn(async () => ({ exists: true, size: 1024 * 1024 })),
    } as unknown as AWSClient;

    const importer = new AWSImporter(mockClient, "migration-bucket", "vclaw/");
    const result = await importer.importVM(
      {
        vmConfig,
        diskPath: "/dev/pve/vm-101-disk-0",
        diskFormat: "raw",
      },
      "192.168.86.50",
      "root",
    );

    expect(cloudUploaderMocks.uploadDiskFromSSHToS3).toHaveBeenCalledTimes(1);
    expect(cloudUploaderMocks.uploadDiskFromSSHToS3).toHaveBeenCalledWith(expect.objectContaining({
      sourcePath: "/dev/pve/vm-101-disk-0",
      bucket: "migration-bucket",
      key: expect.stringContaining("Migration-TestVM"),
    }));
    expect((mockClient as unknown as { importSnapshot: ReturnType<typeof vi.fn> }).importSnapshot)
      .toHaveBeenCalledTimes(1);
    expect((mockClient as unknown as { registerImageFromSnapshot: ReturnType<typeof vi.fn> }).registerImageFromSnapshot)
      .toHaveBeenCalledTimes(1);
    expect((mockClient as unknown as { importImage: ReturnType<typeof vi.fn> }).importImage)
      .not.toHaveBeenCalled();
    expect(result.amiId).toBe("ami-snap-1");
    expect(result.instanceId).toBe("i-1");
  });

  it("falls back to ImportImage when snapshot path fails and fallback is enabled", async () => {
    const mockClient = {
      importSnapshot: vi.fn(async () => {
        throw new Error("Snapshot import unsupported for this guest");
      }),
      describeImportSnapshotTasks: vi.fn(async () => []),
      registerImageFromSnapshot: vi.fn(async () => "ami-snap-1"),
      importImage: vi.fn(async () => "import-image-1"),
      describeImportTasks: vi.fn(async () => [{
        importTaskId: "import-image-1",
        status: "completed",
        imageId: "ami-image-1",
      }]),
      describeImages: vi.fn(async () => []),
      launchInstance: vi.fn(async () => ({
        instanceId: "i-2",
        privateIp: "10.0.0.20",
      })),
      headObject: vi.fn(async () => ({ exists: true, size: 1024 * 1024 })),
    } as unknown as AWSClient;

    const importer = new AWSImporter(mockClient, "migration-bucket", "vclaw/");
    const result = await importer.importVM(
      {
        vmConfig,
        diskPath: "/dev/pve/vm-101-disk-0",
        diskFormat: "raw",
        importMode: "auto",
        fallbackToImportImage: true,
      },
      "192.168.86.50",
      "root",
    );

    expect((mockClient as unknown as { importSnapshot: ReturnType<typeof vi.fn> }).importSnapshot)
      .toHaveBeenCalledTimes(1);
    expect((mockClient as unknown as { importImage: ReturnType<typeof vi.fn> }).importImage)
      .toHaveBeenCalledTimes(1);
    expect(result.amiId).toBe("ami-image-1");
  });

  it("uses ImportImage path when importMode=image", async () => {
    const mockClient = {
      importSnapshot: vi.fn(async () => "import-snap-1"),
      describeImportSnapshotTasks: vi.fn(async () => []),
      registerImageFromSnapshot: vi.fn(async () => "ami-snap-1"),
      importImage: vi.fn(async () => "import-image-9"),
      describeImportTasks: vi.fn(async () => [{
        importTaskId: "import-image-9",
        status: "completed",
        imageId: "ami-image-9",
      }]),
      describeImages: vi.fn(async () => []),
      launchInstance: vi.fn(async () => ({
        instanceId: "i-9",
        privateIp: "10.0.0.90",
      })),
      headObject: vi.fn(async () => ({ exists: true, size: 1024 * 1024 })),
    } as unknown as AWSClient;

    const importer = new AWSImporter(mockClient, "migration-bucket", "vclaw/");
    const result = await importer.importVM(
      {
        vmConfig,
        diskPath: "/tmp/disk.vmdk",
        diskFormat: "vmdk",
        importMode: "image",
      },
      "192.168.86.50",
      "root",
    );

    expect((mockClient as unknown as { importSnapshot: ReturnType<typeof vi.fn> }).importSnapshot)
      .not.toHaveBeenCalled();
    expect((mockClient as unknown as { importImage: ReturnType<typeof vi.fn> }).importImage)
      .toHaveBeenCalledTimes(1);
    expect(result.amiId).toBe("ami-image-9");
  });
});
