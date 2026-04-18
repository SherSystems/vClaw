import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/providers/azure/client.js", () => {
  const mockClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    listResourceGroups: vi.fn().mockResolvedValue([]),
    listVMs: vi.fn().mockResolvedValue([
      {
        id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/web-1",
        name: "web-1",
        resourceGroup: "rg-1",
        location: "eastus",
        vmSize: "Standard_B2s",
        powerState: "running",
        provisioningState: "Succeeded",
      },
      {
        id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/db-1",
        name: "db-1",
        resourceGroup: "rg-1",
        location: "westus",
        vmSize: "Standard_D4s_v5",
        powerState: "deallocated",
        provisioningState: "Succeeded",
      },
    ]),
    getVM: vi.fn().mockResolvedValue({
      id: "/vm/id",
      name: "web-1",
      resourceGroup: "rg-1",
      location: "eastus",
      vmSize: "Standard_B2s",
      powerState: "running",
      provisioningState: "Succeeded",
      networkInterfaceIds: [],
      dataDiskIds: [],
      tags: {},
    }),
    listDisks: vi.fn().mockResolvedValue([
      {
        id: "/disk/1",
        name: "os-disk-1",
        resourceGroup: "rg-1",
        location: "eastus",
        sizeGB: 30,
        diskState: "Attached",
        skuName: "Premium_LRS",
        encrypted: true,
        attachedVmId: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/web-1",
      },
      {
        id: "/disk/2",
        name: "data-unattached",
        resourceGroup: "rg-1",
        location: "centralus",
        sizeGB: 500,
        diskState: "Unattached",
        skuName: "Standard_LRS",
        encrypted: false,
      },
    ]),
    listVNets: vi.fn().mockResolvedValue([]),
    listSubnets: vi.fn().mockResolvedValue([]),
    listNSGs: vi.fn().mockResolvedValue([]),
    listImages: vi.fn().mockResolvedValue([]),
    startVM: vi.fn().mockResolvedValue(undefined),
    deallocateVM: vi.fn().mockResolvedValue(undefined),
    restartVM: vi.fn().mockResolvedValue(undefined),
    deleteVM: vi.fn().mockResolvedValue(undefined),
    createVM: vi.fn().mockResolvedValue({
      id: "/vm/new",
      name: "new-vm",
      resourceGroup: "rg-1",
      location: "eastus",
      vmSize: "Standard_B2s",
      powerState: "unknown",
      provisioningState: "Succeeded",
    }),
    createSnapshot: vi.fn().mockResolvedValue({
      id: "/snap/id", name: "snap-1", resourceGroup: "rg-1", location: "eastus",
      sizeGB: 30, provisioningState: "Succeeded", encrypted: true,
    }),
    createImageFromVM: vi.fn().mockResolvedValue("/img/id"),
    deleteImage: vi.fn().mockResolvedValue(undefined),
  };

  class AzureClient {
    constructor(_config: unknown) {
      return mockClient as unknown as AzureClient;
    }
  }

  return {
    AzureClient,
    __mockClient: mockClient,
  };
});

import { AzureAdapter, lookupVMSize } from "../../src/providers/azure/adapter.js";

async function getMockClient() {
  const mod = await import("../../src/providers/azure/client.js");
  return (mod as unknown as { __mockClient: Record<string, ReturnType<typeof vi.fn>> }).__mockClient;
}

describe("lookupVMSize", () => {
  it("returns vCPU and memory for known sizes", () => {
    const b2s = lookupVMSize("Standard_B2s");
    expect(b2s).toEqual({ name: "Standard_B2s", vCPU: 2, memoryMiB: 4096 });

    const d4 = lookupVMSize("Standard_D4s_v5");
    expect(d4?.vCPU).toBe(4);
    expect(d4?.memoryMiB).toBe(16384);
  });

  it("returns null for unknown sizes", () => {
    expect(lookupVMSize("Standard_NobodyKnows")).toBeNull();
  });
});

