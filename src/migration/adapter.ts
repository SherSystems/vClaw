// ============================================================
// vClaw — Migration Adapter
// Exposes cross-provider migration as tools in the adapter system
// ============================================================

import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
} from "../providers/types.js";
import type { VSphereClient } from "../providers/vmware/client.js";
import type { ProxmoxClient } from "../providers/proxmox/client.js";
import type { SSHExecFn } from "./types.js";
import { MigrationOrchestrator } from "./orchestrator.js";

export interface MigrationAdapterConfig {
  vsphereClient: VSphereClient;
  proxmoxClient: ProxmoxClient;
  sshExec: SSHExecFn;
  esxiHost: string;
  esxiUser?: string;
  proxmoxHost: string;
  proxmoxUser?: string;
  proxmoxNode: string;
  proxmoxStorage?: string;
}

export class MigrationAdapter implements InfraAdapter {
  name = "migration";
  private config: MigrationAdapterConfig;
  private _connected = false;

  constructor(config: MigrationAdapterConfig) {
    this.config = config;
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
    return [
      {
        name: "migrate_vmware_to_proxmox",
        description:
          "Migrate a VM from VMware vSphere to Proxmox VE. " +
          "Exports the VM config, transfers and converts the disk (vmdk -> qcow2), " +
          "then creates a new VM on Proxmox with the imported disk. " +
          "The source VM will be powered off during migration.",
        tier: "risky_write",
        adapter: "migration",
        params: [
          {
            name: "vm_id",
            type: "string",
            required: true,
            description: "VMware VM identifier (e.g. vm-1234)",
          },
          {
            name: "target_vmid",
            type: "number",
            required: false,
            description: "Specific Proxmox VMID to use (auto-assigned if omitted)",
          },
          {
            name: "target_storage",
            type: "string",
            required: false,
            description: "Proxmox storage for the imported disk (default: local-lvm)",
          },
          {
            name: "target_node",
            type: "string",
            required: false,
            description: "Proxmox node name (default: from adapter config)",
          },
        ],
        returns: "MigrationPlan with status, steps, and target VM details",
      },
      {
        name: "plan_migration_vmware_to_proxmox",
        description:
          "Dry-run planning for VMware -> Proxmox migration. " +
          "Reads VM config and validates connectivity without making changes. " +
          "Use this to preview what will happen before running the actual migration.",
        tier: "read",
        adapter: "migration",
        params: [
          {
            name: "vm_id",
            type: "string",
            required: true,
            description: "VMware VM identifier (e.g. vm-1234)",
          },
        ],
        returns: "MigrationPlan (dry-run) with VM config and planned steps",
      },
      {
        name: "migrate_proxmox_to_vmware",
        description:
          "Migrate a VM from Proxmox VE to VMware vSphere. " +
          "Exports the VM config, converts the disk (raw/qcow2 -> vmdk), " +
          "uploads to ESXi datastore, and creates a new VM on vSphere. " +
          "The source VM will be stopped during migration.",
        tier: "risky_write",
        adapter: "migration",
        params: [
          {
            name: "vm_id",
            type: "number",
            required: true,
            description: "Proxmox VMID (e.g. 112)",
          },
        ],
        returns: "MigrationPlan with status, steps, and target vSphere VM details",
      },
      {
        name: "plan_migration_proxmox_to_vmware",
        description:
          "Dry-run planning for Proxmox -> VMware migration. " +
          "Reads VM config and validates connectivity without making changes.",
        tier: "read",
        adapter: "migration",
        params: [
          {
            name: "vm_id",
            type: "number",
            required: true,
            description: "Proxmox VMID (e.g. 112)",
          },
        ],
        returns: "MigrationPlan (dry-run) with VM config and planned steps",
      },
    ];
  }

  async execute(tool: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    switch (tool) {
      case "migrate_vmware_to_proxmox":
        return this.executeVMwareToProxmox(params);
      case "plan_migration_vmware_to_proxmox":
        return this.executePlanVMwareToProxmox(params);
      case "migrate_proxmox_to_vmware":
        return this.executeProxmoxToVMware(params);
      case "plan_migration_proxmox_to_vmware":
        return this.executePlanProxmoxToVMware(params);
      default:
        return { success: false, error: `Unknown migration tool: ${tool}` };
    }
  }

  async getClusterState(): Promise<ClusterState> {
    // Migration adapter doesn't have its own cluster state
    return {
      adapter: "migration",
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private ────────────────────────────────────────────────

  private async executeVMwareToProxmox(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };

    const orchestrator = this.createOrchestrator({
      proxmoxNode: (params.target_node as string) ?? this.config.proxmoxNode,
      proxmoxStorage: (params.target_storage as string) ?? this.config.proxmoxStorage,
    });

    try {
      const plan = await orchestrator.migrateVMwareToProxmox(vmId);
      return { success: true, data: plan };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executePlanVMwareToProxmox(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as string;
    if (!vmId) return { success: false, error: "vm_id is required" };

    const orchestrator = this.createOrchestrator();

    try {
      const plan = await orchestrator.planMigration(vmId);
      return { success: true, data: plan };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executeProxmoxToVMware(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as number;
    if (vmId === undefined || vmId === null) return { success: false, error: "vm_id is required" };

    const orchestrator = this.createOrchestrator();

    try {
      const plan = await orchestrator.migrateProxmoxToVMware(vmId);
      return { success: true, data: plan };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executePlanProxmoxToVMware(params: Record<string, unknown>): Promise<ToolCallResult> {
    const vmId = params.vm_id as number;
    if (vmId === undefined || vmId === null) return { success: false, error: "vm_id is required" };

    const orchestrator = this.createOrchestrator();

    try {
      const plan = await orchestrator.planProxmoxToVMware(vmId);
      return { success: true, data: plan };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private createOrchestrator(overrides: Partial<MigrationAdapterConfig> = {}): MigrationOrchestrator {
    return new MigrationOrchestrator({
      vsphereClient: this.config.vsphereClient,
      proxmoxClient: this.config.proxmoxClient,
      sshExec: this.config.sshExec,
      esxiHost: overrides.esxiHost ?? this.config.esxiHost,
      esxiUser: overrides.esxiUser ?? this.config.esxiUser,
      proxmoxHost: overrides.proxmoxHost ?? this.config.proxmoxHost,
      proxmoxUser: overrides.proxmoxUser ?? this.config.proxmoxUser,
      proxmoxNode: overrides.proxmoxNode ?? this.config.proxmoxNode,
      proxmoxStorage: overrides.proxmoxStorage ?? this.config.proxmoxStorage,
    });
  }
}
