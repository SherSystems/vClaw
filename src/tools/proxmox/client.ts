// Re-export from new location for backwards compatibility
export { ProxmoxClient } from "../../providers/proxmox/client.js";
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