describe("AzureAdapter", () => {
  let adapter: AzureAdapter;

  beforeEach(async () => {
    adapter = new AzureAdapter({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      subscriptionId: "sub",
      defaultLocation: "eastus",
    });

    const mockClient = await getMockClient();
    for (const fn of Object.values(mockClient)) {
      if (typeof fn === "function" && "mockClear" in fn) {
        (fn as ReturnType<typeof vi.fn>).mockClear();
      }
    }
  });

  describe("lifecycle", () => {
    it("has name 'azure'", () => {
      expect(adapter.name).toBe("azure");
    });

    it("connects and disconnects", async () => {
      expect(adapter.isConnected()).toBe(false);
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("getTools", () => {
    it("returns all Azure tool definitions", () => {
      const tools = adapter.getTools();
      expect(tools.length).toBe(16);
    });

    it("all tools declare adapter='azure'", () => {
      expect(adapter.getTools().every((t) => t.adapter === "azure")).toBe(true);
    });

    it("covers all tier levels", () => {
      const tiers = new Set(adapter.getTools().map((t) => t.tier));
      expect(tiers.has("read")).toBe(true);
      expect(tiers.has("safe_write")).toBe(true);
      expect(tiers.has("risky_write")).toBe(true);
      expect(tiers.has("destructive")).toBe(true);
    });

    it("tags lifecycle tools with the right tiers", () => {
      const byName = Object.fromEntries(adapter.getTools().map((t) => [t.name, t]));
      expect(byName["azure_list_vms"].tier).toBe("read");
      expect(byName["azure_start_vm"].tier).toBe("safe_write");
      expect(byName["azure_stop_vm"].tier).toBe("risky_write");
      expect(byName["azure_create_vm"].tier).toBe("risky_write");
      expect(byName["azure_delete_vm"].tier).toBe("destructive");
      expect(byName["azure_delete_image"].tier).toBe("destructive");
    });

    it("every parameter has name and description set", () => {
      for (const t of adapter.getTools()) {
        for (const p of t.params) {
          expect(p.name.length).toBeGreaterThan(0);
          expect(p.description.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("returns error for unknown tool", async () => {
      const result = await adapter.execute("azure_not_real", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });

    it("wraps client errors in success=false", async () => {
      const client = await getMockClient();
      client.listVMs.mockRejectedValueOnce(new Error("Unauthorized"));

      const result = await adapter.execute("azure_list_vms", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
    });

    it("strips internal params (prefixed with _) before dispatch", async () => {
      const client = await getMockClient();
      await adapter.execute("azure_list_vms", { _plan_id: "abc", resource_group: "rg-1" });
      expect(client.listVMs).toHaveBeenCalledWith("rg-1");
    });

    it("azure_create_vm maps params into client.createVM shape", async () => {
      const client = await getMockClient();
      await adapter.execute("azure_create_vm", {
        resource_group: "rg-1",
        name: "new-vm",
        vm_size: "Standard_B2s",
        image_publisher: "Canonical",
        image_offer: "UbuntuServer",
        image_sku: "22_04-lts",
        image_version: "latest",
        subnet_id: "/sub/id",
        admin_username: "azureuser",
        ssh_public_key: "ssh-rsa AAAA",
        location: "westus",
      });

      expect(client.createVM).toHaveBeenCalledWith({
        resourceGroup: "rg-1",
        name: "new-vm",
        vmSize: "Standard_B2s",
        imageReference: {
          publisher: "Canonical",
          offer: "UbuntuServer",
          sku: "22_04-lts",
          version: "latest",
        },
        adminUsername: "azureuser",
        adminPassword: undefined,
        sshPublicKey: "ssh-rsa AAAA",
        subnetId: "/sub/id",
        osType: undefined,
        location: "westus",
      });
    });

    it("azure_create_vm defaults image_version to 'latest'", async () => {
      const client = await getMockClient();
      await adapter.execute("azure_create_vm", {
        resource_group: "rg",
        name: "v",
        vm_size: "Standard_B2s",
        image_publisher: "p", image_offer: "o", image_sku: "s",
        subnet_id: "/sub/id",
        admin_username: "admin",
      });
      expect(client.createVM).toHaveBeenCalledWith(expect.objectContaining({
        imageReference: expect.objectContaining({ version: "latest" }),
      }));
    });

    it("dispatches all remaining tool branches to the correct client methods", async () => {
      const client = await getMockClient();

      const cases: Array<{
        tool: string;
        params: Record<string, unknown>;
        method: keyof typeof client;
        expected: unknown[];
      }> = [
        { tool: "azure_list_resource_groups", params: {}, method: "listResourceGroups", expected: [] },
        { tool: "azure_list_vms", params: {}, method: "listVMs", expected: [undefined] },
        { tool: "azure_list_vms", params: { resource_group: "rg-1" }, method: "listVMs", expected: ["rg-1"] },
        { tool: "azure_get_vm", params: { resource_group: "rg-1", vm_name: "vm" }, method: "getVM", expected: ["rg-1", "vm"] },
        { tool: "azure_list_disks", params: { resource_group: "rg-1" }, method: "listDisks", expected: ["rg-1"] },
        { tool: "azure_list_vnets", params: {}, method: "listVNets", expected: [undefined] },
        { tool: "azure_list_subnets", params: { resource_group: "rg-1", vnet_name: "vnet1" }, method: "listSubnets", expected: ["rg-1", "vnet1"] },
        { tool: "azure_list_nsgs", params: {}, method: "listNSGs", expected: [undefined] },
        { tool: "azure_list_images", params: { resource_group: "rg-1" }, method: "listImages", expected: ["rg-1"] },
        { tool: "azure_start_vm", params: { resource_group: "rg", vm_name: "v" }, method: "startVM", expected: ["rg", "v"] },
        {
          tool: "azure_create_snapshot",
          params: { resource_group: "rg", name: "snap", source_disk_id: "/d", location: "eastus" },
          method: "createSnapshot",
          expected: [{ resourceGroup: "rg", name: "snap", sourceDiskId: "/d", location: "eastus" }],
        },
        {
          tool: "azure_create_image",
          params: { resource_group: "rg", image_name: "img", vm_id: "/v" },
          method: "createImageFromVM",
          expected: [{ resourceGroup: "rg", imageName: "img", vmId: "/v", location: undefined }],
        },
        { tool: "azure_stop_vm", params: { resource_group: "rg", vm_name: "v" }, method: "deallocateVM", expected: ["rg", "v"] },
        { tool: "azure_restart_vm", params: { resource_group: "rg", vm_name: "v" }, method: "restartVM", expected: ["rg", "v"] },
        { tool: "azure_delete_vm", params: { resource_group: "rg", vm_name: "v" }, method: "deleteVM", expected: ["rg", "v"] },
        { tool: "azure_delete_image", params: { resource_group: "rg", image_name: "img" }, method: "deleteImage", expected: ["rg", "img"] },
      ];

      for (const c of cases) {
        const fn = client[c.method] as ReturnType<typeof vi.fn>;
        fn.mockClear();
        const result = await adapter.execute(c.tool, c.params);
        expect(result.success, `tool=${c.tool}`).toBe(true);
        expect(fn).toHaveBeenCalledWith(...c.expected);
      }
    });
  });

  describe("getClusterState", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("sets adapter='azure' and a valid timestamp", async () => {
      const state = await adapter.getClusterState();
      expect(state.adapter).toBe("azure");
      expect(new Date(state.timestamp).getTime()).not.toBeNaN();
    });

    it("maps VMs with cpu/ram from size catalog and status from power state", async () => {
      const state = await adapter.getClusterState();
      const byName = Object.fromEntries(state.vms.map((v) => [v.name, v]));

      expect(byName["web-1"].status).toBe("running");
      expect(byName["web-1"].cpu_cores).toBe(2);   // B2s
      expect(byName["web-1"].ram_mb).toBe(4096);
      expect(byName["web-1"].disk_gb).toBe(30);    // from attached disk

      expect(byName["db-1"].status).toBe("stopped"); // deallocated -> stopped
      expect(byName["db-1"].cpu_cores).toBe(4);      // D4s_v5
    });

    it("creates one region-node per distinct location", async () => {
      const state = await adapter.getClusterState();
      const regions = state.nodes.map((n) => n.id).sort();
      // eastus (web-1 + attached disk), westus (db-1), centralus (unattached disk)
      expect(regions).toEqual(["centralus", "eastus", "westus"]);
    });

    it("rolls up only running VMs into node cpu/ram totals", async () => {
      const state = await adapter.getClusterState();
      const east = state.nodes.find((n) => n.id === "eastus")!;
      const west = state.nodes.find((n) => n.id === "westus")!;

      expect(east.cpu_cores).toBe(2); // web-1 running
      expect(west.cpu_cores).toBe(0); // db-1 deallocated
    });

    it("credits unattached disks to their own region's node", async () => {
      const state = await adapter.getClusterState();
      const central = state.nodes.find((n) => n.id === "centralus")!;
      expect(central.disk_total_gb).toBe(500);
    });

    it("maps disks to storage entries with attached VM references", async () => {
      const state = await adapter.getClusterState();
      expect(state.storage).toHaveLength(2);
      const osDisk = state.storage.find((s) => s.id === "/disk/1")!;
      expect(osDisk.node).toBe("eastus");
      expect(osDisk.type).toBe("Premium_LRS");
      expect(osDisk.total_gb).toBe(30);
      expect(osDisk.content).toHaveLength(1);

      const dataDisk = state.storage.find((s) => s.id === "/disk/2")!;
      expect(dataDisk.content).toEqual([]);
    });

    it("returns empty containers array", async () => {
      const state = await adapter.getClusterState();
      expect(state.containers).toEqual([]);
    });

    it("all region nodes are online", async () => {
      const state = await adapter.getClusterState();
      expect(state.nodes.every((n) => n.status === "online")).toBe(true);
    });
  });
});
