import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
} from "../../src/types.js";

// ── Helpers ────────────────────────────────────────────────────

function createMockAdapter(
  name: string,
  tools: ToolDefinition[],
  connected = true
): InfraAdapter {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(connected),
    getTools: vi.fn().mockReturnValue(tools),
    execute: vi.fn().mockResolvedValue({ success: true, data: "mock" }),
    getClusterState: vi.fn().mockResolvedValue({
      adapter: name,
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    }),
  };
}

const sampleTools: ToolDefinition[] = [
  {
    name: "list_vms",
    description: "List all VMs",
    tier: "read",
    adapter: "proxmox",
    params: [],
    returns: "VMInfo[]",
  },
  {
    name: "start_vm",
    description: "Start a VM",
    tier: "safe_write",
    adapter: "proxmox",
    params: [
      { name: "vmid", type: "number", required: true, description: "VM ID" },
    ],
    returns: "void",
  },
  {
    name: "stop_vm",
    description: "Stop a VM",
    tier: "risky_write",
    adapter: "proxmox",
    params: [
      { name: "vmid", type: "number", required: true, description: "VM ID" },
    ],
    returns: "void",
  },
];

const vsphereTools: ToolDefinition[] = [
  {
    name: "list_esxi_hosts",
    description: "List ESXi hosts",
    tier: "read",
    adapter: "vsphere",
    params: [],
    returns: "NodeInfo[]",
  },
  {
    name: "migrate_vm",
    description: "vMotion a VM to another host",
    tier: "risky_write",
    adapter: "vsphere",
    params: [
      { name: "vm_id", type: "string", required: true, description: "VM ID" },
      {
        name: "target_host",
        type: "string",
        required: true,
        description: "Target ESXi host",
      },
    ],
    returns: "void",
  },
];

