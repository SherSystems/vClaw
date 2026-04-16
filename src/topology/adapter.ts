// ============================================================
// vClaw — Topology Adapter
// Exposes application topology tools to the vClaw agent
// ============================================================

import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
  VMInfo,
} from '../providers/types.js';
import type { SSHExecFn } from '../migration/types.js';
import type { TopologyStore } from './store.js';
import { ConnectionDiscovery } from './discovery.js';
import type { ToolRegistry } from '../providers/registry.js';
import type { AppTier, WorkloadType, LatencyRequirement } from './types.js';
import type { ProviderType } from '../providers/types.js';

// ── Config ──────────────────────────────────────────────────

export interface TopologyAdapterConfig {
  store: TopologyStore;
  sshExec: SSHExecFn;
  registry: ToolRegistry;  // for resolving VM IPs during discovery
}

// ── Tool Definitions ────────────────────────────────────────

const ADAPTER_NAME = "topology";

function tool(
  name: string,
  description: string,
  tier: ToolDefinition["tier"],
  params: ToolDefinition["params"] = [],
  returns = "object",
): ToolDefinition {
  return { name, description, tier, adapter: ADAPTER_NAME, params, returns };
}

function param(
  name: string,
  type: string,
  required: boolean,
  description: string,
  defaultValue?: unknown,
): ToolDefinition["params"][number] {
  const p: ToolDefinition["params"][number] = { name, type, required, description };
  if (defaultValue !== undefined) p.default = defaultValue;
  return p;
}

// Commonly reused params
const appIdParam = param("app_id", "string", true, "Application ID");
const workloadIdParam = param("workload_id", "string", true, "Workload ID (VM or container identifier)");

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── Read Tools ────────────────────────────────────────────

  tool(
    "topology_list_apps",
    "List all applications with member count and dependency count",
    "read",
    [],
    "Application[] (summarized)",
  ),

  tool(
    "topology_get_app",
    "Get full application details including members and dependencies",
    "read",
    [appIdParam],
    "Application",
  ),

  tool(
    "topology_get_apps_for_vm",
    "Find which applications a VM or container belongs to",
    "read",
    [workloadIdParam],
    "Application[]",
  ),

  tool(
    "topology_impact_analysis",
    "Show what breaks if a VM or container goes offline — affected apps, broken dependencies, and severity",
    "read",
    [workloadIdParam],
    "ImpactReport",
  ),

  tool(
    "topology_discover_connections",
    "SSH into a VM, discover active network connections via ss, and resolve remote IPs to known workloads",
    "read",
    [
      param("host", "string", true, "SSH host to connect to (IP or hostname)"),
      param("user", "string", true, "SSH user"),
      param("vm_ip", "string", false, "IP address of the VM (used to tag discovered connections)"),
    ],
    "DiscoveredConnection[] with summary",
  ),

  tool(
    "topology_get_graph",
    "Get full topology graph for visualization — all workload nodes and dependency edges",
    "read",
    [],
    "TopologyGraph { nodes, edges }",
  ),

  // ── Safe Write Tools ──────────────────────────────────────

  tool(
    "topology_create_app",
    "Create a new application to group workloads together",
    "safe_write",
    [
      param("name", "string", true, "Application name (unique)"),
      param("tier", "string", true, "Application tier: production, staging, development, or test"),
      param("owner", "string", false, "Application owner name or team"),
      param("description", "string", false, "Description of the application"),
      param("tags", "string", false, "Comma-separated tags"),
    ],
    "Application",
  ),

  tool(
    "topology_update_app",
    "Update application metadata (name, tier, owner, description, tags)",
    "safe_write",
    [
      appIdParam,
      param("name", "string", false, "New application name"),
      param("tier", "string", false, "New tier: production, staging, development, or test"),
      param("owner", "string", false, "New owner name or team"),
      param("description", "string", false, "New description"),
      param("tags", "string", false, "Comma-separated tags (replaces existing)"),
    ],
    "Application",
  ),

  tool(
    "topology_add_member",
    "Add a VM or container to an application",
    "safe_write",
    [
      appIdParam,
      workloadIdParam,
      param("workload_type", "string", true, "Type: vm, container, pod, or service"),
      param("provider", "string", true, "Provider: proxmox, vmware, kubernetes, or aws"),
      param("role", "string", true, "Role in the application (e.g. web-server, database, cache)"),
      param("critical", "boolean", false, "Whether this workload is critical to the application", false),
    ],
    "AppMember",
  ),

  tool(
    "topology_remove_member",
    "Remove a VM or container from an application",
    "safe_write",
    [
      appIdParam,
      workloadIdParam,
    ],
    "void",
  ),

  tool(
    "topology_add_dependency",
    "Add a network dependency between two workloads within an application",
    "safe_write",
    [
      appIdParam,
      param("from_workload", "string", true, "Source workload ID (the one making the connection)"),
      param("to_workload", "string", true, "Target workload ID (the one being connected to)"),
      param("port", "number", true, "Target port number"),
      param("protocol", "string", false, "Protocol (tcp or udp)", "tcp"),
      param("service", "string", true, "Service name (e.g. postgresql, redis, http)"),
      param("latency_requirement", "string", false, "Latency requirement: low, medium, or any", "any"),
      param("description", "string", false, "Description of the dependency"),
    ],
    "AppDependency",
  ),

  tool(
    "topology_remove_dependency",
    "Remove a dependency from an application",
    "safe_write",
    [
      appIdParam,
      param("dependency_id", "string", true, "Dependency ID to remove"),
    ],
    "void",
  ),

  // ── Risky Write Tools ─────────────────────────────────────

  tool(
    "topology_delete_app",
    "Delete an application and all its members and dependencies",
    "risky_write",
    [appIdParam],
    "void",
  ),
];

