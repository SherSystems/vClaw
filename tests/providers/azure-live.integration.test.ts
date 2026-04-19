import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AzureAdapter } from "../../src/providers/azure/adapter.js";

const RUN_LIVE = process.env.VCLAW_RUN_LIVE === "1";
const REQUIRED_ENV = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
] as const;

const hasRequiredCreds = REQUIRED_ENV.every((key) => Boolean(process.env[key]));
const describeLive = RUN_LIVE && hasRequiredCreds ? describe : describe.skip;
const CANARY_RESOURCE_GROUP = process.env.AZURE_TEST_RESOURCE_GROUP ?? "vclaw-qa";
const CANARY_VM_NAME = process.env.AZURE_TEST_VM_NAME ?? "Migration-TestVM";
const EMPTY_SUBSCRIPTION_MESSAGE = `Live Azure tests need at least one VM. Provision canary ${CANARY_VM_NAME} in ${CANARY_RESOURCE_GROUP} or set AZURE_TEST_RESOURCE_GROUP/AZURE_TEST_VM_NAME to an existing VM.`;

interface AzureVmSummary {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
}

describeLive("Azure live integration", () => {
  let adapter: AzureAdapter;

  beforeAll(async () => {
    adapter = new AzureAdapter({
      tenantId: process.env.AZURE_TENANT_ID!,
      clientId: process.env.AZURE_CLIENT_ID!,
      clientSecret: process.env.AZURE_CLIENT_SECRET!,
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
      defaultLocation: process.env.AZURE_DEFAULT_LOCATION ?? "eastus",
    });
    await adapter.connect();
  }, 120_000);

  afterAll(async () => {
    await adapter.disconnect();
  }, 30_000);

  it("reads VMs/disks from a real subscription and fetches VM detail", async () => {
    const listVmsResult = await adapter.execute("azure_list_vms", {});
    expect(listVmsResult.success).toBe(true);
    expect(Array.isArray(listVmsResult.data)).toBe(true);

    const vms = (listVmsResult.data ?? []) as AzureVmSummary[];
    if (vms.length === 0) {
      throw new Error(EMPTY_SUBSCRIPTION_MESSAGE);
    }

    const canaryVm = vms.find(
      (vm) => vm.name === CANARY_VM_NAME && vm.resourceGroup.toLowerCase() === CANARY_RESOURCE_GROUP.toLowerCase(),
    );
    const vmUnderTest = canaryVm ?? vms[0];

    expect(vmUnderTest.name.length).toBeGreaterThan(0);
    expect(vmUnderTest.resourceGroup.length).toBeGreaterThan(0);
    expect(vmUnderTest.location.length).toBeGreaterThan(0);

    const getVmResult = await adapter.execute("azure_get_vm", {
      resource_group: vmUnderTest.resourceGroup,
      vm_name: vmUnderTest.name,
    });

    expect(getVmResult.success).toBe(true);
    expect(getVmResult.data).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: vmUnderTest.name,
        resourceGroup: vmUnderTest.resourceGroup,
      }),
    );

    const listDisksResult = await adapter.execute("azure_list_disks", {});
    expect(listDisksResult.success).toBe(true);
    expect(Array.isArray(listDisksResult.data)).toBe(true);
  }, 180_000);

  it("reflects live Azure VM and disk data in getClusterState()", async () => {
    const state = await adapter.getClusterState();
    expect(state.adapter).toBe("azure");
    expect(new Date(state.timestamp).toString()).not.toBe("Invalid Date");
    if (state.vms.length === 0) {
      throw new Error(EMPTY_SUBSCRIPTION_MESSAGE);
    }

    const vm = state.vms.find((candidate) => candidate.name === CANARY_VM_NAME) ?? state.vms[0];

    expect(vm.node.length).toBeGreaterThan(0);

    const node = state.nodes.find((candidate) => candidate.id === vm.node);
    expect(node).toBeDefined();

    // Proves storage rollup consistency for a real VM using attached managed disks.
    const attachedDiskTotal = state.storage
      .filter((disk) => disk.content.includes(String(vm.id)))
      .reduce((sum, disk) => sum + disk.total_gb, 0);
    expect(vm.disk_gb).toBe(attachedDiskTotal);
  }, 180_000);
});
