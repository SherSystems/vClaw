// ============================================================
// vClaw — VMware vSphere Adapter
// Implements InfraAdapter and registers all VMware tools
// ============================================================

import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
  NodeInfo,
  VMInfo,
  StorageInfo,
} from "../types.js";

import { VSphereClient } from "./client.js";
import type { VmPowerState, HostConnectionState } from "./types.js";

// ── Config ──────────────────────────────────────────────────

export interface VMwareConfig {
  host: string;
  user: string;
  password: string;
  insecure?: boolean;
}

// ── Tool Definitions ────────────────────────────────────────

const ADAPTER_NAME = "vmware";

function tool(
  name: string,
  description: string,
  tier: ToolDefinition["tier"],
  params: ToolDefinition["params"] = [],
  returns = "object"
): ToolDefinition {
  return { name, description, tier, adapter: ADAPTER_NAME, params, returns };
}

function param(
  name: string,
  type: string,
  required: boolean,
  description: string,
  defaultValue?: unknown
): ToolDefinition["params"][number] {
  const p: ToolDefinition["params"][number] = { name, type, required, description };
  if (defaultValue !== undefined) p.default = defaultValue;
  return p;
}

const vmIdParam = param("vm_id", "string", true, "VM identifier (e.g. vm-42)");
const hostIdParam = param("host_id", "string", true, "Host identifier (e.g. host-10)");
const dsIdParam = param("datastore_id", "string", true, "Datastore identifier (e.g. datastore-15)");
const clusterIdParam = param("cluster_id", "string", true, "Cluster identifier (e.g. domain-c8)");
const snapshotIdParam = param("snapshot_id", "string", true, "Snapshot identifier");

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── Read Tools ────────────────────────────────────────────

  tool("vmware_list_vms", "List all VMs in vCenter, optionally filtered", "read", [
    param("filter_names", "string", false, "Filter by VM name (comma-separated)"),
    param("filter_power_states", "string", false, "Filter by power state (POWERED_ON, POWERED_OFF, SUSPENDED)"),
  ], "VmSummary[]"),

  tool("vmware_get_vm", "Get detailed info about a specific VM", "read", [
    vmIdParam,
  ], "VmInfo"),

  tool("vmware_list_hosts", "List all ESXi hosts managed by vCenter", "read", [], "HostSummary[]"),

  tool("vmware_get_host", "Get detailed info about a specific ESXi host", "read", [
    hostIdParam,
  ], "HostInfo"),

  tool("vmware_list_datastores", "List all datastores in vCenter", "read", [], "DatastoreSummary[]"),

  tool("vmware_get_datastore", "Get detailed info about a specific datastore", "read", [
    dsIdParam,
  ], "DatastoreInfo"),

  tool("vmware_list_networks", "List all networks in vCenter", "read", [], "NetworkSummary[]"),

  tool("vmware_list_clusters", "List all clusters in vCenter", "read", [], "ClusterSummary[]"),

  tool("vmware_list_resource_pools", "List all resource pools in vCenter", "read", [], "ResourcePoolSummary[]"),

  tool("vmware_get_vm_guest", "Get guest OS info for a VM (requires VMware Tools)", "read", [
    vmIdParam,
  ], "GuestInfo"),

  tool("vmware_list_snapshots", "List all snapshots for a VM", "read", [
    vmIdParam,
  ], "SnapshotSummary[]"),

  // ── Safe Write Tools ──────────────────────────────────────

  tool("vmware_vm_power_on", "Power on a VM", "safe_write", [
    vmIdParam,
  ], "void"),

  tool("vmware_create_snapshot", "Create a snapshot of a VM", "safe_write", [
    vmIdParam,
    param("name", "string", true, "Snapshot name"),
    param("description", "string", false, "Snapshot description"),
    param("memory", "boolean", false, "Include VM memory in snapshot", false),
  ], "string"),

  // ── Risky Write Tools ─────────────────────────────────────

  tool("vmware_vm_power_off", "Power off a VM (hard stop)", "risky_write", [
    vmIdParam,
  ], "void"),

  tool("vmware_vm_reset", "Reset a VM (hard reboot)", "risky_write", [
    vmIdParam,
  ], "void"),

  tool("vmware_vm_suspend", "Suspend a VM", "risky_write", [
    vmIdParam,
  ], "void"),

  tool("vmware_create_vm", "Create a new VM from spec", "risky_write", [
    param("name", "string", true, "VM name"),
    param("guest_OS", "string", true, "Guest OS identifier (e.g. OTHER_LINUX_64)"),
    param("datastore", "string", false, "Target datastore identifier"),
    param("resource_pool", "string", false, "Resource pool identifier"),
    param("folder", "string", false, "VM folder identifier"),
    param("host", "string", false, "Target host identifier"),
    param("cluster", "string", false, "Cluster identifier"),
    param("cpu_count", "number", false, "Number of CPUs", 2),
    param("memory_MiB", "number", false, "Memory in MiB", 2048),
    param("disk_capacity_bytes", "number", false, "Primary disk capacity in bytes"),
  ], "string"),

  tool("vmware_delete_snapshot", "Delete a snapshot from a VM", "risky_write", [
    vmIdParam,
    snapshotIdParam,
  ], "void"),

  tool("vmware_revert_snapshot", "Revert a VM to a snapshot", "risky_write", [
    vmIdParam,
    snapshotIdParam,
  ], "void"),

  // ── Destructive Tools ─────────────────────────────────────

  tool("vmware_delete_vm", "Permanently delete a VM and its disks", "destructive", [
    vmIdParam,
  ], "void"),
];

