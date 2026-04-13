import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProxmoxExporter } from "../../src/migration/proxmox-exporter.js";
import type { ProxmoxClient, ProxmoxVMConfig } from "../../src/providers/proxmox/client.js";
import type { SSHExecFn, SSHExecResult } from "../../src/migration/types.js";

const mockConfig: ProxmoxVMConfig = {
  name: "test-vm",
  memory: 4096,
  cores: 2,
  sockets: 1,
  cpu: "host",
  ostype: "l26",
  bios: "seabios",
  scsihw: "virtio-scsi-single",
  scsi0: "local-lvm:vm-112-disk-0,size=10G",
  net0: "virtio=BC:24:11:F7:A4:00,bridge=vmbr0",
  boot: "order=scsi0;net0",
  agent: "1",
};

describe("ProxmoxExporter", () => {
  let mockClient: Partial<ProxmoxClient>;
  let mockSshExec: SSHExecFn;
  let exporter: ProxmoxExporter;

  const ok = (stdout = ""): SSHExecResult => ({ stdout, stderr: "", exitCode: 0 });

  beforeEach(() => {
    mockClient = {
      getVMConfig: vi.fn().mockResolvedValue(mockConfig),
    };
    mockSshExec = vi.fn().mockImplementation(
      (_host: string, _user: string, cmd: string): Promise<SSHExecResult> => {
        if (cmd.includes("lvs")) {
          return Promise.resolve(ok("  /dev/pve/vm-112-disk-0"));
        }
        if (cmd.includes("pvesm path")) {
          return Promise.resolve(ok("/var/lib/vz/images/112/vm-112-disk-0.qcow2"));
        }
        return Promise.resolve(ok());
      }
    );
    exporter = new ProxmoxExporter(mockClient as ProxmoxClient, mockSshExec);
  });

  describe("exportVM", () => {
    it("should export VM config with correct fields", async () => {
      const result = await exporter.exportVM("pranavlab", 112, "192.168.86.50");

      expect(mockClient.getVMConfig).toHaveBeenCalledWith("pranavlab", 112);
      expect(result.vmConfig.name).toBe("test-vm");
      expect(result.vmConfig.cpuCount).toBe(2);
      expect(result.vmConfig.memoryMiB).toBe(4096);
      expect(result.vmConfig.firmware).toBe("bios");
      expect(result.vmConfig.guestOS).toBe("OTHER_LINUX_64");
      expect(result.node).toBe("pranavlab");
    });

    it("should extract disk from LVM storage", async () => {
      const result = await exporter.exportVM("pranavlab", 112, "192.168.86.50");

      expect(result.vmConfig.disks).toHaveLength(1);
      expect(result.vmConfig.disks[0].sourcePath).toBe("/dev/pve/vm-112-disk-0");
      expect(result.vmConfig.disks[0].sourceFormat).toBe("raw");
      expect(result.vmConfig.disks[0].targetFormat).toBe("vmdk");
      expect(result.vmConfig.disks[0].capacityBytes).toBe(10737418240); // 10G
    });

    it("should extract NIC info", async () => {
      const result = await exporter.exportVM("pranavlab", 112, "192.168.86.50");

      expect(result.vmConfig.nics).toHaveLength(1);
      expect(result.vmConfig.nics[0].macAddress).toBe("BC:24:11:F7:A4:00");
      expect(result.vmConfig.nics[0].adapterType).toBe("virtio");
      expect(result.vmConfig.nics[0].networkName).toBe("vmbr0");
    });

    it("should detect EFI firmware", async () => {
      const efiConfig = { ...mockConfig, bios: "ovmf" };
      (mockClient.getVMConfig as ReturnType<typeof vi.fn>).mockResolvedValue(efiConfig);

      const result = await exporter.exportVM("pranavlab", 112, "192.168.86.50");
      expect(result.vmConfig.firmware).toBe("efi");
    });

    it("should handle VM with no disks", async () => {
      const noDiskConfig: ProxmoxVMConfig = { ...mockConfig };
      delete noDiskConfig.scsi0;
      (mockClient.getVMConfig as ReturnType<typeof vi.fn>).mockResolvedValue(noDiskConfig);

      const result = await exporter.exportVM("pranavlab", 112, "192.168.86.50");
      expect(result.vmConfig.disks).toHaveLength(0);
    });

    it("should skip CD-ROM entries", async () => {
      const cdConfig = { ...mockConfig, ide2: "local:iso/ubuntu.iso,media=cdrom" };
      (mockClient.getVMConfig as ReturnType<typeof vi.fn>).mockResolvedValue(cdConfig);

      const result = await exporter.exportVM("pranavlab", 112, "192.168.86.50");
      expect(result.vmConfig.disks).toHaveLength(1); // only scsi0, not ide2
    });

    it("should handle multiple sockets for total CPU count", async () => {
      const multiSocket = { ...mockConfig, cores: 4, sockets: 2 };
      (mockClient.getVMConfig as ReturnType<typeof vi.fn>).mockResolvedValue(multiSocket);

      const result = await exporter.exportVM("pranavlab", 112, "192.168.86.50");
      expect(result.vmConfig.cpuCount).toBe(8); // 4 cores * 2 sockets
      expect(result.vmConfig.coresPerSocket).toBe(4);
    });

    it("should map Windows ostype correctly", async () => {
      const winConfig = { ...mockConfig, ostype: "win11" };
      (mockClient.getVMConfig as ReturnType<typeof vi.fn>).mockResolvedValue(winConfig);

      const result = await exporter.exportVM("pranavlab", 112, "192.168.86.50");
      expect(result.vmConfig.guestOS).toBe("WINDOWS_11_64");
    });
  });

  describe("convertDiskToVmdk", () => {
    it("should run qemu-img convert with streamOptimized subformat", async () => {
      await exporter.convertDiskToVmdk(
        "192.168.86.50",
        "root",
        "/dev/pve/vm-112-disk-0",
        "/tmp/disk.vmdk",
        "raw"
      );

      expect(mockSshExec).toHaveBeenCalledWith(
        "192.168.86.50",
        "root",
        expect.stringContaining("qemu-img convert"),
        600_000
      );

      const cmd = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: string[]) => c[2].includes("qemu-img convert")
      )![2];
      expect(cmd).toContain("-f raw");
      expect(cmd).toContain("-O vmdk");
      expect(cmd).toContain("streamOptimized");
    });

    it("should throw on conversion failure", async () => {
      (mockSshExec as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        stdout: "",
        stderr: "Permission denied",
        exitCode: 1,
      });

      await expect(
        exporter.convertDiskToVmdk("192.168.86.50", "root", "/dev/pve/vm-112-disk-0", "/tmp/disk.vmdk", "raw")
      ).rejects.toThrow("Failed to convert disk to vmdk");
    });
  });
});
