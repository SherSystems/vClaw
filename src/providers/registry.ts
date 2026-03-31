import type {
  ToolDefinition,
  ToolCallResult,
  InfraAdapter,
  ClusterState,
  MultiClusterState,
  ProviderType,
} from "./types.js";

export class ToolRegistry {
  private adapters: Map<string, InfraAdapter> = new Map();
  private tools: Map<string, ToolDefinition> = new Map();

  registerAdapter(adapter: InfraAdapter): void {
    this.adapters.set(adapter.name, adapter);
    for (const tool of adapter.getTools()) {
      this.tools.set(tool.name, tool);
    }
  }

  getAdapter(name: string): InfraAdapter | undefined {
    return this.adapters.get(name);
  }

  getAdapters(): Map<string, InfraAdapter> {
    return this.adapters;
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getToolsByAdapter(adapterName: string): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.adapter === adapterName
    );
  }

  getToolsByTier(tier: string): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => t.tier === tier);
  }

  async connectAll(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.connect();
      } catch (err) {
        console.error(`Failed to connect adapter ${name}:`, err);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
      } catch (err) {
        console.error(`Failed to disconnect adapter ${name}:`, err);
      }
    }
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolName}` };
    }

    const adapter = this.adapters.get(tool.adapter);
    if (!adapter) {
      return { success: false, error: `Adapter not found: ${tool.adapter}` };
    }

    if (!adapter.isConnected()) {
      return {
        success: false,
        error: `Adapter ${tool.adapter} is not connected`,
      };
    }

    return adapter.execute(toolName, params);
  }

  async getClusterState(): Promise<ClusterState | null> {
    for (const [, adapter] of this.adapters) {
      if (adapter.isConnected()) {
        return adapter.getClusterState();
      }
    }
    return null;
  }

  /**
   * Get cluster state from all connected providers.
   */
  async getMultiClusterState(): Promise<MultiClusterState> {
    const providers: MultiClusterState["providers"] = [];
    for (const [, adapter] of this.adapters) {
      if (adapter.isConnected() && adapter.name !== "system") {
        try {
          const state = await adapter.getClusterState();
          providers.push({
            name: adapter.name,
            type: adapter.name as ProviderType,
            state,
          });
        } catch {
          // Skip failed providers
        }
      }
    }
    return {
      providers,
      timestamp: new Date().toISOString(),
    };
  }

  getToolDescriptionsForLLM(): string {
    const tools = this.getAllTools();
    const grouped = new Map<string, ToolDefinition[]>();

    for (const tool of tools) {
      const list = grouped.get(tool.adapter) || [];
      list.push(tool);
      grouped.set(tool.adapter, list);
    }

    let output = "";
    for (const [adapter, adapterTools] of grouped) {
      output += `\n## ${adapter} tools\n\n`;
      for (const t of adapterTools) {
        output += `### ${t.name} [${t.tier}]\n`;
        output += `${t.description}\n`;
        if (t.params.length > 0) {
          output += `Parameters:\n`;
          for (const p of t.params) {
            const req = p.required ? "required" : "optional";
            const def = p.default !== undefined ? `, default: ${p.default}` : "";
            output += `  - ${p.name} (${p.type}, ${req}${def}): ${p.description}\n`;
          }
        }
        output += `\n`;
      }
    }

    return output;
  }
}
