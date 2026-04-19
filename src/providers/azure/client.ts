// ============================================================
// vClaw — Azure ARM API Client
// Wraps @azure/arm-* SDKs for Compute, Network, and Resources
// ============================================================

import { ClientSecretCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { NetworkManagementClient } from "@azure/arm-network";
import { ResourceManagementClient } from "@azure/arm-resources";
import { StorageManagementClient } from "@azure/arm-storage";

import type {
  AzureClientConfig,
  AzureVMSummary,
  AzureVMDetail,
  AzureVMPowerState,
  AzureDiskInfo,
  AzureDiskState,
  AzureSnapshotInfo,
  AzureImageInfo,
  AzureVNetInfo,
  AzureSubnetInfo,
  AzureNSGInfo,
  AzureNSGRule,
  AzureResourceGroupInfo,
} from "./types.js";

// ── Azure ID parsers ────────────────────────────────────────

export function parseResourceGroupFromId(id: string | undefined): string {
  if (!id) return "";
  // /subscriptions/{sub}/resourceGroups/{rg}/providers/...
  const match = id.match(/\/resourceGroups\/([^/]+)/i);
  return match ? match[1] : "";
}

export function parsePowerState(statuses: Array<{ code?: string }> | undefined): AzureVMPowerState {
  if (!statuses) return "unknown";
  const powerStatus = statuses.find((s) => s.code?.startsWith("PowerState/"));
  if (!powerStatus?.code) return "unknown";
  const state = powerStatus.code.replace("PowerState/", "").toLowerCase();
  switch (state) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "deallocated":
      return "deallocated";
    case "starting":
      return "starting";
    case "stopping":
      return "stopping";
    case "deallocating":
      return "deallocating";
    default:
      return "unknown";
  }
}

// ── Client ──────────────────────────────────────────────────

export class AzureClient {
  readonly subscriptionId: string;
  readonly defaultLocation: string;
  private compute: ComputeManagementClient;
  private network: NetworkManagementClient;
  private resources: ResourceManagementClient;
  private storage: StorageManagementClient;
  private connected = false;

  constructor(config: AzureClientConfig) {
    this.subscriptionId = config.subscriptionId;
    this.defaultLocation = config.defaultLocation ?? "eastus";

    const credential = new ClientSecretCredential(
      config.tenantId,
      config.clientId,
      config.clientSecret,
    );

    this.compute = new ComputeManagementClient(credential, config.subscriptionId);
    this.network = new NetworkManagementClient(credential, config.subscriptionId);
    this.resources = new ResourceManagementClient(credential, config.subscriptionId);
    this.storage = new StorageManagementClient(credential, config.subscriptionId);
  }

  // ── Connection ─────────────────────────────────────────────