// ── Adapter ─────────────────────────────────────────────────

export class VMwareAdapter implements InfraAdapter {
  readonly name = ADAPTER_NAME;
  private client: VSphereClient;
  private _connected = false;

  constructor(config: VMwareConfig) {
    this.client = new VSphereClient({
      host: config.host,
      user: config.user,
      password: config.password,
      insecure: config.insecure,
    });
  }

  async connect(): Promise<void> {
    await this.client.createSession();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    await this.client.deleteSession();
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  // ── Execute ─────────────────────────────────────────────

  async execute(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !k.startsWith("_")),
    );
    try {
      const data = await this.dispatch(toolName, cleanParams);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async dispatch(
    toolName: string,
    p: Record<string, unknown>
  ): Promise<unknown> {
    switch (toolName) {
      // ── Read ────────────────────────────────────────────
      case "vmware_list_vms": {
        const filter: Record<string, string> = {};
        if (p.filter_names) filter["filter.names"] = p.filter_names as string;
        if (p.filter_power_states) filter["filter.power_states"] = p.filter_power_states as string;
        return this.client.listVMs(Object.keys(filter).length > 0 ? filter : undefined);
      }

      case "vmware_get_vm":
        return this.client.getVM(p.vm_id as string);

      case "vmware_list_hosts":
        return this.client.listHosts();

      case "vmware_get_host":
        return this.client.getHost(p.host_id as string);

      case "vmware_list_datastores":
        return this.client.listDatastores();

      case "vmware_get_datastore":
        return this.client.getDatastore(p.datastore_id as string);

      case "vmware_list_networks":
        return this.client.listNetworks();

      case "vmware_list_clusters":
        return this.client.listClusters();

      case "vmware_list_resource_pools":
        return this.client.listResourcePools();

      case "vmware_get_vm_guest":
        return this.client.getVMGuest(p.vm_id as string);

      case "vmware_list_snapshots":
        return this.client.listSnapshots(p.vm_id as string);

      // ── Safe Write ──────────────────────────────────────
      case "vmware_vm_power_on":
        return this.client.vmPowerOn(p.vm_id as string);

      case "vmware_create_snapshot":
        return this.client.createSnapshot(
          p.vm_id as string,
          p.name as string,
          p.description as string | undefined,
          p.memory as boolean | undefined,
        );

      // ── Risky Write ─────────────────────────────────────
      case "vmware_vm_power_off":
        return this.client.vmPowerOff(p.vm_id as string);

      case "vmware_vm_reset":
        return this.client.vmReset(p.vm_id as string);

      case "vmware_vm_suspend":
        return this.client.vmSuspend(p.vm_id as string);

      case "vmware_create_vm": {
        const spec: Record<string, unknown> = {
          name: p.name as string,
          guest_OS: p.guest_OS as string,
        };
        if (p.datastore || p.resource_pool || p.folder || p.host || p.cluster) {
          const placement: Record<string, unknown> = {};
          if (p.datastore) placement.datastore = p.datastore;
          if (p.resource_pool) placement.resource_pool = p.resource_pool;
          if (p.folder) placement.folder = p.folder;
          if (p.host) placement.host = p.host;
          if (p.cluster) placement.cluster = p.cluster;
          spec.placement = placement;
        }
        if (p.cpu_count) {
          spec.cpu = { count: p.cpu_count };
        }
        if (p.memory_MiB) {
          spec.memory = { size_MiB: p.memory_MiB };
        }
        if (p.disk_capacity_bytes) {
          spec.disks = [{ new_vmdk: { capacity: p.disk_capacity_bytes } }];
        }
        return this.client.createVM(spec as any);
      }

      case "vmware_delete_snapshot":
        return this.client.deleteSnapshot(
          p.vm_id as string,
          p.snapshot_id as string,
        );

      case "vmware_revert_snapshot":
        return this.client.revertSnapshot(
          p.vm_id as string,
          p.snapshot_id as string,
        );

      // ── Destructive ─────────────────────────────────────
      case "vmware_delete_vm":
        return this.client.deleteVM(p.vm_id as string);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ── Cluster State ───────────────────────────────────────

  async getClusterState(): Promise<ClusterState> {
    const [rawHosts, rawVMs, rawDatastores] = await Promise.all([
      this.client.listHosts(),
      this.client.listVMs(),
      this.client.listDatastores(),
    ]);

    // Map ESXi hosts → NodeInfo
    const nodes: NodeInfo[] = [];
    for (const h of rawHosts) {
      let hostInfo;
      try {
        hostInfo = await this.client.getHost(h.host);
      } catch {
        // Host may be unreachable
      }

      nodes.push({
        id: h.host,
        name: h.name,
        status: this.mapHostStatus(h.connection_state),
        cpu_cores: 0, // Not available from list endpoint
        cpu_usage_pct: 0,
        ram_total_mb: 0,
        ram_used_mb: 0,
        disk_total_gb: 0,
        disk_used_gb: 0,
        disk_usage_pct: 0,
        uptime_s: 0,
      });
    }

    // Map VMs → VMInfo
    const vms: VMInfo[] = rawVMs.map((vm) => ({
      id: vm.vm,
      name: vm.name,
      node: "",  // vSphere VMs don't expose host in summary
      status: this.mapVmPowerState(vm.power_state),
      cpu_cores: vm.cpu_count ?? 0,
      ram_mb: vm.memory_size_MiB ?? 0,
      disk_gb: 0,
    }));

    // Map Datastores → StorageInfo
    const storage: StorageInfo[] = rawDatastores.map((ds) => ({
      id: ds.datastore,
      node: "",
      type: ds.type,
      total_gb: ds.capacity ? Math.round((ds.capacity / 1024 / 1024 / 1024) * 10) / 10 : 0,
      used_gb:
        ds.capacity && ds.free_space
          ? Math.round(((ds.capacity - ds.free_space) / 1024 / 1024 / 1024) * 10) / 10
          : 0,
      available_gb: ds.free_space ? Math.round((ds.free_space / 1024 / 1024 / 1024) * 10) / 10 : 0,
      content: ["vmdk", "iso"],
    }));

    return {
      adapter: ADAPTER_NAME,
      nodes,
      vms,
      containers: [],  // VMware doesn't have containers
      storage,
      timestamp: new Date().toISOString(),
    };
  }

  private mapHostStatus(state: HostConnectionState): NodeInfo["status"] {
    switch (state) {
      case "CONNECTED":
        return "online";
      case "DISCONNECTED":
      case "NOT_RESPONDING":
        return "offline";
      default:
        return "unknown";
    }
  }

  private mapVmPowerState(state: VmPowerState): VMInfo["status"] {
    switch (state) {
      case "POWERED_ON":
        return "running";
      case "POWERED_OFF":
        return "stopped";
      case "SUSPENDED":
        return "paused";
      default:
        return "unknown";
    }
  }
}
