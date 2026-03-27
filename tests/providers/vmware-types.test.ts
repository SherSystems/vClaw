import { describe, it, expect } from "vitest";
import type {
  VmSummary,
  VmInfo,
  VmPowerState,
  VmHardware,
  VmDiskInfo,
  VmNicInfo,
  VmCdromInfo,
  HostSummary,
  HostInfo,
  HostConnectionState,
  HostPowerState,
  DatastoreSummary,
  DatastoreInfo,
  DatastoreType,
  NetworkSummary,
  NetworkType,
  ClusterSummary,
  ClusterInfo,
  ResourcePoolSummary,
  SnapshotSummary,
  SnapshotInfo,
  GuestInfo,
  GuestOS,
  VmCreateSpec,
} from "../../src/providers/vmware/types.js";

describe("VMware Types — Shape Validation", () => {
  // ── Power State ──────────────────────────────────────────

  it("VmPowerState has all expected values", () => {
    const states: VmPowerState[] = ["POWERED_ON", "POWERED_OFF", "SUSPENDED"];
    expect(states).toHaveLength(3);
  });

  it("HostConnectionState has all expected values", () => {
    const states: HostConnectionState[] = ["CONNECTED", "DISCONNECTED", "NOT_RESPONDING"];
    expect(states).toHaveLength(3);
  });

  it("HostPowerState has all expected values", () => {
    const states: HostPowerState[] = ["POWERED_ON", "POWERED_OFF", "STANDBY"];
    expect(states).toHaveLength(3);
  });

  it("DatastoreType has all expected values", () => {
    const types: DatastoreType[] = ["VMFS", "NFS", "NFS41", "CIFS", "VSAN", "VFFS", "VVOL"];
    expect(types).toHaveLength(7);
  });

  it("NetworkType has all expected values", () => {
    const types: NetworkType[] = [
      "STANDARD_PORTGROUP",
      "DISTRIBUTED_PORTGROUP",
      "OPAQUE_NETWORK",
      "NSX_NETWORK",
    ];
    expect(types).toHaveLength(4);
  });

  // ── VmSummary ────────────────────────────────────────────

  it("VmSummary shape is correct", () => {
    const vm: VmSummary = {
      vm: "vm-42",
      name: "test-vm",
      power_state: "POWERED_ON",
      cpu_count: 4,
      memory_size_MiB: 8192,
    };
    expect(vm.vm).toBe("vm-42");
    expect(vm.name).toBe("test-vm");
    expect(vm.power_state).toBe("POWERED_ON");
    expect(vm.cpu_count).toBe(4);
    expect(vm.memory_size_MiB).toBe(8192);
  });

  it("VmSummary allows optional cpu_count and memory_size_MiB", () => {
    const vm: VmSummary = {
      vm: "vm-1",
      name: "minimal",
      power_state: "POWERED_OFF",
    };
    expect(vm.cpu_count).toBeUndefined();
    expect(vm.memory_size_MiB).toBeUndefined();
  });

  // ── VmInfo ───────────────────────────────────────────────

  it("VmInfo shape is correct with full structure", () => {
    const info: VmInfo = {
      name: "production-web",
      power_state: "POWERED_ON",
      cpu: {
        count: 8,
        cores_per_socket: 4,
        hot_add_enabled: true,
        hot_remove_enabled: false,
      },
      memory: {
        size_MiB: 16384,
        hot_add_enabled: true,
      },
      hardware: {
        upgrade_policy: "AFTER_CLEAN_SHUTDOWN",
        upgrade_status: "NONE",
        version: "VMX_21",
      },
      guest_OS: "UBUNTU_64",
      disks: {
        "2000": {
          label: "Hard disk 1",
          type: "SCSI",
          capacity: 107374182400,
          backing: { type: "VMDK_FILE", vmdk_file: "[ds1] vm/disk.vmdk" },
        },
      },
      nics: {
        "4000": {
          label: "Network adapter 1",
          type: "VMXNET3",
          mac_address: "00:50:56:ab:cd:ef",
          mac_type: "ASSIGNED",
          state: "CONNECTED",
          backing: {
            type: "DISTRIBUTED_PORTGROUP",
            network: "dvportgroup-100",
            network_name: "VM Network",
          },
          start_connected: true,
        },
      },
      boot: { type: "BIOS" },
    };
    expect(info.cpu.count).toBe(8);
    expect(info.memory.size_MiB).toBe(16384);
    expect(info.hardware.version).toBe("VMX_21");
    expect(Object.keys(info.disks)).toHaveLength(1);
    expect(Object.keys(info.nics)).toHaveLength(1);
  });

  // ── HostSummary ──────────────────────────────────────────

  it("HostSummary shape is correct", () => {
    const host: HostSummary = {
      host: "host-10",
      name: "esxi-01.lab.local",
      connection_state: "CONNECTED",
      power_state: "POWERED_ON",
    };
    expect(host.host).toBe("host-10");
    expect(host.connection_state).toBe("CONNECTED");
  });

  it("HostInfo shape is correct", () => {
    const info: HostInfo = {
      name: "esxi-01.lab.local",
      connection_state: "CONNECTED",
      power_state: "POWERED_ON",
    };
    expect(info.name).toBe("esxi-01.lab.local");
  });

  // ── DatastoreSummary ─────────────────────────────────────

  it("DatastoreSummary shape is correct", () => {
    const ds: DatastoreSummary = {
      datastore: "datastore-15",
      name: "vsanDatastore",
      type: "VSAN",
      free_space: 1099511627776,
      capacity: 2199023255552,
    };
    expect(ds.datastore).toBe("datastore-15");
    expect(ds.type).toBe("VSAN");
    expect(ds.capacity).toBe(2199023255552);
  });

  it("DatastoreInfo shape is correct", () => {
    const info: DatastoreInfo = {
      name: "localDS",
      type: "VMFS",
      accessible: true,
      free_space: 500000000000,
      capacity: 1000000000000,
      thin_provisioning_supported: true,
    };
    expect(info.accessible).toBe(true);
    expect(info.thin_provisioning_supported).toBe(true);
  });

  // ── NetworkSummary ───────────────────────────────────────

  it("NetworkSummary shape is correct", () => {
    const net: NetworkSummary = {
      network: "network-20",
      name: "VM Network",
      type: "STANDARD_PORTGROUP",
    };
    expect(net.network).toBe("network-20");
    expect(net.type).toBe("STANDARD_PORTGROUP");
  });

  // ── ClusterSummary ───────────────────────────────────────

  it("ClusterSummary shape is correct", () => {
    const cluster: ClusterSummary = {
      cluster: "domain-c8",
      name: "Production Cluster",
      ha_enabled: true,
      drs_enabled: true,
    };
    expect(cluster.ha_enabled).toBe(true);
    expect(cluster.drs_enabled).toBe(true);
  });

  it("ClusterInfo shape is correct", () => {
    const info: ClusterInfo = {
      name: "Production Cluster",
      resource_pool: "resgroup-10",
    };
    expect(info.resource_pool).toBe("resgroup-10");
  });

  // ── ResourcePoolSummary ──────────────────────────────────

  it("ResourcePoolSummary shape is correct", () => {
    const rp: ResourcePoolSummary = {
      resource_pool: "resgroup-10",
      name: "Resources",
    };
    expect(rp.resource_pool).toBe("resgroup-10");
  });

  // ── SnapshotSummary ──────────────────────────────────────

  it("SnapshotSummary shape is correct", () => {
    const snap: SnapshotSummary = {
      snapshot: "snapshot-1",
      name: "before-upgrade",
      description: "Snapshot before OS upgrade",
      create_time: "2024-01-15T10:00:00Z",
      power_state: "POWERED_ON",
    };
    expect(snap.snapshot).toBe("snapshot-1");
    expect(snap.power_state).toBe("POWERED_ON");
  });

  it("SnapshotInfo wraps an array of summaries", () => {
    const info: SnapshotInfo = {
      snapshots: [
        {
          snapshot: "snapshot-1",
          name: "snap1",
          description: "first",
        },
        {
          snapshot: "snapshot-2",
          name: "snap2",
          description: "second",
          parent: "snapshot-1",
        },
      ],
    };
    expect(info.snapshots).toHaveLength(2);
    expect(info.snapshots[1].parent).toBe("snapshot-1");
  });

  // ── GuestInfo ────────────────────────────────────────────

  it("GuestInfo shape is correct", () => {
    const guest: GuestInfo = {
      os_family: "LINUX",
      full_name: "Ubuntu Linux (64-bit)",
      host_name: "web-01",
      ip_address: "10.0.0.42",
      name: "UBUNTU_64",
    };
    expect(guest.ip_address).toBe("10.0.0.42");
    expect(guest.os_family).toBe("LINUX");
  });

  it("GuestInfo allows all optional fields", () => {
    const guest: GuestInfo = {};
    expect(guest.os_family).toBeUndefined();
    expect(guest.ip_address).toBeUndefined();
  });

  // ── VmCreateSpec ─────────────────────────────────────────

  it("VmCreateSpec minimal shape is correct", () => {
    const spec: VmCreateSpec = {
      name: "new-vm",
      guest_OS: "OTHER_LINUX_64",
    };
    expect(spec.name).toBe("new-vm");
    expect(spec.guest_OS).toBe("OTHER_LINUX_64");
  });

  it("VmCreateSpec full shape with placement and hardware", () => {
    const spec: VmCreateSpec = {
      name: "full-vm",
      guest_OS: "UBUNTU_64",
      placement: {
        folder: "group-v3",
        resource_pool: "resgroup-10",
        host: "host-10",
        cluster: "domain-c8",
        datastore: "datastore-15",
      },
      cpu: {
        count: 4,
        cores_per_socket: 2,
        hot_add_enabled: true,
        hot_remove_enabled: false,
      },
      memory: {
        size_MiB: 8192,
        hot_add_enabled: true,
      },
      disks: [
        {
          new_vmdk: { capacity: 107374182400, name: "disk1" },
        },
      ],
      nics: [
        {
          type: "VMXNET3",
          backing: { type: "STANDARD_PORTGROUP", network: "network-20" },
          start_connected: true,
          allow_guest_control: true,
        },
      ],
      boot: {
        type: "EFI",
        delay: 5000,
        enter_setup_mode: false,
      },
    };
    expect(spec.placement?.cluster).toBe("domain-c8");
    expect(spec.cpu?.count).toBe(4);
    expect(spec.memory?.size_MiB).toBe(8192);
    expect(spec.disks).toHaveLength(1);
    expect(spec.nics).toHaveLength(1);
    expect(spec.boot?.type).toBe("EFI");
  });

  // ── VmHardware ───────────────────────────────────────────

  it("VmHardware shape is correct", () => {
    const hw: VmHardware = {
      upgrade_policy: "AFTER_CLEAN_SHUTDOWN",
      upgrade_status: "NONE",
      version: "VMX_21",
    };
    expect(hw.version).toBe("VMX_21");
  });
});