  async connect(): Promise<void> {
    // Verify credentials by listing resource groups (cheap, scoped op)
    const iter = this.resources.resourceGroups.list();
    await iter.next();
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Resource Groups ────────────────────────────────────────

  async listResourceGroups(): Promise<AzureResourceGroupInfo[]> {
    const out: AzureResourceGroupInfo[] = [];
    for await (const rg of this.resources.resourceGroups.list()) {
      out.push({
        id: rg.id ?? "",
        name: rg.name ?? "",
        location: rg.location ?? "",
        provisioningState: rg.properties?.provisioningState ?? "",
        tags: (rg.tags ?? {}) as Record<string, string>,
      });
    }
    return out;
  }

  async ensureResourceGroup(name: string, location?: string): Promise<AzureResourceGroupInfo> {
    const rg = await this.resources.resourceGroups.createOrUpdate(name, {
      location: location ?? this.defaultLocation,
    });
    return {
      id: rg.id ?? "",
      name: rg.name ?? name,
      location: rg.location ?? location ?? this.defaultLocation,
      provisioningState: rg.properties?.provisioningState ?? "",
      tags: (rg.tags ?? {}) as Record<string, string>,
    };
  }

  // ── Virtual Machines ───────────────────────────────────────

  async listVMs(resourceGroup?: string): Promise<AzureVMSummary[]> {
    const iter = resourceGroup
      ? this.compute.virtualMachines.list(resourceGroup)
      : this.compute.virtualMachines.listAll();

    const out: AzureVMSummary[] = [];
    for await (const vm of iter) {
      const rg = parseResourceGroupFromId(vm.id);
      out.push({
        id: vm.id ?? "",
        name: vm.name ?? "",
        resourceGroup: rg,
        location: vm.location ?? "",
        vmSize: vm.hardwareProfile?.vmSize ?? "",
        powerState: "unknown",
        provisioningState: vm.provisioningState ?? "",
        zones: vm.zones,
        osType: vm.storageProfile?.osDisk?.osType as "Linux" | "Windows" | undefined,
        imageReference: this.formatImageReference(vm.storageProfile?.imageReference),
      });
    }
    return out;
  }

  async getVM(resourceGroup: string, vmName: string): Promise<AzureVMDetail> {
    const vm = await this.compute.virtualMachines.get(resourceGroup, vmName, {
      expand: "instanceView",
    });
    if (!vm) {
      throw new Error(`VM not found: ${vmName} in ${resourceGroup}`);
    }

    const nicIds = (vm.networkProfile?.networkInterfaces ?? [])
      .map((n) => n.id ?? "")
      .filter(Boolean);

    const dataDiskIds = (vm.storageProfile?.dataDisks ?? [])
      .map((d) => d.managedDisk?.id ?? "")
      .filter(Boolean);

    return {
      id: vm.id ?? "",
      name: vm.name ?? "",
      resourceGroup,
      location: vm.location ?? "",
      vmSize: vm.hardwareProfile?.vmSize ?? "",
      powerState: parsePowerState(vm.instanceView?.statuses),
      provisioningState: vm.provisioningState ?? "",
      zones: vm.zones,
      osType: vm.storageProfile?.osDisk?.osType as "Linux" | "Windows" | undefined,
      imageReference: this.formatImageReference(vm.storageProfile?.imageReference),
      adminUsername: vm.osProfile?.adminUsername,
      networkInterfaceIds: nicIds,
      osDiskId: vm.storageProfile?.osDisk?.managedDisk?.id,
      dataDiskIds,
      tags: (vm.tags ?? {}) as Record<string, string>,
    };
  }

  async startVM(resourceGroup: string, vmName: string): Promise<void> {
    await this.compute.virtualMachines.beginStartAndWait(resourceGroup, vmName);
  }

  async deallocateVM(resourceGroup: string, vmName: string): Promise<void> {
    await this.compute.virtualMachines.beginDeallocateAndWait(resourceGroup, vmName);
  }

  async restartVM(resourceGroup: string, vmName: string): Promise<void> {
    await this.compute.virtualMachines.beginRestartAndWait(resourceGroup, vmName);
  }

  async deleteVM(resourceGroup: string, vmName: string): Promise<void> {
    await this.compute.virtualMachines.beginDeleteAndWait(resourceGroup, vmName);
  }

  async createVM(params: {
    resourceGroup: string;
    name: string;
    location?: string;
    vmSize: string;
    imageReference: {
      publisher: string;
      offer: string;
      sku: string;
      version: string;
    };
    adminUsername: string;
    adminPassword?: string;
    sshPublicKey?: string;
    subnetId: string;
    osType?: "Linux" | "Windows";
  }): Promise<AzureVMSummary> {
    const location = params.location ?? this.defaultLocation;

    // Create NIC first
    const nicName = `${params.name}-nic`;
    const nicPoller = await this.network.networkInterfaces.beginCreateOrUpdate(
      params.resourceGroup,
      nicName,
      {
        location,
        ipConfigurations: [
          {
            name: "ipconfig1",
            subnet: { id: params.subnetId },
            privateIPAllocationMethod: "Dynamic",
          },
        ],
      },
    );
    const nic = await nicPoller.pollUntilDone();
    if (!nic.id) {
      throw new Error("Failed to create network interface for VM");
    }

    const osProfile: Record<string, unknown> = {
      computerName: params.name,
      adminUsername: params.adminUsername,
    };
    if (params.sshPublicKey) {
      osProfile.linuxConfiguration = {
        disablePasswordAuthentication: true,
        ssh: {
          publicKeys: [
            {
              path: `/home/${params.adminUsername}/.ssh/authorized_keys`,
              keyData: params.sshPublicKey,
            },
          ],
        },
      };
    } else if (params.adminPassword) {
      osProfile.adminPassword = params.adminPassword;
    }

    const vmPoller = await this.compute.virtualMachines.beginCreateOrUpdate(
      params.resourceGroup,
      params.name,
      {
        location,
        hardwareProfile: { vmSize: params.vmSize },
        storageProfile: {
          imageReference: params.imageReference,
          osDisk: {
            createOption: "FromImage",
            managedDisk: { storageAccountType: "Standard_LRS" },
          },
        },
        osProfile,
        networkProfile: {
          networkInterfaces: [{ id: nic.id, primary: true }],
        },
      },
    );
    const vm = await vmPoller.pollUntilDone();

    return {
      id: vm.id ?? "",
      name: vm.name ?? params.name,
      resourceGroup: params.resourceGroup,
      location,
      vmSize: params.vmSize,
      powerState: "unknown",
      provisioningState: vm.provisioningState ?? "",
      osType: params.osType,
    };
  }

  async createVMFromManagedDisk(params: {
    resourceGroup: string;
    name: string;
    location?: string;
    vmSize: string;
    osDiskId: string;
    subnetId: string;
    osType?: "Linux" | "Windows";
  }): Promise<AzureVMSummary> {
    const location = params.location ?? this.defaultLocation;

    // Create NIC first
    const nicName = `${params.name}-nic`;
    const nicPoller = await this.network.networkInterfaces.beginCreateOrUpdate(
      params.resourceGroup,
      nicName,
      {
        location,
        ipConfigurations: [
          {
            name: "ipconfig1",
            subnet: { id: params.subnetId },
            privateIPAllocationMethod: "Dynamic",
          },
        ],
      },
    );
    const nic = await nicPoller.pollUntilDone();
    if (!nic.id) {
      throw new Error("Failed to create network interface for VM");
    }

    const vmPoller = await this.compute.virtualMachines.beginCreateOrUpdate(
      params.resourceGroup,
      params.name,
      {
        location,
        hardwareProfile: { vmSize: params.vmSize },
        storageProfile: {
          osDisk: {
            createOption: "Attach",
            managedDisk: { id: params.osDiskId },
            osType: params.osType ?? "Linux",
          },
        },
        networkProfile: {
          networkInterfaces: [{ id: nic.id, primary: true }],
        },
      },
    );
    const vm = await vmPoller.pollUntilDone();

    return {
      id: vm.id ?? "",
      name: vm.name ?? params.name,
      resourceGroup: params.resourceGroup,
      location,
      vmSize: params.vmSize,
      powerState: "unknown",
      provisioningState: vm.provisioningState ?? "",
      osType: params.osType,
    };
  }

  // ── Disks ──────────────────────────────────────────────────

  async listDisks(resourceGroup?: string): Promise<AzureDiskInfo[]> {
    const iter = resourceGroup
      ? this.compute.disks.listByResourceGroup(resourceGroup)
      : this.compute.disks.list();

    const out: AzureDiskInfo[] = [];
    for await (const disk of iter) {
      out.push({
        id: disk.id ?? "",
        name: disk.name ?? "",
        resourceGroup: parseResourceGroupFromId(disk.id),
        location: disk.location ?? "",
        sizeGB: disk.diskSizeGB ?? 0,
        diskState: (disk.diskState ?? "Unknown") as AzureDiskState,
        skuName: disk.sku?.name,
        encrypted: Boolean(disk.encryption?.diskEncryptionSetId || disk.encryptionSettingsCollection?.enabled),
        attachedVmId: disk.managedBy,
      });
    }
    return out;
  }

  async createManagedDiskFromImport(params: {
    resourceGroup: string;
    name: string;
    sourceUri: string;
    storageAccountId: string;
    location?: string;
    osType?: "Linux" | "Windows";
  }): Promise<AzureDiskInfo> {
    const location = params.location ?? this.defaultLocation;
    const disk = await this.compute.disks.beginCreateOrUpdateAndWait(
      params.resourceGroup,
      params.name,
      {
        location,
        creationData: {
          createOption: "Import",
          sourceUri: params.sourceUri,
          storageAccountId: params.storageAccountId,
        },
        osType: params.osType,
        sku: { name: "Standard_LRS" },
      },
    );

    return {
      id: disk.id ?? "",
      name: disk.name ?? params.name,
      resourceGroup: params.resourceGroup,
      location: disk.location ?? location,
      sizeGB: disk.diskSizeGB ?? 0,
      diskState: (disk.diskState ?? "Unknown") as AzureDiskState,
      skuName: disk.sku?.name,
      encrypted: Boolean(disk.encryption?.diskEncryptionSetId || disk.encryptionSettingsCollection?.enabled),
      attachedVmId: disk.managedBy,
    };
  }

  async deleteDisk(resourceGroup: string, diskName: string): Promise<void> {
    await this.compute.disks.beginDeleteAndWait(resourceGroup, diskName);
  }

  async createSnapshot(params: {
    resourceGroup: string;
    name: string;
    sourceDiskId: string;
    location?: string;
  }): Promise<AzureSnapshotInfo> {
    const location = params.location ?? this.defaultLocation;
    const poller = await this.compute.snapshots.beginCreateOrUpdateAndWait(
      params.resourceGroup,
      params.name,
      {
        location,
        creationData: {
          createOption: "Copy",
          sourceResourceId: params.sourceDiskId,
        },
      },
    );

    return {
      id: poller.id ?? "",
      name: poller.name ?? params.name,
      resourceGroup: params.resourceGroup,
      location,
      sizeGB: poller.diskSizeGB ?? 0,
      sourceDiskId: params.sourceDiskId,
      provisioningState: poller.provisioningState ?? "",
      timeCreated: poller.timeCreated?.toISOString(),
      encrypted: Boolean(poller.encryption?.diskEncryptionSetId),
    };
  }

  // ── Images ─────────────────────────────────────────────────

  async listImages(resourceGroup?: string): Promise<AzureImageInfo[]> {
    const iter = resourceGroup
      ? this.compute.images.listByResourceGroup(resourceGroup)
      : this.compute.images.list();

    const out: AzureImageInfo[] = [];
    for await (const img of iter) {
      out.push({
        id: img.id ?? "",
        name: img.name ?? "",
        resourceGroup: parseResourceGroupFromId(img.id),
        location: img.location ?? "",
        osType: img.storageProfile?.osDisk?.osType as "Linux" | "Windows" | undefined,
        provisioningState: img.provisioningState ?? "",
        sourceVirtualMachineId: img.sourceVirtualMachine?.id,
      });
    }
    return out;
  }

  async createImageFromVM(params: {
    resourceGroup: string;
    imageName: string;
    vmId: string;
    location?: string;
  }): Promise<string> {
    const location = params.location ?? this.defaultLocation;
    const poller = await this.compute.images.beginCreateOrUpdateAndWait(
      params.resourceGroup,
      params.imageName,
      {
        location,
        sourceVirtualMachine: { id: params.vmId },
      },
    );
    if (!poller.id) {
      throw new Error("Failed to create image — no imageId returned");
    }
    return poller.id;
  }

  async deleteImage(resourceGroup: string, imageName: string): Promise<void> {
    await this.compute.images.beginDeleteAndWait(resourceGroup, imageName);
  }

  // ── Networking ─────────────────────────────────────────────

  async listVNets(resourceGroup?: string): Promise<AzureVNetInfo[]> {
    const iter = resourceGroup
      ? this.network.virtualNetworks.list(resourceGroup)
      : this.network.virtualNetworks.listAll();

    const out: AzureVNetInfo[] = [];
    for await (const vnet of iter) {
      out.push({
        id: vnet.id ?? "",
        name: vnet.name ?? "",
        resourceGroup: parseResourceGroupFromId(vnet.id),
        location: vnet.location ?? "",
        addressSpaces: vnet.addressSpace?.addressPrefixes ?? [],
        subnetCount: vnet.subnets?.length ?? 0,
      });
    }
    return out;
  }

  async listSubnets(resourceGroup: string, vnetName: string): Promise<AzureSubnetInfo[]> {
    const out: AzureSubnetInfo[] = [];
    for await (const subnet of this.network.subnets.list(resourceGroup, vnetName)) {
      out.push({
        id: subnet.id ?? "",
        name: subnet.name ?? "",
        resourceGroup,
        vnetName,
        addressPrefix: subnet.addressPrefix ?? "",
        nsgId: subnet.networkSecurityGroup?.id,
      });
    }
    return out;
  }

  async listNSGs(resourceGroup?: string): Promise<AzureNSGInfo[]> {
    const iter = resourceGroup
      ? this.network.networkSecurityGroups.list(resourceGroup)
      : this.network.networkSecurityGroups.listAll();

    const out: AzureNSGInfo[] = [];
    for await (const nsg of iter) {
      const rules: AzureNSGRule[] = (nsg.securityRules ?? []).map((r) => ({
        name: r.name ?? "",
        direction: (r.direction ?? "Inbound") as "Inbound" | "Outbound",
        access: (r.access ?? "Allow") as "Allow" | "Deny",
        protocol: r.protocol ?? "",
        priority: r.priority ?? 0,
        sourcePortRange: r.sourcePortRange,
        destinationPortRange: r.destinationPortRange,
        sourceAddressPrefix: r.sourceAddressPrefix,
        destinationAddressPrefix: r.destinationAddressPrefix,
        description: r.description,
      }));

      out.push({
        id: nsg.id ?? "",
        name: nsg.name ?? "",
        resourceGroup: parseResourceGroupFromId(nsg.id),
        location: nsg.location ?? "",
        rules,
      });
    }
    return out;
  }

  // ── Storage ────────────────────────────────────────────────

  async ensureStorageAccount(params: {
    resourceGroup: string;
    accountName: string;
    location?: string;
  }): Promise<{ id: string; name: string; location: string }> {
    const location = params.location ?? this.defaultLocation;
    const account = await this.storage.storageAccounts.beginCreateAndWait(
      params.resourceGroup,
      params.accountName,
      {
        kind: "StorageV2",
        location,
        sku: { name: "Standard_LRS" },
      },
    );

    if (!account.id || !account.name) {
      throw new Error(`Failed to create or resolve storage account ${params.accountName}`);
    }

    return {
      id: account.id,
      name: account.name,
      location: account.location ?? location,
    };
  }

  async ensureBlobContainer(resourceGroup: string, accountName: string, containerName: string): Promise<void> {
    await this.storage.blobContainers.create(resourceGroup, accountName, containerName, {});
  }

  async getStorageAccountKey(resourceGroup: string, accountName: string): Promise<string> {
    const keys = await this.storage.storageAccounts.listKeys(resourceGroup, accountName);
    const key = keys.keys?.find((candidate) => Boolean(candidate.value))?.value;
    if (!key) {
      throw new Error(`Unable to retrieve storage key for account ${accountName}`);
    }
    return key;
  }

  // ── Helpers ────────────────────────────────────────────────

  private formatImageReference(ref: {
    publisher?: string;
    offer?: string;
    sku?: string;
    version?: string;
    id?: string;
  } | undefined): string | undefined {
    if (!ref) return undefined;
    if (ref.id) return ref.id;
    if (ref.publisher && ref.offer && ref.sku) {
      return `${ref.publisher}:${ref.offer}:${ref.sku}:${ref.version ?? "latest"}`;
    }
    return undefined;
  }
}
