import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────

vi.mock("@azure/identity", () => ({
  ClientSecretCredential: class {
    constructor(_tenant: string, _client: string, _secret: string) {}
  },
}));

const computeMock = {
  virtualMachines: {
    list: vi.fn(),
    listAll: vi.fn(),
    get: vi.fn(),
    beginStartAndWait: vi.fn(),
    beginDeallocateAndWait: vi.fn(),
    beginRestartAndWait: vi.fn(),
    beginDeleteAndWait: vi.fn(),
    beginCreateOrUpdate: vi.fn(),
  },
  disks: {
    list: vi.fn(),
    listByResourceGroup: vi.fn(),
  },
  snapshots: {
    beginCreateOrUpdateAndWait: vi.fn(),
  },
  images: {
    list: vi.fn(),
    listByResourceGroup: vi.fn(),
    beginCreateOrUpdateAndWait: vi.fn(),
    beginDeleteAndWait: vi.fn(),
  },
};

const networkMock = {
  virtualNetworks: {
    list: vi.fn(),
    listAll: vi.fn(),
  },
  subnets: {
    list: vi.fn(),
  },
  networkSecurityGroups: {
    list: vi.fn(),
    listAll: vi.fn(),
  },
  networkInterfaces: {
    beginCreateOrUpdate: vi.fn(),
  },
};

const resourcesMock = {
  resourceGroups: {
    list: vi.fn(),
  },
};

vi.mock("@azure/arm-compute", () => ({
  ComputeManagementClient: class {
    virtualMachines = computeMock.virtualMachines;
    disks = computeMock.disks;
    snapshots = computeMock.snapshots;
    images = computeMock.images;
    constructor(_cred: unknown, _sub: string) {}
  },
}));

vi.mock("@azure/arm-network", () => ({
  NetworkManagementClient: class {
    virtualNetworks = networkMock.virtualNetworks;
    subnets = networkMock.subnets;
    networkSecurityGroups = networkMock.networkSecurityGroups;
    networkInterfaces = networkMock.networkInterfaces;
    constructor(_cred: unknown, _sub: string) {}
  },
}));

vi.mock("@azure/arm-resources", () => ({
  ResourceManagementClient: class {
    resourceGroups = resourcesMock.resourceGroups;
    constructor(_cred: unknown, _sub: string) {}
  },
}));

import { AzureClient, parseResourceGroupFromId, parsePowerState } from "../../src/providers/azure/client.js";

// Helper to build an async iterator from an array
async function* toAsyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function resetAllMocks() {
  const allMocks = [
    ...Object.values(computeMock.virtualMachines),
    ...Object.values(computeMock.disks),
    ...Object.values(computeMock.snapshots),
    ...Object.values(computeMock.images),
    ...Object.values(networkMock.virtualNetworks),
    ...Object.values(networkMock.subnets),
    ...Object.values(networkMock.networkSecurityGroups),
    ...Object.values(networkMock.networkInterfaces),
    ...Object.values(resourcesMock.resourceGroups),
  ];
  for (const m of allMocks) m.mockReset();
}

// ── Helper Tests ────────────────────────────────────────────

describe("parseResourceGroupFromId", () => {
  it("extracts resource group from a full ARM id", () => {
    expect(parseResourceGroupFromId(
      "/subscriptions/abc/resourceGroups/my-rg/providers/Microsoft.Compute/virtualMachines/vm1"
    )).toBe("my-rg");
  });

  it("is case-insensitive on 'resourceGroups'", () => {
    expect(parseResourceGroupFromId(
      "/subscriptions/abc/resourcegroups/other-rg/providers/X"
    )).toBe("other-rg");
  });

  it("returns empty string for undefined", () => {
    expect(parseResourceGroupFromId(undefined)).toBe("");
  });

  it("returns empty string when no match", () => {
    expect(parseResourceGroupFromId("/not/a/real/path")).toBe("");
  });
});

describe("parsePowerState", () => {
  it("maps PowerState/running to running", () => {
    expect(parsePowerState([{ code: "PowerState/running" }])).toBe("running");
  });

  it("maps PowerState/deallocated to deallocated", () => {
    expect(parsePowerState([{ code: "PowerState/deallocated" }])).toBe("deallocated");
  });

  it("ignores non-PowerState codes", () => {
    expect(parsePowerState([{ code: "ProvisioningState/succeeded" }])).toBe("unknown");
  });

  it("returns unknown for undefined / unrecognized", () => {
    expect(parsePowerState(undefined)).toBe("unknown");
    expect(parsePowerState([{ code: "PowerState/weird" }])).toBe("unknown");
  });
});

