// Backwards-compatible alias for the provider-owned Proxmox adapter.
import { ProxmoxAdapter as ProviderProxmoxAdapter } from "../../providers/proxmox/adapter.js";

export const ProxmoxAdapter = ProviderProxmoxAdapter;
export type { ProxmoxConfig } from "../../providers/proxmox/adapter.js";
