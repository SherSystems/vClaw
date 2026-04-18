// ============================================================
// vClaw — Azure ARM Resource Types
// Typed interfaces matching @azure/arm-* response shapes
// ============================================================

// ── VM Types ────────────────────────────────────────────────

export type AzureVMPowerState =
  | "running"
  | "stopped"
  | "deallocated"
  | "starting"
  | "stopping"
  | "deallocating"
  | "unknown";

export interface AzureVMSummary {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  vmSize: string;
  powerState: AzureVMPowerState;
  provisioningState: string;
  zones?: string[];
  osType?: "Linux" | "Windows";
  privateIp?: string;
  publicIp?: string;
  imageReference?: string;
}

export interface AzureVMDetail extends AzureVMSummary {
  adminUsername?: string;
  networkInterfaceIds: string[];
  osDiskId?: string;
  dataDiskIds: string[];
  tags: Record<string, string>;
}

// ── Disk Types ──────────────────────────────────────────────

export type AzureDiskState =
  | "Unattached"
  | "Attached"
  | "Reserved"
  | "ActiveSAS"
  | "ReadyToUpload"
  | "ActiveUpload"
  | "Unknown";

export interface AzureDiskInfo {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  sizeGB: number;
  diskState: AzureDiskState;
  skuName?: string;
  encrypted: boolean;
  attachedVmId?: string;
}

// ── Snapshot Types ──────────────────────────────────────────

export interface AzureSnapshotInfo {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  sizeGB: number;
  sourceDiskId?: string;
  provisioningState: string;
  timeCreated?: string;
  encrypted: boolean;
}

// ── Image Types ─────────────────────────────────────────────

export interface AzureImageInfo {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  osType?: "Linux" | "Windows";
  provisioningState: string;
  sourceVirtualMachineId?: string;
}

// ── Network Types ───────────────────────────────────────────

export interface AzureVNetInfo {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  addressSpaces: string[];
  subnetCount: number;
}

export interface AzureSubnetInfo {
  id: string;
  name: string;
  resourceGroup: string;
  vnetName: string;
  addressPrefix: string;
  nsgId?: string;
}

export interface AzureNSGRule {
  name: string;
  direction: "Inbound" | "Outbound";
  access: "Allow" | "Deny";
  protocol: string;
  priority: number;
  sourcePortRange?: string;
  destinationPortRange?: string;
  sourceAddressPrefix?: string;
  destinationAddressPrefix?: string;
  description?: string;
}

export interface AzureNSGInfo {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  rules: AzureNSGRule[];
}

// ── Resource Group ──────────────────────────────────────────

export interface AzureResourceGroupInfo {
  id: string;
  name: string;
  location: string;
  provisioningState: string;
  tags: Record<string, string>;
}

// ── Client Config ───────────────────────────────────────────

export interface AzureClientConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  defaultLocation?: string;
}

// ── VM Size Specs ───────────────────────────────────────────

export interface AzureVMSizeSpec {
  name: string;
  vCPU: number;
  memoryMiB: number;
}
