import { describe, it, expect, beforeEach, vi } from "vitest";
import { VMwareAdapter } from "../../src/providers/vmware/adapter.js";

// Mock the VSphereClient
vi.mock("../../src/providers/vmware/client.js", () => {
  const mockClient = {
    createSession: vi.fn().mockResolvedValue("session-token"),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    listVMs: vi.fn().mockResolvedValue([
      { vm: "vm-42", name: "web-01", power_state: "POWERED_ON", cpu_count: 4, memory_size_MiB: 8192 },
      { vm: "vm-43", name: "db-01", power_state: "POWERED_OFF", cpu_count: 8, memory_size_MiB: 16384 },
    ]),
    getVM: vi.fn().mockResolvedValue({
      name: "web-01",
      power_state: "POWERED_ON",
      cpu: { count: 4, cores_per_socket: 2, hot_add_enabled: true, hot_remove_enabled: false },
      memory: { size_MiB: 8192, hot_add_enabled: false },
      hardware: { upgrade_policy: "NEVER", upgrade_status: "NONE", version: "VMX_21" },
      guest_OS: "UBUNTU_64",
      disks: {},
      nics: {},
      boot: { type: "BIOS" },
    }),
    vmPowerOn: vi.fn().mockResolvedValue(undefined),
    vmPowerOff: vi.fn().mockResolvedValue(undefined),
    vmReset: vi.fn().mockResolvedValue(undefined),
    vmSuspend: vi.fn().mockResolvedValue(undefined),
    listHosts: vi.fn().mockResolvedValue([
      { host: "host-10", name: "esxi-01.lab.local", connection_state: "CONNECTED", power_state: "POWERED_ON" },
    ]),
    getHost: vi.fn().mockResolvedValue({
      name: "esxi-01.lab.local",
      connection_state: "CONNECTED",
      power_state: "POWERED_ON",
    }),
    listDatastores: vi.fn().mockResolvedValue([
      { datastore: "datastore-15", name: "localDS", type: "VMFS", free_space: 500000000000, capacity: 1000000000000 },
    ]),
    getDatastore: vi.fn().mockResolvedValue({
      name: "localDS",
      type: "VMFS",
      accessible: true,
      free_space: 500000000000,
      capacity: 1000000000000,
      thin_provisioning_supported: true,
    }),
    listNetworks: vi.fn().mockResolvedValue([
      { network: "network-20", name: "VM Network", type: "STANDARD_PORTGROUP" },
    ]),
    listClusters: vi.fn().mockResolvedValue([
      { cluster: "domain-c8", name: "Production", ha_enabled: true, drs_enabled: true },
    ]),
    getCluster: vi.fn().mockResolvedValue({
      name: "Production",
      resource_pool: "resgroup-10",
    }),
    listResourcePools: vi.fn().mockResolvedValue([
      { resource_pool: "resgroup-10", name: "Resources" },
    ]),
    getVMGuest: vi.fn().mockResolvedValue({
      os_family: "LINUX",
      full_name: "Ubuntu Linux (64-bit)",
      host_name: "web-01",
      ip_address: "10.0.0.42",
      name: "UBUNTU_64",
    }),
    listSnapshots: vi.fn().mockResolvedValue([
      { snapshot: "snap-1", name: "before-upgrade", description: "Pre-upgrade" },
    ]),
    createSnapshot: vi.fn().mockResolvedValue("snap-new"),
    deleteSnapshot: vi.fn().mockResolvedValue(undefined),
    revertSnapshot: vi.fn().mockResolvedValue(undefined),
    createVM: vi.fn().mockResolvedValue("vm-100"),
    deleteVM: vi.fn().mockResolvedValue(undefined),
  };

  return {
    VSphereClient: vi.fn().mockImplementation(function () { return mockClient; }),
    __mockClient: mockClient,
  };
});

// Get the mock client for assertions
async function getMockClient() {
  const mod = await import("../../src/providers/vmware/client.js");
  return (mod as unknown as { __mockClient: Record<string, ReturnType<typeof vi.fn>> }).__mockClient;
}

const defaultConfig = {
  host: "vcenter.lab.local",
  user: "administrator@vsphere.local",
  password: "VMware1!",
  insecure: true,
};

