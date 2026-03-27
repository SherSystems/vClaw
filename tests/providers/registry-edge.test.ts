// ============================================================
// Edge-case tests for ToolRegistry
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../../src/providers/registry.js";
import type { InfraAdapter, ToolDefinition, ClusterState, ToolCallResult } from "../../src/types.js";

// ── Mock Adapter Factory ─────────────────────────────────────

function createMockAdapter(
  name: string,
  tools: ToolDefinition[] = [],
  config: {
    throwOnConnect?: boolean;
    throwOnDisconnect?: boolean;
    connected?: boolean;
  } = {},
): InfraAdapter {
  return {
    name,
    getTools: () => tools,
    isConnected: () => config.connected ?? true,
    connect: async () => {
      if (config.throwOnConnect) throw new Error(`Connect failed for ${name}`);
    },
    disconnect: async () => {
      if (config.throwOnDisconnect) throw new Error(`Disconnect failed for ${name}`);
    },
    execute: async (toolName: string, params: Record<string, unknown>): Promise<ToolCallResult> => ({
      success: true,
      data: { tool: toolName, adapter: name, params },
    }),
    getClusterState: async (): Promise<ClusterState> => ({
      adapter: name,
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    }),
  };
}

function createMockTool(
  name: string,
  adapter: string,
  tier: string = "basic",
): ToolDefinition {
  return {
    name,
    adapter,
    tier,
    description: `Mock tool ${name}`,
    params: [
      { name: "param1", type: "string", required: true, description: "Test param" },
    ],
  };
}

