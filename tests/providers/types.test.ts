import { describe, it, expect } from "vitest";
import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
  NodeInfo,
  VMInfo,
  ContainerInfo,
  StorageInfo,
  ActionTier,
  ProviderType,
  ProviderConfig,
  MultiClusterState,
} from "../../src/providers/types.js";

// Also verify re-exports from the main types.ts still work
import type {
  InfraAdapter as MainInfraAdapter,
  ClusterState as MainClusterState,
  VMInfo as MainVMInfo,
  ProviderConfig as MainProviderConfig,
} from "../../src/types.js";

describe("Provider Types", () => {
  it("ActionTier includes all expected values", () => {
    const tiers: ActionTier[] = ["read", "safe_write", "risky_write", "destructive", "never"];
    expect(tiers).toHaveLength(5);
  });

  it("ProviderType includes expected providers", () => {
    const types: ProviderType[] = ["proxmox", "vmware", "system"];
    expect(types).toHaveLength(3);
  });

  it("ToolDefinition shape is correct", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "A test tool",
      tier: "read",
      adapter: "proxmox",
      params: [
        { name: "node", type: "string", required: true, description: "Node name" },
      ],
      returns: "object",
    };
    expect(tool.name).toBe("test_tool");
    expect(tool.params).toHaveLength(1);
  });

  it("ToolCallResult shape is correct", () => {
    const success: ToolCallResult = { success: true, data: { vms: [] } };
    const failure: ToolCallResult = { success: false, error: "Connection refused" };
    expect(success.success).toBe(true);
    expect(failure.success).toBe(false);
  });

  it("ClusterState shape is correct", () => {
    const state: ClusterState = {
      adapter: "proxmox",
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
    expect(state.adapter).toBe("proxmox");
  });

  it("NodeInfo shape is correct", () => {
    const node: NodeInfo = {
      id: "pve1",
      name: "pve1",
      status: "online",
      cpu_cores: 8,
      cpu_usage_pct: 25.5,
      ram_total_mb: 32768,
      ram_used_mb: 16384,
      disk_total_gb: 500,
      disk_used_gb: 250,
      disk_usage_pct: 50,
      uptime_s: 86400,
    };
    expect(node.status).toBe("online");
  });

  it("VMInfo shape is correct", () => {
    const vm: VMInfo = {
      id: 100,
      name: "test-vm",
      node: "pve1",
      status: "running",
      cpu_cores: 4,
      ram_mb: 4096,
      disk_gb: 32,
    };
    expect(vm.status).toBe("running");

    // Optional fields
    const vmWithOptionals: VMInfo = {
      ...vm,
      ip_address: "10.0.0.100",
      os: "debian-12",
      uptime_s: 3600,
    };
    expect(vmWithOptionals.ip_address).toBe("10.0.0.100");
  });

  it("ContainerInfo shape is correct", () => {
    const ct: ContainerInfo = {
      id: 200,
      name: "test-ct",
      node: "pve1",
      status: "running",
      cpu_cores: 2,
      ram_mb: 512,
      disk_gb: 8,
    };
    // Containers don't have "paused" status
    expect(["running", "stopped", "unknown"]).toContain(ct.status);
  });

  it("StorageInfo shape is correct", () => {
    const storage: StorageInfo = {
      id: "local-lvm",
      node: "pve1",
      type: "lvmthin",
      total_gb: 500,
      used_gb: 250,
      available_gb: 250,
      content: ["images", "rootdir"],
    };
    expect(storage.content).toContain("images");
  });

  it("ProviderConfig shape is correct", () => {
    const config: ProviderConfig = {
      type: "proxmox",
      name: "homelab-proxmox",
      enabled: true,
      connection: {
        host: "10.0.0.50",
        port: 8006,
        tokenId: "root@pam!token",
      },
    };
    expect(config.type).toBe("proxmox");
    expect(config.enabled).toBe(true);
  });

  it("MultiClusterState aggregates multiple providers", () => {
    const multi: MultiClusterState = {
      providers: [
        {
          name: "homelab-proxmox",
          type: "proxmox",
          state: {
            adapter: "proxmox",
            nodes: [],
            vms: [{ id: 100, name: "pve-vm", node: "pve1", status: "running", cpu_cores: 2, ram_mb: 2048, disk_gb: 20 }],
            containers: [],
            storage: [],
            timestamp: new Date().toISOString(),
          },
        },
        {
          name: "homelab-vmware",
          type: "vmware",
          state: {
            adapter: "vmware",
            nodes: [],
            vms: [{ id: "vm-42", name: "esxi-vm", node: "esxi1", status: "running", cpu_cores: 4, ram_mb: 8192, disk_gb: 100 }],
            containers: [],
            storage: [],
            timestamp: new Date().toISOString(),
          },
        },
      ],
      timestamp: new Date().toISOString(),
    };

    expect(multi.providers).toHaveLength(2);
    expect(multi.providers[0].type).toBe("proxmox");
    expect(multi.providers[1].type).toBe("vmware");
  });

  it("re-exports from types.ts are compatible", () => {
    // This test verifies that types imported from src/types.ts
    // are the same as those from src/providers/types.ts
    // (compile-time check — if this file compiles, the re-exports work)
    const adapter: MainInfraAdapter = {
      name: "test",
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      getTools: () => [],
      execute: async () => ({ success: true }),
      getClusterState: async (): Promise<MainClusterState> => ({
        adapter: "test",
        nodes: [],
        vms: [],
        containers: [],
        storage: [],
        timestamp: "",
      }),
    };
    expect(adapter.name).toBe("test");

    const vm: MainVMInfo = {
      id: 1,
      name: "test",
      node: "n",
      status: "running",
      cpu_cores: 1,
      ram_mb: 512,
      disk_gb: 10,
    };
    expect(vm.name).toBe("test");

    const config: MainProviderConfig = {
      type: "vmware",
      name: "test",
      enabled: true,
      connection: {},
    };
    expect(config.type).toBe("vmware");
  });
});