// ── Tests ──────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ── registerAdapter ────────────────────────────────────────

  describe("registerAdapter()", () => {
    it("registers an adapter and its tools", () => {
      const adapter = createMockAdapter("proxmox", sampleTools);
      registry.registerAdapter(adapter);

      expect(registry.getAdapter("proxmox")).toBe(adapter);
      expect(adapter.getTools).toHaveBeenCalled();
      expect(registry.getAllTools()).toHaveLength(sampleTools.length);
    });

    it("allows multiple adapters to be registered", () => {
      const proxmox = createMockAdapter("proxmox", sampleTools);
      const vsphere = createMockAdapter("vsphere", vsphereTools);

      registry.registerAdapter(proxmox);
      registry.registerAdapter(vsphere);

      expect(registry.getAdapter("proxmox")).toBe(proxmox);
      expect(registry.getAdapter("vsphere")).toBe(vsphere);
      expect(registry.getAllTools()).toHaveLength(
        sampleTools.length + vsphereTools.length
      );
    });
  });

  // ── getAdapter ─────────────────────────────────────────────

  describe("getAdapter()", () => {
    it("returns the adapter by name", () => {
      const adapter = createMockAdapter("proxmox", sampleTools);
      registry.registerAdapter(adapter);

      expect(registry.getAdapter("proxmox")).toBe(adapter);
    });

    it("returns undefined for an unknown adapter", () => {
      expect(registry.getAdapter("nonexistent")).toBeUndefined();
    });
  });

  // ── getTool ────────────────────────────────────────────────

  describe("getTool()", () => {
    it("returns a tool by name", () => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));

      const tool = registry.getTool("list_vms");
      expect(tool).toBeDefined();
      expect(tool!.name).toBe("list_vms");
      expect(tool!.tier).toBe("read");
      expect(tool!.adapter).toBe("proxmox");
    });

    it("returns undefined for an unknown tool", () => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));
      expect(registry.getTool("destroy_everything")).toBeUndefined();
    });
  });

  // ── getAllTools ─────────────────────────────────────────────

  describe("getAllTools()", () => {
    it("returns all registered tools from all adapters", () => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));
      registry.registerAdapter(createMockAdapter("vsphere", vsphereTools));

      const allTools = registry.getAllTools();
      expect(allTools).toHaveLength(sampleTools.length + vsphereTools.length);

      const names = allTools.map((t) => t.name);
      expect(names).toContain("list_vms");
      expect(names).toContain("start_vm");
      expect(names).toContain("stop_vm");
      expect(names).toContain("list_esxi_hosts");
      expect(names).toContain("migrate_vm");
    });

    it("returns an empty array when no adapters are registered", () => {
      expect(registry.getAllTools()).toEqual([]);
    });
  });

  // ── getToolsByAdapter ──────────────────────────────────────

  describe("getToolsByAdapter()", () => {
    beforeEach(() => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));
      registry.registerAdapter(createMockAdapter("vsphere", vsphereTools));
    });

    it("returns tools filtered by adapter name", () => {
      const proxmoxTools = registry.getToolsByAdapter("proxmox");
      expect(proxmoxTools).toHaveLength(sampleTools.length);
      expect(proxmoxTools.every((t) => t.adapter === "proxmox")).toBe(true);
    });

    it("returns empty array for an unknown adapter", () => {
      expect(registry.getToolsByAdapter("docker")).toEqual([]);
    });
  });

  // ── getToolsByTier ─────────────────────────────────────────

  describe("getToolsByTier()", () => {
    beforeEach(() => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));
      registry.registerAdapter(createMockAdapter("vsphere", vsphereTools));
    });

    it("returns tools filtered by tier", () => {
      const readTools = registry.getToolsByTier("read");
      expect(readTools).toHaveLength(2); // list_vms + list_esxi_hosts
      expect(readTools.every((t) => t.tier === "read")).toBe(true);
    });

    it("returns risky_write tools across adapters", () => {
      const riskyTools = registry.getToolsByTier("risky_write");
      expect(riskyTools).toHaveLength(2); // stop_vm + migrate_vm
      expect(riskyTools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["stop_vm", "migrate_vm"])
      );
    });

    it("returns empty array for a tier with no tools", () => {
      expect(registry.getToolsByTier("destructive")).toEqual([]);
    });
  });

  // ── connectAll ─────────────────────────────────────────────

  describe("connectAll()", () => {
    it("calls connect() on all adapters", async () => {
      const proxmox = createMockAdapter("proxmox", sampleTools);
      const vsphere = createMockAdapter("vsphere", vsphereTools);
      registry.registerAdapter(proxmox);
      registry.registerAdapter(vsphere);

      await registry.connectAll();

      expect(proxmox.connect).toHaveBeenCalledOnce();
      expect(vsphere.connect).toHaveBeenCalledOnce();
    });

    it("handles adapter connect failure gracefully (does not throw)", async () => {
      const failing = createMockAdapter("broken", []);
      (failing.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("connection refused")
      );
      const healthy = createMockAdapter("proxmox", sampleTools);

      registry.registerAdapter(failing);
      registry.registerAdapter(healthy);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(registry.connectAll()).resolves.not.toThrow();
      expect(healthy.connect).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to connect adapter broken:",
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  // ── disconnectAll ──────────────────────────────────────────

  describe("disconnectAll()", () => {
    it("calls disconnect() on all adapters", async () => {
      const proxmox = createMockAdapter("proxmox", sampleTools);
      const vsphere = createMockAdapter("vsphere", vsphereTools);
      registry.registerAdapter(proxmox);
      registry.registerAdapter(vsphere);

      await registry.disconnectAll();

      expect(proxmox.disconnect).toHaveBeenCalledOnce();
      expect(vsphere.disconnect).toHaveBeenCalledOnce();
    });

    it("handles disconnect failure gracefully (does not throw)", async () => {
      const failing = createMockAdapter("broken", []);
      (failing.disconnect as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("timeout")
      );

      registry.registerAdapter(failing);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(registry.disconnectAll()).resolves.not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to disconnect adapter broken:",
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  // ── execute ────────────────────────────────────────────────

  describe("execute()", () => {
    it("calls adapter.execute() with correct tool name and params", async () => {
      const adapter = createMockAdapter("proxmox", sampleTools);
      (adapter.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: [{ id: 100, name: "test-vm" }],
      });
      registry.registerAdapter(adapter);

      const result = await registry.execute("list_vms", {});

      expect(adapter.execute).toHaveBeenCalledWith("list_vms", {});
      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ id: 100, name: "test-vm" }]);
    });

    it("passes parameters through to the adapter", async () => {
      const adapter = createMockAdapter("proxmox", sampleTools);
      registry.registerAdapter(adapter);

      await registry.execute("start_vm", { vmid: 101 });

      expect(adapter.execute).toHaveBeenCalledWith("start_vm", { vmid: 101 });
    });

    it("returns error for an unknown tool", async () => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));

      const result = await registry.execute("nonexistent_tool", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
      expect(result.error).toContain("nonexistent_tool");
    });

    it("returns error for an unknown adapter", async () => {
      // Register a tool that references an adapter we never register
      const orphanTool: ToolDefinition = {
        name: "orphan_action",
        description: "Tool with missing adapter",
        tier: "read",
        adapter: "phantom",
        params: [],
        returns: "void",
      };
      // Manually inject an orphan tool by registering an adapter then removing it
      const phantom = createMockAdapter("phantom", [orphanTool]);
      registry.registerAdapter(phantom);
      // Simulate adapter disappearing — the tool map still has the tool but
      // the adapter map no longer has it. We can't directly delete from the
      // private map, so instead we test the code path by creating a scenario
      // where the tool's adapter field doesn't match any adapter.
      // Since the implementation looks up tool.adapter in the adapters map,
      // the simplest approach: register a tool whose adapter field differs.
      const registry2 = new ToolRegistry();
      // Manually trick: register adapter "real" but the tool says adapter "ghost"
      const ghostTool: ToolDefinition = {
        name: "ghost_action",
        description: "Points to non-existent adapter",
        tier: "read",
        adapter: "ghost",
        params: [],
        returns: "void",
      };
      const realAdapter = createMockAdapter("real", [ghostTool]);
      registry2.registerAdapter(realAdapter);

      const result = await registry2.execute("ghost_action", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Adapter not found");
      expect(result.error).toContain("ghost");
    });

    it("returns error when adapter is not connected", async () => {
      const disconnectedAdapter = createMockAdapter(
        "proxmox",
        sampleTools,
        false // not connected
      );
      registry.registerAdapter(disconnectedAdapter);

      const result = await registry.execute("list_vms", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("not connected");
      expect(disconnectedAdapter.execute).not.toHaveBeenCalled();
    });
  });

  // ── getClusterState ────────────────────────────────────────

  describe("getClusterState()", () => {
    it("returns state from the first connected adapter", async () => {
      const adapter = createMockAdapter("proxmox", sampleTools);
      registry.registerAdapter(adapter);

      const state = await registry.getClusterState();

      expect(state).not.toBeNull();
      expect(state!.adapter).toBe("proxmox");
      expect(adapter.getClusterState).toHaveBeenCalledOnce();
    });

    it("skips disconnected adapters and returns from a connected one", async () => {
      const disconnected = createMockAdapter("offline", [], false);
      const connected = createMockAdapter("proxmox", sampleTools, true);

      registry.registerAdapter(disconnected);
      registry.registerAdapter(connected);

      const state = await registry.getClusterState();

      expect(state).not.toBeNull();
      expect(state!.adapter).toBe("proxmox");
      expect(disconnected.getClusterState).not.toHaveBeenCalled();
    });

    it("returns null when no adapters are connected", async () => {
      const offline1 = createMockAdapter("offline1", [], false);
      const offline2 = createMockAdapter("offline2", [], false);

      registry.registerAdapter(offline1);
      registry.registerAdapter(offline2);

      const state = await registry.getClusterState();
      expect(state).toBeNull();
    });

    it("returns null when no adapters are registered", async () => {
      const state = await registry.getClusterState();
      expect(state).toBeNull();
    });
  });

  // ── getToolDescriptionsForLLM ──────────────────────────────

  describe("getToolDescriptionsForLLM()", () => {
    it("returns formatted string with tool descriptions grouped by adapter", () => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));
      registry.registerAdapter(createMockAdapter("vsphere", vsphereTools));

      const output = registry.getToolDescriptionsForLLM();

      // Adapter group headers
      expect(output).toContain("## proxmox tools");
      expect(output).toContain("## vsphere tools");

      // Tool names with tiers
      expect(output).toContain("### list_vms [read]");
      expect(output).toContain("### start_vm [safe_write]");
      expect(output).toContain("### stop_vm [risky_write]");
      expect(output).toContain("### list_esxi_hosts [read]");
      expect(output).toContain("### migrate_vm [risky_write]");
    });

    it("includes tool descriptions", () => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));

      const output = registry.getToolDescriptionsForLLM();

      expect(output).toContain("List all VMs");
      expect(output).toContain("Start a VM");
      expect(output).toContain("Stop a VM");
    });

    it("includes parameter details for tools that have params", () => {
      registry.registerAdapter(createMockAdapter("proxmox", sampleTools));

      const output = registry.getToolDescriptionsForLLM();

      expect(output).toContain("Parameters:");
      expect(output).toContain("vmid");
      expect(output).toContain("number");
      expect(output).toContain("required");
      expect(output).toContain("VM ID");
    });

    it("omits Parameters section for tools with no params", () => {
      const noParamTools: ToolDefinition[] = [
        {
          name: "ping",
          description: "Ping the cluster",
          tier: "read",
          adapter: "test",
          params: [],
          returns: "boolean",
        },
      ];
      registry.registerAdapter(createMockAdapter("test", noParamTools));

      const output = registry.getToolDescriptionsForLLM();

      // The tool should appear but without "Parameters:"
      expect(output).toContain("### ping [read]");
      expect(output).not.toContain("Parameters:");
    });

    it("includes default values when present", () => {
      const toolWithDefaults: ToolDefinition[] = [
        {
          name: "list_vms_filtered",
          description: "List VMs with filter",
          tier: "read",
          adapter: "proxmox",
          params: [
            {
              name: "status",
              type: "string",
              required: false,
              description: "Filter by status",
              default: "running",
            },
          ],
          returns: "VMInfo[]",
        },
      ];
      registry.registerAdapter(createMockAdapter("proxmox", toolWithDefaults));

      const output = registry.getToolDescriptionsForLLM();

      expect(output).toContain("optional");
      expect(output).toContain("default: running");
    });

    it("returns empty string when no tools are registered", () => {
      const output = registry.getToolDescriptionsForLLM();
      expect(output).toBe("");
    });
  });
});