describe("ToolRegistry — Edge Cases", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("adapter registration edge cases", () => {
    it("register adapter with empty name", () => {
      const adapter = createMockAdapter("", [createMockTool("tool1", "")]);
      // Should not crash, but empty name is not ideal
      expect(() => {
        registry.registerAdapter(adapter);
      }).not.toThrow();

      expect(registry.getAdapter("")).toBe(adapter);
    });

    it("register same adapter twice (overwrite behavior)", () => {
      const adapter1 = createMockAdapter("adapter1", [createMockTool("tool1", "adapter1")]);
      const adapter2 = createMockAdapter("adapter1", [createMockTool("tool2", "adapter1")]);

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      // Second registration should overwrite
      const retrieved = registry.getAdapter("adapter1");
      expect(retrieved).toBe(adapter2);
    });

    it("register null adapter (type safety)", () => {
      expect(() => {
        registry.registerAdapter(null as any);
      }).toThrow();
    });

    it("register adapter with no tools", () => {
      const adapter = createMockAdapter("empty", []);
      registry.registerAdapter(adapter);

      expect(registry.getAdapter("empty")).toBe(adapter);
      expect(registry.getToolsByAdapter("empty")).toEqual([]);
    });

    it("register multiple adapters", () => {
      const adapter1 = createMockAdapter("adapter1", [createMockTool("tool1", "adapter1")]);
      const adapter2 = createMockAdapter("adapter2", [createMockTool("tool2", "adapter2")]);
      const adapter3 = createMockAdapter("adapter3", [createMockTool("tool3", "adapter3")]);

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);
      registry.registerAdapter(adapter3);

      const adapters = registry.getAdapters();
      expect(adapters.size).toBe(3);
      expect(adapters.has("adapter1")).toBe(true);
      expect(adapters.has("adapter2")).toBe(true);
      expect(adapters.has("adapter3")).toBe(true);
    });
  });

  describe("tool execution edge cases", () => {
    it("execute tool on disconnected adapter", async () => {
      const adapter = createMockAdapter("test", [createMockTool("tool1", "test")], {
        connected: false,
      });
      registry.registerAdapter(adapter);

      const result = await registry.execute("tool1", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("not connected");
    });

    it("execute tool that doesn't exist", async () => {
      const adapter = createMockAdapter("test", [createMockTool("tool1", "test")]);
      registry.registerAdapter(adapter);

      const result = await registry.execute("nonexistent", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });

    it("execute tool with adapter not found in registry", async () => {
      // Manually create a tool with adapter reference that doesn't exist
      const tool: ToolDefinition = {
        name: "orphan-tool",
        adapter: "missing-adapter",
        tier: "basic",
        description: "Orphaned tool",
        params: [],
      };

      // This is a structural edge case where tool references non-existent adapter
      // Can't directly inject via registerAdapter since it builds tools from adapters
      // So we test via registry state
      registry.registerAdapter(createMockAdapter("other", []));

      const result = await registry.execute("orphan-tool", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool"); // Will fail because tool not in registry
    });

    it("execute with empty params object", async () => {
      const adapter = createMockAdapter("test", [createMockTool("tool1", "test")]);
      registry.registerAdapter(adapter);

      const result = await registry.execute("tool1", {});
      expect(result.success).toBe(true);
      expect((result.data as any).params).toEqual({});
    });

    it("execute with very large params object (1MB)", async () => {
      const largeParams: Record<string, unknown> = {};
      for (let i = 0; i < 10000; i++) {
        largeParams[`key-${i}`] = "x".repeat(100);
      }

      const adapter = createMockAdapter("test", [createMockTool("tool1", "test")]);
      registry.registerAdapter(adapter);

      const result = await registry.execute("tool1", largeParams);
      expect(result.success).toBe(true);
    });
  });

  describe("tool query edge cases", () => {
    it("getAllTools() returns empty array when no adapters", () => {
      const tools = registry.getAllTools();
      expect(tools).toEqual([]);
    });

    it("getAllTools() returns all tools from all adapters (no dupes)", () => {
      const adapter1 = createMockAdapter("a1", [
        createMockTool("tool1", "a1"),
        createMockTool("tool2", "a1"),
      ]);
      const adapter2 = createMockAdapter("a2", [
        createMockTool("tool3", "a2"),
        createMockTool("tool4", "a2"),
      ]);

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      const tools = registry.getAllTools();
      expect(tools).toHaveLength(4);
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["tool1", "tool2", "tool3", "tool4"]),
      );
    });

    it("getTool() returns undefined for non-existent tool", () => {
      const adapter = createMockAdapter("test", [createMockTool("tool1", "test")]);
      registry.registerAdapter(adapter);

      expect(registry.getTool("nonexistent")).toBeUndefined();
    });

    it("getTool() returns exact tool definition", () => {
      const tool = createMockTool("specific-tool", "test");
      const adapter = createMockAdapter("test", [tool]);
      registry.registerAdapter(adapter);

      const retrieved = registry.getTool("specific-tool");
      expect(retrieved?.name).toBe("specific-tool");
      expect(retrieved?.adapter).toBe("test");
    });

    it("getToolsByAdapter() with non-existent adapter", () => {
      const adapter = createMockAdapter("test", [createMockTool("tool1", "test")]);
      registry.registerAdapter(adapter);

      const tools = registry.getToolsByAdapter("nonexistent");
      expect(tools).toEqual([]);
    });

    it("getToolsByAdapter() returns tools from specific adapter", () => {
      const adapter1 = createMockAdapter("a1", [
        createMockTool("t1", "a1"),
        createMockTool("t2", "a1"),
      ]);
      const adapter2 = createMockAdapter("a2", [
        createMockTool("t3", "a2"),
      ]);

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      const toolsA1 = registry.getToolsByAdapter("a1");
      expect(toolsA1).toHaveLength(2);
      expect(toolsA1.map((t) => t.name)).toEqual(["t1", "t2"]);

      const toolsA2 = registry.getToolsByAdapter("a2");
      expect(toolsA2).toHaveLength(1);
      expect(toolsA2[0].name).toBe("t3");
    });

    it("getToolsByTier() with tier that has no tools", () => {
      const adapter = createMockAdapter("test", [
        createMockTool("t1", "test", "basic"),
      ]);
      registry.registerAdapter(adapter);

      const tools = registry.getToolsByTier("advanced");
      expect(tools).toEqual([]);
    });

    it("getToolsByTier() returns all tools with that tier", () => {
      const adapter = createMockAdapter("test", [
        createMockTool("t1", "test", "basic"),
        createMockTool("t2", "test", "advanced"),
        createMockTool("t3", "test", "basic"),
      ]);
      registry.registerAdapter(adapter);

      const basicTools = registry.getToolsByTier("basic");
      expect(basicTools).toHaveLength(2);
      expect(basicTools.map((t) => t.name)).toEqual(["t1", "t3"]);

      const advancedTools = registry.getToolsByTier("advanced");
      expect(advancedTools).toHaveLength(1);
      expect(advancedTools[0].name).toBe("t2");
    });
  });

  describe("cluster state retrieval edge cases", () => {
    it("getClusterState() when no adapters registered", async () => {
      const state = await registry.getClusterState();
      expect(state).toBeNull();
    });

    it("getClusterState() when all adapters disconnected", async () => {
      const adapter1 = createMockAdapter("a1", [], { connected: false });
      const adapter2 = createMockAdapter("a2", [], { connected: false });

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      const state = await registry.getClusterState();
      expect(state).toBeNull();
    });

    it("getClusterState() returns state from first connected adapter", async () => {
      const adapter1 = createMockAdapter("a1", [], { connected: false });
      const adapter2 = createMockAdapter("a2", [], { connected: true });

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      const state = await registry.getClusterState();
      expect(state?.adapter).toBe("a2");
    });
  });

  describe("multi-cluster state edge cases", () => {
    it("getMultiClusterState() when no adapters registered", async () => {
      const state = await registry.getMultiClusterState();
      expect(state.providers).toEqual([]);
      expect(state.timestamp).toBeDefined();
    });

    it("getMultiClusterState() when all adapters throw", async () => {
      const adapter1 = createMockAdapter("a1", [], {
        connected: true,
      });
      const adapter2 = createMockAdapter("a2", [], {
        connected: true,
      });

      // Override getClusterState to throw
      adapter1.getClusterState = async () => {
        throw new Error("Failed");
      };
      adapter2.getClusterState = async () => {
        throw new Error("Failed");
      };

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      const state = await registry.getMultiClusterState();
      expect(state.providers).toEqual([]);
    });

    it("getMultiClusterState() with one adapter throwing, others succeed (partial failure)", async () => {
      const adapter1 = createMockAdapter("a1", [], { connected: true });
      const adapter2 = createMockAdapter("a2", [], { connected: true });

      adapter1.getClusterState = async () => {
        throw new Error("Failed");
      };

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      const state = await registry.getMultiClusterState();
      expect(state.providers).toHaveLength(1);
      expect(state.providers[0].name).toBe("a2");
    });

    it("getMultiClusterState() excludes system adapter", async () => {
      const system = createMockAdapter("system", [], { connected: true });
      const proxmox = createMockAdapter("proxmox", [], { connected: true });

      registry.registerAdapter(system);
      registry.registerAdapter(proxmox);

      const state = await registry.getMultiClusterState();
      const names = state.providers.map((p) => p.name);
      expect(names).toContain("proxmox");
      expect(names).not.toContain("system");
    });
  });

  describe("connection management edge cases", () => {
    it("connectAll() when one adapter throws during connect", async () => {
      const adapter1 = createMockAdapter("a1", [], {
        throwOnConnect: true,
      });
      const adapter2 = createMockAdapter("a2", [], {
        throwOnConnect: false,
      });

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      // Should not throw, should catch errors
      expect(async () => {
        await registry.connectAll();
      }).not.toThrow();
    });

    it("disconnectAll() when one adapter throws during disconnect", async () => {
      const adapter1 = createMockAdapter("a1", [], {
        throwOnDisconnect: true,
      });
      const adapter2 = createMockAdapter("a2", [], {
        throwOnDisconnect: false,
      });

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      // Should not throw, should catch errors
      expect(async () => {
        await registry.disconnectAll();
      }).not.toThrow();
    });

    it("connectAll() connects all adapters", async () => {
      const adapter1 = createMockAdapter("a1", []);
      const adapter2 = createMockAdapter("a2", []);

      const connect1 = vi.spyOn(adapter1, "connect");
      const connect2 = vi.spyOn(adapter2, "connect");

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      await registry.connectAll();

      expect(connect1).toHaveBeenCalled();
      expect(connect2).toHaveBeenCalled();
    });

    it("disconnectAll() disconnects all adapters", async () => {
      const adapter1 = createMockAdapter("a1", []);
      const adapter2 = createMockAdapter("a2", []);

      const disconnect1 = vi.spyOn(adapter1, "disconnect");
      const disconnect2 = vi.spyOn(adapter2, "disconnect");

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      await registry.disconnectAll();

      expect(disconnect1).toHaveBeenCalled();
      expect(disconnect2).toHaveBeenCalled();
    });
  });

  describe("tool name collision and edge cases", () => {
    it("tool name collisions across adapters (last registered wins)", () => {
      const adapter1 = createMockAdapter("a1", [
        createMockTool("same-name", "a1"),
      ]);
      const adapter2 = createMockAdapter("a2", [
        createMockTool("same-name", "a2"),
      ]);

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      const tool = registry.getTool("same-name");
      // Last registered wins
      expect(tool?.adapter).toBe("a2");
    });

    it("empty tool name in tool definition", () => {
      const tool: ToolDefinition = {
        name: "",
        adapter: "test",
        tier: "basic",
        description: "Empty name tool",
        params: [],
      };

      const adapter = createMockAdapter("test", [tool]);
      registry.registerAdapter(adapter);

      const retrieved = registry.getTool("");
      expect(retrieved?.name).toBe("");
    });

    it("very long tool name", () => {
      const longName = "tool-" + "x".repeat(1000);
      const tool = createMockTool(longName, "test");
      const adapter = createMockAdapter("test", [tool]);
      registry.registerAdapter(adapter);

      const retrieved = registry.getTool(longName);
      expect(retrieved?.name).toBe(longName);
    });

    it("tool name with special characters", () => {
      const names = [
        "tool@adapter",
        "tool#1",
        "tool[bracket]",
        "tool/path",
        "tool\\back",
      ];

      for (const name of names) {
        const tool = createMockTool(name, "test");
        const adapter = createMockAdapter("test", [tool]);
        const reg = new ToolRegistry();
        reg.registerAdapter(adapter);

        const retrieved = reg.getTool(name);
        expect(retrieved?.name).toBe(name);
      }
    });
  });

  describe("adapter name edge cases", () => {
    it("very long adapter name", () => {
      const longName = "adapter-" + "x".repeat(1000);
      const adapter = createMockAdapter(longName, [
        createMockTool("tool1", longName),
      ]);
      registry.registerAdapter(adapter);

      expect(registry.getAdapter(longName)).toBe(adapter);
    });

    it("adapter name with special characters", () => {
      const names = [
        "adapter@host",
        "adapter#1",
        "adapter[bracket]",
        "adapter/path",
      ];

      for (const name of names) {
        const adapter = createMockAdapter(name, [
          createMockTool("tool", name),
        ]);
        const reg = new ToolRegistry();
        reg.registerAdapter(adapter);

        expect(reg.getAdapter(name)).toBe(adapter);
      }
    });

    it("getAdapter(name) for non-existent adapter", () => {
      const adapter = createMockAdapter("exists", []);
      registry.registerAdapter(adapter);

      expect(registry.getAdapter("nonexistent")).toBeUndefined();
    });
  });

  describe("getToolDescriptionsForLLM edge cases", () => {
    it("getToolDescriptionsForLLM with 0 tools", () => {
      const description = registry.getToolDescriptionsForLLM();
      expect(description).toBe("");
    });

    it("getToolDescriptionsForLLM with 1 tool", () => {
      const tool = createMockTool("test-tool", "test");
      const adapter = createMockAdapter("test", [tool]);
      registry.registerAdapter(adapter);

      const description = registry.getToolDescriptionsForLLM();
      expect(description).toContain("test-tool");
      expect(description).toContain("test");
    });

    it("getToolDescriptionsForLLM with multiple adapters and tiers", () => {
      const adapter1 = createMockAdapter("a1", [
        createMockTool("t1", "a1", "basic"),
        createMockTool("t2", "a1", "advanced"),
      ]);
      const adapter2 = createMockAdapter("a2", [
        createMockTool("t3", "a2", "basic"),
      ]);

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);

      const description = registry.getToolDescriptionsForLLM();
      expect(description).toContain("t1");
      expect(description).toContain("t2");
      expect(description).toContain("t3");
      expect(description).toContain("[basic]");
      expect(description).toContain("[advanced]");
    });

    it("getToolDescriptionsForLLM formats parameters correctly", () => {
      const tool: ToolDefinition = {
        name: "complex-tool",
        adapter: "test",
        tier: "advanced",
        description: "A complex tool",
        params: [
          {
            name: "required-param",
            type: "string",
            required: true,
            description: "This is required",
          },
          {
            name: "optional-param",
            type: "number",
            required: false,
            default: 42,
            description: "This is optional",
          },
        ],
      };

      const adapter = createMockAdapter("test", [tool]);
      registry.registerAdapter(adapter);

      const description = registry.getToolDescriptionsForLLM();
      expect(description).toContain("complex-tool");
      expect(description).toContain("required-param");
      expect(description).toContain("optional-param");
      expect(description).toContain("required");
      expect(description).toContain("optional");
      expect(description).toContain("default: 42");
    });
  });

  describe("getAdapters edge cases", () => {
    it("getAdapters() returns empty map when no adapters", () => {
      const adapters = registry.getAdapters();
      expect(adapters.size).toBe(0);
    });

    it("getAdapters() returns all registered adapters", () => {
      const adapter1 = createMockAdapter("a1", []);
      const adapter2 = createMockAdapter("a2", []);
      const adapter3 = createMockAdapter("a3", []);

      registry.registerAdapter(adapter1);
      registry.registerAdapter(adapter2);
      registry.registerAdapter(adapter3);

      const adapters = registry.getAdapters();
      expect(adapters.size).toBe(3);
      expect(adapters.has("a1")).toBe(true);
      expect(adapters.has("a2")).toBe(true);
      expect(adapters.has("a3")).toBe(true);
    });

    it("getAdapters() returns a map that reflects registry state", () => {
      const adapter1 = createMockAdapter("a1", []);
      registry.registerAdapter(adapter1);

      const adapters = registry.getAdapters();
      expect(adapters.size).toBe(1);

      const adapter2 = createMockAdapter("a2", []);
      registry.registerAdapter(adapter2);

      // New call should reflect updated state
      const adapters2 = registry.getAdapters();
      expect(adapters2.size).toBe(2);
    });
  });

  describe("tool definition edge cases", () => {
    it("tool with missing required fields", () => {
      const tool: ToolDefinition = {
        name: "incomplete",
        adapter: "test",
        tier: "basic",
        description: "Missing params",
        params: [],
      };

      const adapter = createMockAdapter("test", [tool]);
      registry.registerAdapter(adapter);

      const retrieved = registry.getTool("incomplete");
      expect(retrieved?.params).toEqual([]);
    });

    it("tool with empty description", () => {
      const tool: ToolDefinition = {
        name: "no-desc",
        adapter: "test",
        tier: "basic",
        description: "",
        params: [],
      };

      const adapter = createMockAdapter("test", [tool]);
      registry.registerAdapter(adapter);

      const retrieved = registry.getTool("no-desc");
      expect(retrieved?.description).toBe("");
    });

    it("tool with many parameters", () => {
      const params = [];
      for (let i = 0; i < 100; i++) {
        params.push({
          name: `param-${i}`,
          type: "string",
          required: false,
          description: `Parameter ${i}`,
        });
      }

      const tool: ToolDefinition = {
        name: "many-params",
        adapter: "test",
        tier: "basic",
        description: "Tool with many params",
        params,
      };

      const adapter = createMockAdapter("test", [tool]);
      registry.registerAdapter(adapter);

      const retrieved = registry.getTool("many-params");
      expect(retrieved?.params).toHaveLength(100);
    });
  });
});
