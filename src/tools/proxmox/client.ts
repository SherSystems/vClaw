// Backwards-compatible alias for the provider-owned Proxmox client.
import { ProxmoxClient as ProviderProxmoxClient } from "../../providers/proxmox/client.js";

export const ProxmoxClient = ProviderProxmoxClient;
export type {
  ProxmoxClientConfig,
  ProxmoxResponse,
  ProxmoxNode,
  ProxmoxNodeStats,
  ProxmoxVM,
  ProxmoxVMStatus,
  ProxmoxVMConfig,
  ProxmoxSnapshot,
  ProxmoxStorage,
  ProxmoxISO,
  ProxmoxTemplate,
  ProxmoxTask,
  ProxmoxTaskStatus,
  ProxmoxNetworkInterface,
  ProxmoxFirewallRule,
  ProxmoxSyslogEntry,
  CreateVMParams,
  CreateCTParams,
  CloneVMParams,
  MigrateVMParams,
} from "../../providers/proxmox/client.js";
