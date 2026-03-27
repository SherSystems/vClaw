import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../../src/providers/registry.js";
import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
} from "../../src/providers/types.js";

// ── Mock Adapter Factory ────────────────────────────────────

function createMockAdapter(
  name: string,
  tools: ToolDefinition[] = [],
  overrides: Partial<InfraAdapter> = {}
): InfraAdapter {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getTools: () => tools,
    execute: vi.fn().mockResolvedValue({ success: true, data: "ok" }),
    getClusterState: vi.fn().mockResolvedValue({
      adapter: name,
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    }),
    ...overrides,
  };
}

function makeTool(name: string, adapter: string, tier: ToolDefinition["tier"] = "read"): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    tier,
    adapter,
    params: [],
    returns: "object",
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("registerAdapter", () => {
    it("registers an adapter and its tools", () => {
      const adapter = createMockAdapter("proxmox", [
        makeTool("list_vms", "proxmox"),
        makeTool("create_vm", "proxmox", "risky_write"),
      ]);

      registry.registerAdapter(adapter);

      expect(registry.getAdapter("proxmox")).toBe(adapter);
      expect(registry.getAllTools()).toHaveLength(2);
      expect(registry.getTool("list_vms")).toBeDefined();
      expect(registry.getTool("create_vm")).toBeDefined();
    });

    it("registers multiple adapters", () => {
      const proxmox = createMockAdapter("proxmox", [
        makeTool("list_vms", "proxmox"),
      ]);
      const system = createMockAdapter("system", [
        makeTool("ssh_exec", "system", "risky_write"),
      ]);

      registry.registerAdapter(proxmox);
      registry.registerAdapter(system);

      expect(registry.getAdapter("proxmox")).toBe(proxmox);
      expect(registry.getAdapter("system")).toBe(system);
      expect(registry.getAllTools()).toHaveLength(2);
    });

    it("returns undefined for unknown adapter", () => {
      expect(registry.getAdapter("nonexistent")).toBeUndefined();
    });
  });

  describe("getTool", () => {
    it("returns the correct tool definition", () => {
      const tool = makeTool("list_vms", "proxmox");
      registry.registerAdapter(createMockAdapter("proxmox", [tool]));

      const found = registry.getTool("list_vms");
      expect(found).toBe(tool);
    });

    it("returns undefined for unknown tool", () => {
      expect(registry.getTool("nonexistent")).toBeUndefined();
    });
  });

  describe("getToolsByAdapter", () => {
    it("filters tools by adapter name", () => {
      registry.registerAdapter(createMockAdapter("proxmox", [
        makeTool("list_vms", "proxmox"),
        makeTool("create_vm", "proxmox", "risky_write"),
      ]));
      registry.registerAdapter(createMockAdapter("system", [
        makeTool("ssh_exec", "system", "risky_write"),
      ]));

      const proxmoxTools = registry.getToolsByAdapter("proxmox");
      expect(proxmoxTools).toHaveLength(2);
      expect(proxmoxTools.every(t => t.adapter === "proxmox")).toBe(true);

      const systemTools = registry.getToolsByAdapter("system");
      expect(systemTools).toHaveLength(1);
    });
  });

  describe("getToolsByTier", () => {
    it("filters tools by tier", () => {
      registry.registerAdapter(createMockAdapter("proxmox", [
        makeTool("list_vms", "proxmox", "read"),
        makeTool("create_vm", "proxmox", "risky_write"),
        makeTool("delete_vm", "proxmox", "destructive"),
      ]));

      expect(registry.getToolsByTier("read")).toHaveLength(1);
      expect(registry.getToolsByTier("risky_write")).toHaveLength(1);
      expect(registry.getToolsByTier("destructive")).toHaveLength(1);
      expect(registry.getToolsByTier("safe_write")).toHaveLength(0);
    });
  });

  describe("connectAll / disconnectAll", () => {
    it("connects all registered adapters", async () => {
      const a1 = createMockAdapter("proxmox", []);
      const a2 = createMockAdapter("system", []);
      registry.registerAdapter(a1);
      registry.registerAdapter(a2);

      await registry.connectAll();

      expect(a1.connect).toHaveBeenCalledOnce();
      expect(a2.connect).toHaveBeenCalledOnce();
    });

    it("disconnects all registered adapters", async () => {
      const a1 = createMockAdapter("proxmox", []);
      const a2 = createMockAdapter("system", []);
      registry.registerAdapter(a1);
      registry.registerAdapter(a2);

      await registry.disconnectAll();

      expect(a1.disconnect).toHaveBeenCalledOnce();
      expect(a2.disconnect).toHaveBeenCalledOnce();
    });

    it("continues connecting other adapters if one fails", async () => {
      const failing = createMockAdapter("failing", [], {
        connect: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });
      const working = createMockAdapter("working", []);

      registry.registerAdapter(failing);
      registry.registerAdapter(working);

      // Should not throw
      await registry.connectAll();

      expect(failing.connect).toHaveBeenCalledOnce();
      expect(working.connect).toHaveBeenCalledOnce();
    });
  });

  describe("execute", () => {
    it("routes execution to the correct adapter", async () => {
      const executeFn = vi.fn().mockResolvedValue({ success: true, data: { vms: [] } });
      registry.registerAdapter(createMockAdapter("proxmox", [
        makeTool("list_vms", "proxmox"),
      ], { execute: executeFn }));

      const result = await registry.execute("list_vms", { node: "pve1" });

      expect(result.success).toBe(true);
      expect(executeFn).toHaveBeenCalledWith("list_vms", { node: "pve1" });
    });

    it("returns error for unknown tool", async () => {
      const result = await registry.execute("nonexistent", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });

    it("returns error if adapter is not connected", async () => {
      registry.registerAdapter(createMockAdapter("proxmox", [
        makeTool("list_vms", "proxmox"),
      ], { isConnected: () => false }));

      const result = await registry.execute("list_vms", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("not connected");
    });

    it("routes to correct adapter when multiple are registered", async () => {
      const proxmoxExec = vi.fn().mockResolvedValue({ success: true, data: "proxmox" });
      const systemExec = vi.fn().mockResolvedValue({ success: true, data: "system" });

      registry.registerAdapter(createMockAdapter("proxmox", [
        makeTool("list_vms", "proxmox"),
      ], { execute: proxmoxExec }));

      registry.registerAdapter(createMockAdapter("system", [
        makeTool("ssh_exec", "system", "risky_write"),
      ], { execute: systemExec }));

      await registry.execute("list_vms", {});
      expect(proxmoxExec).toHaveBeenCalledOnce();
      expect(systemExec).not.toHaveBeenCalled();

      await registry.execute("ssh_exec", { host: "10.0.0.1", command: "ls" });
      expect(systemExec).toHaveBeenCalledOnce();
    });
  });

  describe("getClusterState", () => {
    it("returns state from first connected adapter", async () => {
      const state: ClusterState = {
        adapter: "proxmox",
        nodes: [{ id: "pve1", name: "pve1", status: "online", cpu_cores: 8, cpu_usage_pct: 25, ram_total_mb: 32768, ram_used_mb: 16384, disk_total_gb: 500, disk_used_gb: 250, disk_usage_pct: 50, uptime_s: 86400 }],
        vms: [],
        containers: [],
        storage: [],
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      registry.registerAdapter(createMockAdapter("proxmox", [], {
        getClusterState: vi.fn().mockResolvedValue(state),
      }));

      const result = await registry.getClusterState();
      expect(result).toBe(state);
    });

    it("returns null when no adapters connected", async () => {
      registry.registerAdapter(createMockAdapter("proxmox", [], {
        isConnected: () => false,
      }));

      const result = await registry.getClusterState();
      expect(result).toBeNull();
    });
  });

  describe("getMultiClusterState", () => {
    it("returns state from all connected non-system providers", async () => {
      registry.registerAdapter(createMockAdapter("proxmox", [], {
        getClusterState: vi.fn().mockResolvedValue({
          adapter: "proxmox",
          nodes: [{ id: "pve1", name: "pve1", status: "online", cpu_cores: 8, cpu_usage_pct: 25, ram_total_mb: 32768, ram_used_mb: 16384, disk_total_gb: 500, disk_used_gb: 250, disk_usage_pct: 50, uptime_s: 86400 }],
          vms: [],
          containers: [],
          storage: [],
          timestamp: "2024-01-01T00:00:00.000Z",
        }),
      }));

      // system adapter should be excluded
      registry.registerAdapter(createMockAdapter("system", []));

      const result = await registry.getMultiClusterState();
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe("proxmox");
      expect(result.timestamp).toBeDefined();
    });

    it("skips providers that fail to return state", async () => {
      registry.registerAdapter(createMockAdapter("proxmox", [], {
        getClusterState: vi.fn().mockRejectedValue(new Error("timeout")),
      }));

      const result = await registry.getMultiClusterState();
      expect(result.providers).toHaveLength(0);
    });
  });

  describe("getToolDescriptionsForLLM", () => {
    it("formats tools grouped by adapter", () => {
      registry.registerAdapter(createMockAdapter("proxmox", [
        {
          name: "list_vms",
          description: "List all VMs",
          tier: "read",
          adapter: "proxmox",
          params: [
            { name: "node", type: "string", required: false, description: "Node name" },
          ],
          returns: "VMInfo[]",
        },
      ]));

      const output = registry.getToolDescriptionsForLLM();

      expect(output).toContain("## proxmox tools");
      expect(output).toContain("### list_vms [read]");
      expect(output).toContain("List all VMs");
      expect(output).toContain("node (string, optional)");
    });

    it("shows params with defaults", () => {
      registry.registerAdapter(createMockAdapter("proxmox", [
        {
          name: "list_tasks",
          description: "List recent tasks",
          tier: "read",
          adapter: "proxmox",
          params: [
            { name: "node", type: "string", required: true, description: "Node" },
            { name: "limit", type: "number", required: false, description: "Max tasks", default: 50 },
          ],
          returns: "Task[]",
        },
      ]));

      const output = registry.getToolDescriptionsForLLM();
      expect(output).toContain("node (string, required)");
      expect(output).toContain("limit (number, optional, default: 50)");
    });
  });

  describe("getAdapters", () => {
    it("returns map of all registered adapters", () => {
      registry.registerAdapter(createMockAdapter("proxmox", []));
      registry.registerAdapter(createMockAdapter("system", []));

      const adapters = registry.getAdapters();
      expect(adapters.size).toBe(2);
      expect(adapters.has("proxmox")).toBe(true);
      expect(adapters.has("system")).toBe(true);
    });
  });
});
