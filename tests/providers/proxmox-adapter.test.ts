import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProxmoxAdapter } from "../../src/providers/proxmox/adapter.js";

// Mock the ProxmoxClient
vi.mock("../../src/providers/proxmox/client.js", () => {
  const mockClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getNodes: vi.fn().mockResolvedValue([
      {
        node: "pve1",
        status: "online",
        cpu: 0.25,
        maxcpu: 8,
        mem: 8589934592,       // 8 GB
        maxmem: 34359738368,   // 32 GB
        disk: 107374182400,    // 100 GB
        maxdisk: 536870912000, // 500 GB
        uptime: 86400,
        id: "node/pve1",
        type: "node",
      },
    ]),
    getNodeStats: vi.fn().mockResolvedValue({
      node: "pve1",
      status: "online",
      cpu: 0.25,
      maxcpu: 8,
      mem: 8589934592,
      maxmem: 34359738368,
      disk: 107374182400,
      maxdisk: 536870912000,
      uptime: 86400,
      loadavg: [1.0, 0.8, 0.5],
      ksm: {},
      cpuinfo: {},
      memory: {},
      rootfs: {},
      swap: {},
    }),
    getVMs: vi.fn().mockResolvedValue([
      {
        vmid: 100,
        name: "test-vm",
        node: "pve1",
        status: "running",
        mem: 1073741824,
        maxmem: 4294967296,
        cpu: 0.1,
        cpus: 4,
        maxdisk: 34359738368,
        disk: 0,
        netin: 1000,
        netout: 2000,
        uptime: 3600,
        type: "qemu",
      },
    ]),
    getVMStatus: vi.fn().mockResolvedValue({
      vmid: 100,
      name: "test-vm",
      status: "running",
      cpus: 4,
      cpu: 0.1,
      mem: 1073741824,
      maxmem: 4294967296,
      disk: 0,
      maxdisk: 34359738368,
      uptime: 3600,
      ha: {},
    }),
    getVMConfig: vi.fn().mockResolvedValue({
      name: "test-vm",
      memory: 4096,
      cores: 4,
      sockets: 1,
      cpu: "host",
    }),
    startVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:start"),
    stopVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:stop"),
    shutdownVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:shutdown"),
    rebootVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:reboot"),
    resumeVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:resume"),
    createVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:create"),
    createCT: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:create"),
    deleteVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:delete"),
    cloneVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:clone"),
    listSnapshots: vi.fn().mockResolvedValue([
      { name: "snap1", description: "First snapshot", snaptime: 1700000000 },
    ]),
    createSnapshot: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:snap"),
    rollbackSnapshot: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:rollback"),
    deleteSnapshot: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:delsnap"),
    getStorage: vi.fn().mockResolvedValue([
      {
        storage: "local-lvm",
        type: "lvmthin",
        content: "images,rootdir",
        total: 214748364800,
        used: 107374182400,
        avail: 107374182400,
      },
    ]),
    getISOs: vi.fn().mockResolvedValue([]),
    getTemplates: vi.fn().mockResolvedValue([]),
    getTasks: vi.fn().mockResolvedValue([]),
    getTaskStatus: vi.fn().mockResolvedValue({
      status: "stopped",
      exitstatus: "OK",
      type: "qmstart",
      id: "100",
      user: "root@pam",
      node: "pve1",
      pid: 12345,
      starttime: 1700000000,
    }),
    waitForTask: vi.fn().mockResolvedValue({
      status: "stopped",
      exitstatus: "OK",
    }),
    getNodeSyslog: vi.fn().mockResolvedValue([]),
    getNetworkInterfaces: vi.fn().mockResolvedValue([]),
    getVMFirewallRules: vi.fn().mockResolvedValue([]),
    addVMFirewallRule: vi.fn().mockResolvedValue(undefined),
    updateVMConfig: vi.fn().mockResolvedValue(undefined),
    resizeDisk: vi.fn().mockResolvedValue(undefined),
    migrateVM: vi.fn().mockResolvedValue("UPID:pve1:000ABC:123:migrate"),
  };

  return {
    ProxmoxClient: vi.fn().mockImplementation(function () { return mockClient; }),
    __mockClient: mockClient,
  };
});

// Get the mock client for assertions
async function getMockClient() {
  const mod = await import("../../src/providers/proxmox/client.js");
  return (mod as unknown as { __mockClient: Record<string, ReturnType<typeof vi.fn>> }).__mockClient;
}

