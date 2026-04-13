import { describe, it, expect, vi, beforeEach } from "vitest";
import { VMwareImporter } from "../../src/migration/vmware-importer.js";
import type { VSphereClient } from "../../src/providers/vmware/client.js";
import type { MigrationVMConfig, SSHExecFn, SSHExecResult } from "../../src/migration/types.js";

const testConfig: MigrationVMConfig = {
  name: "migrated-to-vmware",
  cpuCount: 2,
  coresPerSocket: 2,
  memoryMiB: 4096,
  guestOS: "OTHER_LINUX_64",
  disks: [
    {
      label: "scsi0 (local-lvm:vm-112-disk-0)",
      capacityBytes: 10737418240,
      sourcePath: "/dev/pve/vm-112-disk-0",
      sourceFormat: "raw",
      targetFormat: "vmdk",
    },
  ],
  nics: [
    {
      label: "net0",
      macAddress: "BC:24:11:F7:A4:00",
      networkName: "vmbr0",
      adapterType: "virtio",
    },
  ],
  firmware: "bios",
};

describe("VMwareImporter", () => {
  let mockClient: Partial<VSphereClient>;
  let mockSshExec: SSHExecFn;
  let importer: VMwareImporter;

  const ok = (stdout = ""): SSHExecResult => ({ stdout, stderr: "", exitCode: 0 });

  beforeEach(() => {
    mockClient = {
      createVM: vi.fn().mockResolvedValue("vm-99"),
      getVM: vi.fn().mockResolvedValue({
        name: "migrated-to-vmware",
        power_state: "POWERED_OFF",
        cpu: { count: 2, cores_per_socket: 2, hot_add_enabled: false, hot_remove_enabled: false },
        memory: { size_MiB: 4096, hot_add_enabled: false },
        hardware: { upgrade_policy: "manual", upgrade_status: "NONE", version: "vmx-19" },
        guest_OS: "OTHER_LINUX_64",
        disks: {
          "2000": {
            label: "Hard disk 1",
            type: "SCSI",
            capacity: 10737418240,
            backing: {
              type: "VMDK_FILE",
              vmdk_file: "[datastore1] migrated-to-vmware/migrated-to-vmware.vmdk",
            },
          },
        },
        nics: {},
        boot: { type: "BIOS" },
      }),
      listFolders: vi.fn().mockResolvedValue([
        { folder: "group-v4", name: "vm", type: "VIRTUAL_MACHINE" },
      ]),
      listHosts: vi.fn().mockResolvedValue([
        { host: "host-11", name: "192.168.86.37", connection_state: "CONNECTED", power_state: "POWERED_ON" },
      ]),
      listDatastores: vi.fn().mockResolvedValue([
        { datastore: "datastore-14", name: "datastore1", type: "VMFS", free_space: 21882732544, capacity: 77040975872 },
      ]),
      listNetworks: vi.fn().mockResolvedValue([
        { network: "network-15", name: "VM Network", type: "STANDARD_PORTGROUP" },
      ]),
    };

    mockSshExec = vi.fn().mockImplementation((_host: string, _user: string, cmd: string) => {
      // find command returns VM directory path
      if (cmd.includes("find /vmfs")) {
        return Promise.resolve(ok("/vmfs/volumes/datastore1/migrated-to-vmware"));
      }
      // vim-cmd getallvms returns VM listing with ESXi VMID
      if (cmd.includes("getallvms")) {
        return Promise.resolve(ok("Vmid  Name                 File                 Guest OS\n18    migrated-to-vmware   [datastore1] migrated-to-vmware/migrated-to-vmware.vmx   otherLinux64Guest"));
      }
      return Promise.resolve(ok());
    });
    importer = new VMwareImporter(mockClient as VSphereClient, mockSshExec);
  });

  describe("resolveDefaults", () => {
    it("should resolve folder, host, datastore, and network", async () => {
      const defaults = await importer.resolveDefaults();

      expect(defaults.folderId).toBe("group-v4");
      expect(defaults.hostId).toBe("host-11");
      expect(defaults.datastoreId).toBe("datastore-14");
      expect(defaults.datastoreName).toBe("datastore1");
      expect(defaults.networkId).toBe("network-15");
    });

    it("should throw if no VM folder found", async () => {
      (mockClient.listFolders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await expect(importer.resolveDefaults()).rejects.toThrow("No VM folder found");
    });

    it("should throw if no connected host", async () => {
      (mockClient.listHosts as ReturnType<typeof vi.fn>).mockResolvedValue([
        { host: "host-11", name: "esxi-01", connection_state: "DISCONNECTED" },
      ]);

      await expect(importer.resolveDefaults()).rejects.toThrow("No connected ESXi host");
    });

    it("should throw if no datastore", async () => {
      (mockClient.listDatastores as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await expect(importer.resolveDefaults()).rejects.toThrow("No datastore found");
    });

    it("should throw if no network", async () => {
      (mockClient.listNetworks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await expect(importer.resolveDefaults()).rejects.toThrow("No network found");
    });
  });

  describe("importVM", () => {
    it("should find VM directory on ESXi after creation", async () => {
      await importer.importVM(
        {
          config: testConfig,
          vmdkPath: "/tmp/disk.vmdk",
          esxiHost: "192.168.86.37",
          datastoreId: "datastore-14",
          datastoreName: "datastore1",
          hostId: "host-11",
          folderId: "group-v4",
        },
        "192.168.86.50"
      );

      // Should SSH to Proxmox which SSHes to ESXi to find the VM directory
      const findCall = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: string[]) => c[2].includes("find /vmfs")
      );
      expect(findCall).toBeDefined();
      expect(findCall![2]).toContain("migrated-to-vmware");
    });

    it("should SCP vmdk from Proxmox to ESXi", async () => {
      await importer.importVM(
        {
          config: testConfig,
          vmdkPath: "/tmp/disk.vmdk",
          esxiHost: "192.168.86.37",
          datastoreId: "datastore-14",
          datastoreName: "datastore1",
          hostId: "host-11",
          folderId: "group-v4",
        },
        "192.168.86.50"
      );

      const scpCall = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: string[]) => c[2].includes("scp")
      );
      expect(scpCall).toBeDefined();
      expect(scpCall![2]).toContain("root@192.168.86.37:");
    });

    it("should convert vmdk with vmkfstools on ESXi", async () => {
      await importer.importVM(
        {
          config: testConfig,
          vmdkPath: "/tmp/disk.vmdk",
          esxiHost: "192.168.86.37",
          datastoreId: "datastore-14",
          datastoreName: "datastore1",
          hostId: "host-11",
          folderId: "group-v4",
        },
        "192.168.86.50"
      );

      const vmkfstoolsCall = (mockSshExec as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: string[]) => c[2].includes("vmkfstools")
      );
      expect(vmkfstoolsCall).toBeDefined();
      expect(vmkfstoolsCall![2]).toContain("-d thin");
    });

    it("should create VM via vSphere API", async () => {
      await importer.importVM(
        {
          config: testConfig,
          vmdkPath: "/tmp/disk.vmdk",
          esxiHost: "192.168.86.37",
          datastoreId: "datastore-14",
          datastoreName: "datastore1",
          hostId: "host-11",
          folderId: "group-v4",
        },
        "192.168.86.50"
      );

      expect(mockClient.createVM).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "migrated-to-vmware",
          guest_OS: "OTHER_LINUX_64",
          placement: expect.objectContaining({
            folder: "group-v4",
            host: "host-11",
            datastore: "datastore-14",
          }),
          cpu: { count: 2, cores_per_socket: 2 },
          memory: { size_MiB: 4096 },
        })
      );
    });

    it("should return vmId and host info", async () => {
      const result = await importer.importVM(
        {
          config: testConfig,
          vmdkPath: "/tmp/disk.vmdk",
          esxiHost: "192.168.86.37",
          datastoreId: "datastore-14",
          datastoreName: "datastore1",
          hostId: "host-11",
          folderId: "group-v4",
        },
        "192.168.86.50"
      );

      expect(result.vmId).toBe("vm-99");
      expect(result.hostId).toBe("host-11");
      expect(result.datastoreName).toBe("datastore1");
    });

    it("should throw on SCP failure", async () => {
      // find ok, scp fails
      (mockSshExec as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ok("/vmfs/volumes/datastore1/migrated-to-vmware")) // find
        .mockResolvedValueOnce({ stdout: "", stderr: "Connection refused", exitCode: 1 }); // scp

      await expect(
        importer.importVM(
          {
            config: testConfig,
            vmdkPath: "/tmp/disk.vmdk",
            esxiHost: "192.168.86.37",
            datastoreId: "datastore-14",
            datastoreName: "datastore1",
            hostId: "host-11",
            folderId: "group-v4",
          },
          "192.168.86.50"
        )
      ).rejects.toThrow("Failed to transfer vmdk to ESXi");
    });
  });
});