// ── Adapter Class ───────────────────────────────────────────

export class TopologyAdapter implements InfraAdapter {
  name = "topology";
  private config: TopologyAdapterConfig;
  private discovery: ConnectionDiscovery;
  private _connected = false;

  constructor(config: TopologyAdapterConfig) {
    this.config = config;
    this.discovery = new ConnectionDiscovery();
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  async execute(tool: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      switch (tool) {
        case "topology_list_apps":
          return this.executeListApps();
        case "topology_get_app":
          return this.executeGetApp(params);
        case "topology_get_apps_for_vm":
          return this.executeGetAppsForVM(params);
        case "topology_impact_analysis":
          return this.executeImpactAnalysis(params);
        case "topology_discover_connections":
          return this.executeDiscoverConnections(params);
        case "topology_get_graph":
          return this.executeGetGraph();
        case "topology_create_app":
          return this.executeCreateApp(params);
        case "topology_update_app":
          return this.executeUpdateApp(params);
        case "topology_add_member":
          return this.executeAddMember(params);
        case "topology_remove_member":
          return this.executeRemoveMember(params);
        case "topology_add_dependency":
          return this.executeAddDependency(params);
        case "topology_remove_dependency":
          return this.executeRemoveDependency(params);
        case "topology_delete_app":
          return this.executeDeleteApp(params);
        default:
          return { success: false, error: `Unknown topology tool: ${tool}` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getClusterState(): Promise<ClusterState> {
    // Topology adapter doesn't have its own cluster state —
    // it references VMs from other providers
    return {
      adapter: "topology",
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private: Read Tools ───────────────────────────────────

  private executeListApps(): ToolCallResult {
    const apps = this.config.store.listApps();
    const summary = apps.map((app) => ({
      id: app.id,
      name: app.name,
      tier: app.tier,
      owner: app.owner,
      memberCount: app.members.length,
      dependencyCount: app.dependencies.length,
      tags: app.tags,
    }));
    return { success: true, data: summary };
  }

  private executeGetApp(params: Record<string, unknown>): ToolCallResult {
    const appId = params.app_id as string;
    if (!appId) return { success: false, error: "app_id is required" };

    const app = this.config.store.getApp(appId);
    if (!app) return { success: false, error: `Application not found: ${appId}` };

    return { success: true, data: app };
  }

  private executeGetAppsForVM(params: Record<string, unknown>): ToolCallResult {
    const workloadId = params.workload_id as string;
    if (!workloadId) return { success: false, error: "workload_id is required" };

    const apps = this.config.store.getAppsForWorkload(workloadId);
    return { success: true, data: apps };
  }

  private executeImpactAnalysis(params: Record<string, unknown>): ToolCallResult {
    const workloadId = params.workload_id as string;
    if (!workloadId) return { success: false, error: "workload_id is required" };

    const report = this.config.store.getImpactReport(workloadId);
    return { success: true, data: report };
  }

  private async executeDiscoverConnections(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = params.user as string;
    const vmIp = params.vm_ip as string | undefined;

    if (!host) return { success: false, error: "host is required" };
    if (!user) return { success: false, error: "user is required" };

    // 1. Discover connections via SSH
    const connections = await this.discovery.discoverConnections(
      this.config.sshExec,
      host,
      user,
      vmIp,
    );

    // 2. Resolve remote IPs to known workloads from all providers
    const multiState = await this.config.registry.getMultiClusterState();
    const allVMs: VMInfo[] = [];
    for (const provider of multiState.providers) {
      allVMs.push(...provider.state.vms);
    }

    this.discovery.resolveWorkloads(connections, allVMs);

    // 3. Save discovered connections to the store
    const workloadId = vmIp ?? host;
    this.config.store.saveDiscoveredConnections(workloadId, connections);

    // 4. Build a summary
    const resolved = connections.filter((c) => c.resolvedRemoteWorkloadId).length;
    const summary = {
      totalConnections: connections.length,
      resolvedToKnownWorkloads: resolved,
      unresolvedConnections: connections.length - resolved,
      uniqueRemoteAddresses: new Set(connections.map((c) => c.remoteAddr)).size,
    };

    return {
      success: true,
      data: {
        connections,
        summary,
      },
    };
  }

  private executeGetGraph(): ToolCallResult {
    const graph = this.config.store.getTopologyGraph();
    return { success: true, data: graph };
  }

  // ── Private: Safe Write Tools ─────────────────────────────

  private executeCreateApp(params: Record<string, unknown>): ToolCallResult {
    const name = params.name as string;
    const tier = params.tier as AppTier;

    if (!name) return { success: false, error: "name is required" };
    if (!tier) return { success: false, error: "tier is required" };

    const owner = params.owner as string | undefined;
    const description = params.description as string | undefined;
    const tags = params.tags
      ? (params.tags as string).split(",").map((t) => t.trim())
      : undefined;

    const app = this.config.store.createApp(name, tier, owner, description, tags);
    return { success: true, data: app };
  }

  private executeUpdateApp(params: Record<string, unknown>): ToolCallResult {
    const appId = params.app_id as string;
    if (!appId) return { success: false, error: "app_id is required" };

    const updates: Record<string, unknown> = {};
    if (params.name !== undefined) updates.name = params.name;
    if (params.tier !== undefined) updates.tier = params.tier;
    if (params.owner !== undefined) updates.owner = params.owner;
    if (params.description !== undefined) updates.description = params.description;
    if (params.tags !== undefined) {
      updates.tags = (params.tags as string).split(",").map((t) => t.trim());
    }

    const app = this.config.store.updateApp(appId, updates);
    return { success: true, data: app };
  }

  private executeAddMember(params: Record<string, unknown>): ToolCallResult {
    const appId = params.app_id as string;
    const workloadId = params.workload_id as string;
    const workloadType = params.workload_type as WorkloadType;
    const provider = params.provider as ProviderType;
    const role = params.role as string;
    const critical = params.critical === true || params.critical === "true";

    if (!appId) return { success: false, error: "app_id is required" };
    if (!workloadId) return { success: false, error: "workload_id is required" };
    if (!workloadType) return { success: false, error: "workload_type is required" };
    if (!provider) return { success: false, error: "provider is required" };
    if (!role) return { success: false, error: "role is required" };

    const member = this.config.store.addMember(appId, {
      workloadId,
      workloadType,
      provider,
      role,
      critical,
    });
    return { success: true, data: member };
  }

  private executeRemoveMember(params: Record<string, unknown>): ToolCallResult {
    const appId = params.app_id as string;
    const workloadId = params.workload_id as string;

    if (!appId) return { success: false, error: "app_id is required" };
    if (!workloadId) return { success: false, error: "workload_id is required" };

    this.config.store.removeMember(appId, workloadId);
    return { success: true, data: { removed: true } };
  }

  private executeAddDependency(params: Record<string, unknown>): ToolCallResult {
    const appId = params.app_id as string;
    const fromWorkload = params.from_workload as string;
    const toWorkload = params.to_workload as string;
    const port = params.port as number;
    const protocol = (params.protocol as string) ?? "tcp";
    const service = params.service as string;
    const latencyRequirement = (params.latency_requirement as LatencyRequirement) ?? "any";
    const description = params.description as string | undefined;

    if (!appId) return { success: false, error: "app_id is required" };
    if (!fromWorkload) return { success: false, error: "from_workload is required" };
    if (!toWorkload) return { success: false, error: "to_workload is required" };
    if (port === undefined || port === null) return { success: false, error: "port is required" };
    if (!service) return { success: false, error: "service is required" };

    const dep = this.config.store.addDependency(appId, {
      fromWorkloadId: fromWorkload,
      toWorkloadId: toWorkload,
      port,
      protocol,
      service,
      latencyRequirement,
      description,
    });
    return { success: true, data: dep };
  }

  private executeRemoveDependency(params: Record<string, unknown>): ToolCallResult {
    const appId = params.app_id as string;
    const depId = params.dependency_id as string;

    if (!appId) return { success: false, error: "app_id is required" };
    if (!depId) return { success: false, error: "dependency_id is required" };

    this.config.store.removeDependency(appId, depId);
    return { success: true, data: { removed: true } };
  }

  // ── Private: Risky Write Tools ────────────────────────────

  private executeDeleteApp(params: Record<string, unknown>): ToolCallResult {
    const appId = params.app_id as string;
    if (!appId) return { success: false, error: "app_id is required" };

    // Verify app exists before deleting
    const app = this.config.store.getApp(appId);
    if (!app) return { success: false, error: `Application not found: ${appId}` };

    this.config.store.deleteApp(appId);
    return { success: true, data: { deleted: true, appName: app.name } };
  }
}