describe("ProxmoxAdapter", () => {
  let adapter: ProxmoxAdapter;

  beforeEach(() => {
    adapter = new ProxmoxAdapter({
      host: "10.0.0.1",
      port: 8006,
      tokenId: "test@pam!token",
      tokenSecret: "secret",
      allowSelfSignedCerts: true,
    });
  });

  describe("lifecycle", () => {
    it("connects and disconnects", async () => {
      expect(adapter.isConnected()).toBe(false);
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });

    it("has name 'proxmox'", () => {
      expect(adapter.name).toBe("proxmox");
    });
  });

  describe("getTools", () => {
    it("returns tool definitions", () => {
      const tools = adapter.getTools();
      expect(tools.length).toBeGreaterThan(20);
    });

    it("all tools have adapter set to 'proxmox'", () => {
      const tools = adapter.getTools();
      expect(tools.every(t => t.adapter === "proxmox")).toBe(true);
    });

    it("includes read, safe_write, risky_write, and destructive tiers", () => {
      const tools = adapter.getTools();
      const tiers = new Set(tools.map(t => t.tier));
      expect(tiers.has("read")).toBe(true);
      expect(tiers.has("safe_write")).toBe(true);
      expect(tiers.has("risky_write")).toBe(true);
      expect(tiers.has("destructive")).toBe(true);
    });

    it("list_vms is a read tool", () => {
      const tool = adapter.getTools().find(t => t.name === "list_vms");
      expect(tool).toBeDefined();
      expect(tool!.tier).toBe("read");
    });

    it("create_vm is a risky_write tool", () => {
      const tool = adapter.getTools().find(t => t.name === "create_vm");
      expect(tool).toBeDefined();
      expect(tool!.tier).toBe("risky_write");
    });

    it("delete_vm is a destructive tool", () => {
      const tool = adapter.getTools().find(t => t.name === "delete_vm");
      expect(tool).toBeDefined();
      expect(tool!.tier).toBe("destructive");
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("executes list_vms", async () => {
      const result = await adapter.execute("list_vms", {});
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it("executes get_vm_status", async () => {
      const result = await adapter.execute("get_vm_status", { node: "pve1", vmid: 100 });
      expect(result.success).toBe(true);
    });

    it("executes start_vm", async () => {
      const result = await adapter.execute("start_vm", { node: "pve1", vmid: 100 });
      expect(result.success).toBe(true);
    });

    it("executes stop_vm", async () => {
      const result = await adapter.execute("stop_vm", { node: "pve1", vmid: 100 });
      expect(result.success).toBe(true);
    });

    it("executes create_vm", async () => {
      const result = await adapter.execute("create_vm", {
        node: "pve1",
        vmid: 200,
        name: "new-vm",
        memory: 4096,
        cores: 2,
      });
      expect(result.success).toBe(true);
    });

    it("executes create_snapshot", async () => {
      const result = await adapter.execute("create_snapshot", {
        node: "pve1",
        vmid: 100,
        snapname: "before-update",
        description: "Pre-update snapshot",
      });
      expect(result.success).toBe(true);
    });

    it("executes delete_vm", async () => {
      const result = await adapter.execute("delete_vm", {
        node: "pve1",
        vmid: 100,
        purge: true,
      });
      expect(result.success).toBe(true);
    });

    it("executes list_nodes", async () => {
      const result = await adapter.execute("list_nodes", {});
      expect(result.success).toBe(true);
    });

    it("executes list_storage", async () => {
      const result = await adapter.execute("list_storage", { node: "pve1" });
      expect(result.success).toBe(true);
    });

    it("returns error for unknown tool", async () => {
      const result = await adapter.execute("nonexistent_tool", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });

    it("strips internal params (prefixed with _)", async () => {
      const mockClient = await getMockClient();
      await adapter.execute("list_vms", { _plan_id: "abc", node: "pve1" });
      // getVMs should only receive node, not _plan_id
      expect(mockClient.getVMs).toHaveBeenCalledWith("pve1");
    });

    it("handles execution errors gracefully", async () => {
      const mockClient = await getMockClient();
      mockClient.getVMs.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await adapter.execute("list_vms", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Connection refused");
    });
  });

  describe("getClusterState", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("returns structured cluster state", async () => {
      const state = await adapter.getClusterState();

      expect(state.adapter).toBe("proxmox");
      expect(state.timestamp).toBeDefined();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].name).toBe("pve1");
      expect(state.nodes[0].status).toBe("online");
      expect(state.nodes[0].cpu_cores).toBe(8);
      expect(state.nodes[0].cpu_usage_pct).toBe(25);
    });

    it("maps VM data correctly", async () => {
      const state = await adapter.getClusterState();

      expect(state.vms).toHaveLength(1);
      expect(state.vms[0].id).toBe(100);
      expect(state.vms[0].name).toBe("test-vm");
      expect(state.vms[0].status).toBe("running");
      expect(state.vms[0].cpu_cores).toBe(4);
      expect(state.vms[0].ram_mb).toBe(4096);
    });

    it("maps storage data correctly", async () => {
      const state = await adapter.getClusterState();

      expect(state.storage).toHaveLength(1);
      expect(state.storage[0].id).toBe("local-lvm");
      expect(state.storage[0].type).toBe("lvmthin");
      expect(state.storage[0].total_gb).toBeGreaterThan(0);
    });

    it("maps node resource metrics", async () => {
      const state = await adapter.getClusterState();
      const node = state.nodes[0];

      // 8GB used out of 32GB
      expect(node.ram_total_mb).toBe(32768);
      expect(node.ram_used_mb).toBe(8192);

      // 100GB used out of 500GB
      expect(node.disk_total_gb).toBeGreaterThan(0);
      expect(node.disk_used_gb).toBeGreaterThan(0);
      expect(node.disk_usage_pct).toBeGreaterThan(0);
    });
  });
});