describe("VMwareAdapter", () => {
  let adapter: VMwareAdapter;

  beforeEach(() => {
    adapter = new VMwareAdapter(defaultConfig);
  });

  // ── Lifecycle ───────────────────────────────────────────

  describe("connect/disconnect/isConnected", () => {
    it("connect() calls createSession", async () => {
      const mc = await getMockClient();
      await adapter.connect();
      expect(mc.createSession).toHaveBeenCalledOnce();
      expect(adapter.isConnected()).toBe(true);
    });

    it("disconnect() calls deleteSession", async () => {
      const mc = await getMockClient();
      await adapter.connect();
      await adapter.disconnect();
      expect(mc.deleteSession).toHaveBeenCalledOnce();
      expect(adapter.isConnected()).toBe(false);
    });

    it("isConnected() returns false before connect", () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it("adapter name is vmware", () => {
      expect(adapter.name).toBe("vmware");
    });
  });

  // ── Tool Definitions ────────────────────────────────────

  describe("getTools", () => {
    it("returns all tool definitions", () => {
      const tools = adapter.getTools();
      expect(tools.length).toBeGreaterThanOrEqual(18);
    });

    it("all tools have adapter set to vmware", () => {
      const tools = adapter.getTools();
      for (const tool of tools) {
        expect(tool.adapter).toBe("vmware");
      }
    });

    it("read tools have correct tier", () => {
      const tools = adapter.getTools();
      const readTools = tools.filter((t) => t.tier === "read");
      const readNames = readTools.map((t) => t.name);
      expect(readNames).toContain("vmware_list_vms");
      expect(readNames).toContain("vmware_get_vm");
      expect(readNames).toContain("vmware_list_hosts");
      expect(readNames).toContain("vmware_get_host");
      expect(readNames).toContain("vmware_list_datastores");
      expect(readNames).toContain("vmware_get_datastore");
      expect(readNames).toContain("vmware_list_networks");
      expect(readNames).toContain("vmware_list_clusters");
      expect(readNames).toContain("vmware_list_resource_pools");
      expect(readNames).toContain("vmware_get_vm_guest");
      expect(readNames).toContain("vmware_list_snapshots");
    });

    it("safe_write tools have correct tier", () => {
      const tools = adapter.getTools();
      const safeWriteTools = tools.filter((t) => t.tier === "safe_write");
      const names = safeWriteTools.map((t) => t.name);
      expect(names).toContain("vmware_vm_power_on");
      expect(names).toContain("vmware_create_snapshot");
    });

    it("risky_write tools have correct tier", () => {
      const tools = adapter.getTools();
      const riskyTools = tools.filter((t) => t.tier === "risky_write");
      const names = riskyTools.map((t) => t.name);
      expect(names).toContain("vmware_vm_power_off");
      expect(names).toContain("vmware_vm_reset");
      expect(names).toContain("vmware_vm_suspend");
      expect(names).toContain("vmware_create_vm");
      expect(names).toContain("vmware_delete_snapshot");
      expect(names).toContain("vmware_revert_snapshot");
    });

    it("destructive tools have correct tier", () => {
      const tools = adapter.getTools();
      const destructive = tools.filter((t) => t.tier === "destructive");
      const names = destructive.map((t) => t.name);
      expect(names).toContain("vmware_delete_vm");
    });

    it("each tool has a description", () => {
      const tools = adapter.getTools();
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });

    it("each tool has a returns type", () => {
      const tools = adapter.getTools();
      for (const tool of tools) {
        expect(tool.returns.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Execute — Read Tools ────────────────────────────────

  describe("execute — read tools", () => {
    it("vmware_list_vms calls client.listVMs", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_list_vms", {});
      expect(result.success).toBe(true);
      expect(mc.listVMs).toHaveBeenCalled();
      expect(result.data).toHaveLength(2);
    });

    it("vmware_list_vms passes filter params", async () => {
      const mc = await getMockClient();
      await adapter.execute("vmware_list_vms", {
        filter_names: "web-01",
        filter_power_states: "POWERED_ON",
      });
      expect(mc.listVMs).toHaveBeenCalledWith({
        "filter.names": "web-01",
        "filter.power_states": "POWERED_ON",
      });
    });

    it("vmware_get_vm calls client.getVM", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_get_vm", { vm_id: "vm-42" });
      expect(result.success).toBe(true);
      expect(mc.getVM).toHaveBeenCalledWith("vm-42");
    });

    it("vmware_list_hosts calls client.listHosts", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_list_hosts", {});
      expect(result.success).toBe(true);
      expect(mc.listHosts).toHaveBeenCalled();
    });

    it("vmware_get_host calls client.getHost", async () => {
      const mc = await getMockClient();
      await adapter.execute("vmware_get_host", { host_id: "host-10" });
      expect(mc.getHost).toHaveBeenCalledWith("host-10");
    });

    it("vmware_list_datastores calls client.listDatastores", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_list_datastores", {});
      expect(result.success).toBe(true);
      expect(mc.listDatastores).toHaveBeenCalled();
    });

    it("vmware_get_datastore calls client.getDatastore", async () => {
      const mc = await getMockClient();
      await adapter.execute("vmware_get_datastore", { datastore_id: "datastore-15" });
      expect(mc.getDatastore).toHaveBeenCalledWith("datastore-15");
    });

    it("vmware_list_networks calls client.listNetworks", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_list_networks", {});
      expect(result.success).toBe(true);
      expect(mc.listNetworks).toHaveBeenCalled();
    });

    it("vmware_list_clusters calls client.listClusters", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_list_clusters", {});
      expect(result.success).toBe(true);
      expect(mc.listClusters).toHaveBeenCalled();
    });

    it("vmware_list_resource_pools calls client.listResourcePools", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_list_resource_pools", {});
      expect(result.success).toBe(true);
      expect(mc.listResourcePools).toHaveBeenCalled();
    });

    it("vmware_get_vm_guest calls client.getVMGuest", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_get_vm_guest", { vm_id: "vm-42" });
      expect(result.success).toBe(true);
      expect(mc.getVMGuest).toHaveBeenCalledWith("vm-42");
      expect((result.data as Record<string, unknown>).ip_address).toBe("10.0.0.42");
    });

    it("vmware_list_snapshots calls client.listSnapshots", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_list_snapshots", { vm_id: "vm-42" });
      expect(result.success).toBe(true);
      expect(mc.listSnapshots).toHaveBeenCalledWith("vm-42");
    });
  });

  // ── Execute — Write Tools ───────────────────────────────

  describe("execute — write tools", () => {
    it("vmware_vm_power_on calls client.vmPowerOn", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_vm_power_on", { vm_id: "vm-42" });
      expect(result.success).toBe(true);
      expect(mc.vmPowerOn).toHaveBeenCalledWith("vm-42");
    });

    it("vmware_vm_power_off calls client.vmPowerOff", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_vm_power_off", { vm_id: "vm-42" });
      expect(result.success).toBe(true);
      expect(mc.vmPowerOff).toHaveBeenCalledWith("vm-42");
    });

    it("vmware_vm_reset calls client.vmReset", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_vm_reset", { vm_id: "vm-42" });
      expect(result.success).toBe(true);
      expect(mc.vmReset).toHaveBeenCalledWith("vm-42");
    });

    it("vmware_vm_suspend calls client.vmSuspend", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_vm_suspend", { vm_id: "vm-42" });
      expect(result.success).toBe(true);
      expect(mc.vmSuspend).toHaveBeenCalledWith("vm-42");
    });

    it("vmware_create_snapshot calls client.createSnapshot", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_create_snapshot", {
        vm_id: "vm-42",
        name: "test-snap",
        description: "Test",
        memory: true,
      });
      expect(result.success).toBe(true);
      expect(mc.createSnapshot).toHaveBeenCalledWith("vm-42", "test-snap", "Test", true);
      expect(result.data).toBe("snap-new");
    });

    it("vmware_delete_snapshot calls client.deleteSnapshot", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_delete_snapshot", {
        vm_id: "vm-42",
        snapshot_id: "snap-1",
      });
      expect(result.success).toBe(true);
      expect(mc.deleteSnapshot).toHaveBeenCalledWith("vm-42", "snap-1");
    });

    it("vmware_revert_snapshot calls client.revertSnapshot", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_revert_snapshot", {
        vm_id: "vm-42",
        snapshot_id: "snap-1",
      });
      expect(result.success).toBe(true);
      expect(mc.revertSnapshot).toHaveBeenCalledWith("vm-42", "snap-1");
    });

    it("vmware_create_vm calls client.createVM with spec", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_create_vm", {
        name: "new-vm",
        guest_OS: "OTHER_LINUX_64",
        cpu_count: 4,
        memory_MiB: 8192,
        datastore: "datastore-15",
      });
      expect(result.success).toBe(true);
      expect(mc.createVM).toHaveBeenCalled();
      const spec = mc.createVM.mock.calls[0][0];
      expect(spec.name).toBe("new-vm");
      expect(spec.guest_OS).toBe("OTHER_LINUX_64");
      expect(spec.cpu.count).toBe(4);
      expect(spec.memory.size_MiB).toBe(8192);
      expect(spec.placement.datastore).toBe("datastore-15");
    });

    it("vmware_delete_vm calls client.deleteVM", async () => {
      const mc = await getMockClient();
      const result = await adapter.execute("vmware_delete_vm", { vm_id: "vm-42" });
      expect(result.success).toBe(true);
      expect(mc.deleteVM).toHaveBeenCalledWith("vm-42");
    });
  });

  // ── Execute — Error Handling ────────────────────────────

  describe("execute — error handling", () => {
    it("returns error for unknown tool", async () => {
      const result = await adapter.execute("vmware_nonexistent", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });

    it("returns error when client throws", async () => {
      const mc = await getMockClient();
      mc.getVM.mockRejectedValueOnce(new Error("VM not found"));
      const result = await adapter.execute("vmware_get_vm", { vm_id: "vm-999" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("VM not found");
    });

    it("strips internal params starting with _", async () => {
      const mc = await getMockClient();
      await adapter.execute("vmware_list_vms", { _internal: true });
      // Should not throw and listVMs should be called with no filter
      expect(mc.listVMs).toHaveBeenCalledWith(undefined);
    });

    it("handles non-Error throws gracefully", async () => {
      const mc = await getMockClient();
      mc.listHosts.mockRejectedValueOnce("string error");
      const result = await adapter.execute("vmware_list_hosts", {});
      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });
  });

  // ── Cluster State ───────────────────────────────────────

  describe("getClusterState", () => {
    it("returns correct ClusterState shape", async () => {
      const state = await adapter.getClusterState();
      expect(state.adapter).toBe("vmware");
      expect(state.timestamp).toBeDefined();
      expect(Array.isArray(state.nodes)).toBe(true);
      expect(Array.isArray(state.vms)).toBe(true);
      expect(Array.isArray(state.containers)).toBe(true);
      expect(Array.isArray(state.storage)).toBe(true);
    });

    it("maps hosts to NodeInfo", async () => {
      const state = await adapter.getClusterState();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].id).toBe("host-10");
      expect(state.nodes[0].name).toBe("esxi-01.lab.local");
      expect(state.nodes[0].status).toBe("online");
    });

    it("maps VMs to VMInfo", async () => {
      const state = await adapter.getClusterState();
      expect(state.vms).toHaveLength(2);
      expect(state.vms[0].id).toBe("vm-42");
      expect(state.vms[0].name).toBe("web-01");
      expect(state.vms[0].status).toBe("running");
      expect(state.vms[0].cpu_cores).toBe(4);
      expect(state.vms[0].ram_mb).toBe(8192);
      expect(state.vms[1].status).toBe("stopped");
    });

    it("maps datastores to StorageInfo", async () => {
      const state = await adapter.getClusterState();
      expect(state.storage).toHaveLength(1);
      expect(state.storage[0].id).toBe("datastore-15");
      expect(state.storage[0].type).toBe("VMFS");
      expect(state.storage[0].total_gb).toBeCloseTo(931.3, 0);
      expect(state.storage[0].available_gb).toBeCloseTo(465.7, 0);
    });

    it("containers array is always empty for VMware", async () => {
      const state = await adapter.getClusterState();
      expect(state.containers).toEqual([]);
    });

    it("maps DISCONNECTED host to offline status", async () => {
      const mc = await getMockClient();
      mc.listHosts.mockResolvedValueOnce([
        { host: "host-20", name: "esxi-02", connection_state: "DISCONNECTED" },
      ]);
      const state = await adapter.getClusterState();
      expect(state.nodes[0].status).toBe("offline");
    });

    it("maps NOT_RESPONDING host to offline status", async () => {
      const mc = await getMockClient();
      mc.listHosts.mockResolvedValueOnce([
        { host: "host-30", name: "esxi-03", connection_state: "NOT_RESPONDING" },
      ]);
      const state = await adapter.getClusterState();
      expect(state.nodes[0].status).toBe("offline");
    });

    it("maps SUSPENDED VM to paused status", async () => {
      const mc = await getMockClient();
      mc.listVMs.mockResolvedValueOnce([
        { vm: "vm-50", name: "suspended-vm", power_state: "SUSPENDED", cpu_count: 2, memory_size_MiB: 4096 },
      ]);
      const state = await adapter.getClusterState();
      expect(state.vms[0].status).toBe("paused");
    });
  });
});