// ── Client Tests ────────────────────────────────────────────

describe("AzureClient", () => {
  let client: AzureClient;

  beforeEach(() => {
    resetAllMocks();
    client = new AzureClient({
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      subscriptionId: "sub-1",
      defaultLocation: "eastus2",
    });
  });

  describe("connection", () => {
    it("connect calls resourceGroups.list and flips state", async () => {
      resourcesMock.resourceGroups.list.mockReturnValue(toAsyncIter([]));
      expect(client.isConnected()).toBe(false);
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(resourcesMock.resourceGroups.list).toHaveBeenCalled();
    });

    it("disconnect sets isConnected to false", async () => {
      resourcesMock.resourceGroups.list.mockReturnValue(toAsyncIter([]));
      await client.connect();
      client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it("exposes subscriptionId and defaultLocation", () => {
      expect(client.subscriptionId).toBe("sub-1");
      expect(client.defaultLocation).toBe("eastus2");
    });

    it("defaults location to eastus when not provided", () => {
      const c = new AzureClient({
        tenantId: "t", clientId: "c", clientSecret: "s", subscriptionId: "sub",
      });
      expect(c.defaultLocation).toBe("eastus");
    });
  });

  describe("listResourceGroups", () => {
    it("maps response and coerces missing fields", async () => {
      resourcesMock.resourceGroups.list.mockReturnValue(toAsyncIter([
        {
          id: "/subscriptions/sub-1/resourceGroups/rg-1",
          name: "rg-1",
          location: "eastus",
          properties: { provisioningState: "Succeeded" },
          tags: { env: "prod" },
        },
        { id: "/subscriptions/sub-1/resourceGroups/rg-2", name: "rg-2" },
      ]));

      const rgs = await client.listResourceGroups();
      expect(rgs).toHaveLength(2);
      expect(rgs[0]).toEqual({
        id: "/subscriptions/sub-1/resourceGroups/rg-1",
        name: "rg-1",
        location: "eastus",
        provisioningState: "Succeeded",
        tags: { env: "prod" },
      });
      expect(rgs[1].location).toBe("");
      expect(rgs[1].tags).toEqual({});
    });
  });

  describe("listVMs", () => {
    it("uses listAll when no resource group given", async () => {
      computeMock.virtualMachines.listAll.mockReturnValue(toAsyncIter([
        {
          id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm1",
          name: "vm1",
          location: "eastus",
          hardwareProfile: { vmSize: "Standard_B2s" },
          provisioningState: "Succeeded",
          zones: ["1"],
          storageProfile: {
            osDisk: { osType: "Linux" },
            imageReference: {
              publisher: "Canonical", offer: "UbuntuServer", sku: "22_04-lts", version: "latest",
            },
          },
        },
      ]));

      const vms = await client.listVMs();
      expect(computeMock.virtualMachines.list).not.toHaveBeenCalled();
      expect(vms).toHaveLength(1);
      expect(vms[0].name).toBe("vm1");
      expect(vms[0].resourceGroup).toBe("rg-1");
      expect(vms[0].vmSize).toBe("Standard_B2s");
      expect(vms[0].osType).toBe("Linux");
      expect(vms[0].imageReference).toBe("Canonical:UbuntuServer:22_04-lts:latest");
      expect(vms[0].powerState).toBe("unknown");
    });

    it("uses list(resourceGroup) when given", async () => {
      computeMock.virtualMachines.list.mockReturnValue(toAsyncIter([]));
      await client.listVMs("rg-1");
      expect(computeMock.virtualMachines.list).toHaveBeenCalledWith("rg-1");
      expect(computeMock.virtualMachines.listAll).not.toHaveBeenCalled();
    });

    it("formats image reference from id when set", async () => {
      computeMock.virtualMachines.listAll.mockReturnValue(toAsyncIter([
        {
          id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm",
          name: "vm",
          storageProfile: { imageReference: { id: "/some/custom/image/id" } },
        },
      ]));
      const [vm] = await client.listVMs();
      expect(vm.imageReference).toBe("/some/custom/image/id");
    });

    it("returns undefined imageReference when neither id nor publisher triplet", async () => {
      computeMock.virtualMachines.listAll.mockReturnValue(toAsyncIter([
        { id: "/subscriptions/s/resourceGroups/rg/providers/x/vm", name: "vm" },
      ]));
      const [vm] = await client.listVMs();
      expect(vm.imageReference).toBeUndefined();
    });
  });

  describe("getVM", () => {
    it("returns detailed VM with power state from instanceView", async () => {
      computeMock.virtualMachines.get.mockResolvedValue({
        id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm1",
        name: "vm1",
        location: "eastus",
        hardwareProfile: { vmSize: "Standard_B2s" },
        provisioningState: "Succeeded",
        instanceView: {
          statuses: [
            { code: "ProvisioningState/succeeded" },
            { code: "PowerState/running" },
          ],
        },
        osProfile: { adminUsername: "azureuser" },
        networkProfile: { networkInterfaces: [{ id: "nic-1" }] },
        storageProfile: {
          osDisk: { osType: "Linux", managedDisk: { id: "os-disk-1" } },
          dataDisks: [{ managedDisk: { id: "data-1" } }, { managedDisk: { id: "data-2" } }],
        },
        tags: { env: "prod" },
      });

      const vm = await client.getVM("rg-1", "vm1");
      expect(vm.powerState).toBe("running");
      expect(vm.adminUsername).toBe("azureuser");
      expect(vm.networkInterfaceIds).toEqual(["nic-1"]);
      expect(vm.osDiskId).toBe("os-disk-1");
      expect(vm.dataDiskIds).toEqual(["data-1", "data-2"]);
      expect(vm.tags).toEqual({ env: "prod" });
      expect(computeMock.virtualMachines.get).toHaveBeenCalledWith("rg-1", "vm1", { expand: "instanceView" });
    });

    it("throws when VM is null/undefined", async () => {
      computeMock.virtualMachines.get.mockResolvedValue(null as unknown as object);
      await expect(client.getVM("rg-1", "missing")).rejects.toThrow("VM not found");
    });
  });

  describe("VM lifecycle", () => {
    it("startVM calls beginStartAndWait", async () => {
      computeMock.virtualMachines.beginStartAndWait.mockResolvedValue(undefined);
      await client.startVM("rg-1", "vm1");
      expect(computeMock.virtualMachines.beginStartAndWait).toHaveBeenCalledWith("rg-1", "vm1");
    });

    it("deallocateVM, restartVM, deleteVM call their respective begin*AndWait", async () => {
      computeMock.virtualMachines.beginDeallocateAndWait.mockResolvedValue(undefined);
      computeMock.virtualMachines.beginRestartAndWait.mockResolvedValue(undefined);
      computeMock.virtualMachines.beginDeleteAndWait.mockResolvedValue(undefined);

      await client.deallocateVM("rg", "vm");
      await client.restartVM("rg", "vm");
      await client.deleteVM("rg", "vm");

      expect(computeMock.virtualMachines.beginDeallocateAndWait).toHaveBeenCalledWith("rg", "vm");
      expect(computeMock.virtualMachines.beginRestartAndWait).toHaveBeenCalledWith("rg", "vm");
      expect(computeMock.virtualMachines.beginDeleteAndWait).toHaveBeenCalledWith("rg", "vm");
    });
  });

  describe("createVM", () => {
    it("creates NIC then VM and returns summary; uses SSH key when provided", async () => {
      networkMock.networkInterfaces.beginCreateOrUpdate.mockResolvedValue({
        pollUntilDone: () => Promise.resolve({ id: "/nic/my-vm-nic" }),
      });
      const vmPollResult = { id: "/vm/id", name: "my-vm", provisioningState: "Succeeded" };
      computeMock.virtualMachines.beginCreateOrUpdate.mockResolvedValue({
        pollUntilDone: () => Promise.resolve(vmPollResult),
      });

      const result = await client.createVM({
        resourceGroup: "rg-1",
        name: "my-vm",
        vmSize: "Standard_B2s",
        imageReference: {
          publisher: "Canonical", offer: "UbuntuServer", sku: "22_04-lts", version: "latest",
        },
        adminUsername: "azureuser",
        sshPublicKey: "ssh-rsa AAAA",
        subnetId: "/sub/id",
      });

      expect(result.id).toBe("/vm/id");
      expect(result.resourceGroup).toBe("rg-1");
      expect(result.location).toBe("eastus2"); // from default
      expect(networkMock.networkInterfaces.beginCreateOrUpdate).toHaveBeenCalled();
      expect(computeMock.virtualMachines.beginCreateOrUpdate).toHaveBeenCalled();

      // Inspect VM creation args — should have SSH config, not password
      const vmCallArgs = computeMock.virtualMachines.beginCreateOrUpdate.mock.calls[0][2];
      expect(vmCallArgs.osProfile.adminPassword).toBeUndefined();
      expect(vmCallArgs.osProfile.linuxConfiguration.ssh.publicKeys[0].keyData).toBe("ssh-rsa AAAA");
      expect(vmCallArgs.networkProfile.networkInterfaces[0].id).toBe("/nic/my-vm-nic");
    });

    it("uses adminPassword when no SSH key provided", async () => {
      networkMock.networkInterfaces.beginCreateOrUpdate.mockResolvedValue({
        pollUntilDone: () => Promise.resolve({ id: "/nic/id" }),
      });
      computeMock.virtualMachines.beginCreateOrUpdate.mockResolvedValue({
        pollUntilDone: () => Promise.resolve({ id: "/vm/id" }),
      });

      await client.createVM({
        resourceGroup: "rg",
        name: "vm",
        vmSize: "Standard_B2s",
        imageReference: { publisher: "MS", offer: "Win", sku: "2022", version: "latest" },
        adminUsername: "admin",
        adminPassword: "P@ssw0rd!",
        subnetId: "/sub/id",
      });

      const vmCallArgs = computeMock.virtualMachines.beginCreateOrUpdate.mock.calls[0][2];
      expect(vmCallArgs.osProfile.adminPassword).toBe("P@ssw0rd!");
      expect(vmCallArgs.osProfile.linuxConfiguration).toBeUndefined();
    });

    it("throws when NIC creation returns no id", async () => {
      networkMock.networkInterfaces.beginCreateOrUpdate.mockResolvedValue({
        pollUntilDone: () => Promise.resolve({}),
      });

      await expect(client.createVM({
        resourceGroup: "rg", name: "vm", vmSize: "Standard_B2s",
        imageReference: { publisher: "p", offer: "o", sku: "s", version: "v" },
        adminUsername: "admin",
        adminPassword: "p",
        subnetId: "/sub/id",
      })).rejects.toThrow("Failed to create network interface");
    });
  });

  describe("disks", () => {
    it("listDisks uses listByResourceGroup when rg provided", async () => {
      computeMock.disks.listByResourceGroup.mockReturnValue(toAsyncIter([
        {
          id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/disks/d1",
          name: "d1",
          location: "eastus",
          diskSizeGB: 128,
          diskState: "Attached",
          sku: { name: "Premium_LRS" },
          encryption: { diskEncryptionSetId: "/some/cmk" },
          managedBy: "/vm/vm1",
        },
      ]));

      const disks = await client.listDisks("rg-1");
      expect(disks).toHaveLength(1);
      expect(disks[0]).toMatchObject({
        id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/disks/d1",
        sizeGB: 128,
        diskState: "Attached",
        skuName: "Premium_LRS",
        encrypted: true,
        attachedVmId: "/vm/vm1",
      });
    });

    it("listDisks uses list() when no rg provided", async () => {
      computeMock.disks.list.mockReturnValue(toAsyncIter([]));
      await client.listDisks();
      expect(computeMock.disks.list).toHaveBeenCalled();
    });

    it("encrypted=false when neither encryption set nor collection", async () => {
      computeMock.disks.list.mockReturnValue(toAsyncIter([
        { id: "/rg/d", name: "d", diskSizeGB: 10 },
      ]));
      const [disk] = await client.listDisks();
      expect(disk.encrypted).toBe(false);
    });
  });

  describe("snapshots", () => {
    it("createSnapshot passes location + copy creationData and maps result", async () => {
      computeMock.snapshots.beginCreateOrUpdateAndWait.mockResolvedValue({
        id: "/snap/id",
        name: "snap-1",
        diskSizeGB: 100,
        provisioningState: "Succeeded",
        timeCreated: new Date("2026-01-01T00:00:00Z"),
      });

      const result = await client.createSnapshot({
        resourceGroup: "rg-1",
        name: "snap-1",
        sourceDiskId: "/disk/id",
      });

      expect(result.id).toBe("/snap/id");
      expect(result.sourceDiskId).toBe("/disk/id");
      expect(result.timeCreated).toBe("2026-01-01T00:00:00.000Z");
      expect(computeMock.snapshots.beginCreateOrUpdateAndWait).toHaveBeenCalledWith(
        "rg-1",
        "snap-1",
        expect.objectContaining({
          location: "eastus2",
          creationData: { createOption: "Copy", sourceResourceId: "/disk/id" },
        }),
      );
    });
  });

  describe("images", () => {
    it("listImages routes by presence of resourceGroup arg", async () => {
      computeMock.images.list.mockReturnValue(toAsyncIter([]));
      computeMock.images.listByResourceGroup.mockReturnValue(toAsyncIter([]));

      await client.listImages();
      expect(computeMock.images.list).toHaveBeenCalled();

      await client.listImages("rg-1");
      expect(computeMock.images.listByResourceGroup).toHaveBeenCalledWith("rg-1");
    });

    it("createImageFromVM returns id from the operation result", async () => {
      computeMock.images.beginCreateOrUpdateAndWait.mockResolvedValue({ id: "/img/id" });
      const id = await client.createImageFromVM({
        resourceGroup: "rg-1",
        imageName: "img-1",
        vmId: "/vm/id",
      });
      expect(id).toBe("/img/id");
    });

    it("createImageFromVM throws when no id returned", async () => {
      computeMock.images.beginCreateOrUpdateAndWait.mockResolvedValue({});
      await expect(client.createImageFromVM({
        resourceGroup: "rg", imageName: "i", vmId: "/v",
      })).rejects.toThrow("Failed to create image");
    });

    it("deleteImage calls beginDeleteAndWait", async () => {
      computeMock.images.beginDeleteAndWait.mockResolvedValue(undefined);
      await client.deleteImage("rg-1", "img-1");
      expect(computeMock.images.beginDeleteAndWait).toHaveBeenCalledWith("rg-1", "img-1");
    });
  });

  describe("networking", () => {
    it("listVNets uses listAll then maps", async () => {
      networkMock.virtualNetworks.listAll.mockReturnValue(toAsyncIter([
        {
          id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Network/virtualNetworks/vnet1",
          name: "vnet1",
          location: "eastus",
          addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
          subnets: [{}, {}],
        },
      ]));
      const vnets = await client.listVNets();
      expect(vnets[0].addressSpaces).toEqual(["10.0.0.0/16"]);
      expect(vnets[0].subnetCount).toBe(2);
    });

    it("listSubnets maps addressPrefix and nsgId", async () => {
      networkMock.subnets.list.mockReturnValue(toAsyncIter([
        {
          id: "/sub/id",
          name: "sub-1",
          addressPrefix: "10.0.1.0/24",
          networkSecurityGroup: { id: "/nsg/id" },
        },
      ]));
      const subs = await client.listSubnets("rg-1", "vnet1");
      expect(subs[0]).toMatchObject({
        id: "/sub/id",
        name: "sub-1",
        vnetName: "vnet1",
        resourceGroup: "rg-1",
        addressPrefix: "10.0.1.0/24",
        nsgId: "/nsg/id",
      });
    });

    it("listNSGs maps security rules", async () => {
      networkMock.networkSecurityGroups.listAll.mockReturnValue(toAsyncIter([
        {
          id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Network/networkSecurityGroups/nsg1",
          name: "nsg1",
          location: "eastus",
          securityRules: [{
            name: "allow-ssh",
            direction: "Inbound",
            access: "Allow",
            protocol: "Tcp",
            priority: 100,
            sourcePortRange: "*",
            destinationPortRange: "22",
            sourceAddressPrefix: "Internet",
            destinationAddressPrefix: "*",
          }],
        },
      ]));

      const nsgs = await client.listNSGs();
      expect(nsgs[0].rules).toHaveLength(1);
      expect(nsgs[0].rules[0]).toMatchObject({
        name: "allow-ssh",
        direction: "Inbound",
        access: "Allow",
        protocol: "Tcp",
        priority: 100,
        destinationPortRange: "22",
      });
    });
  });
});
