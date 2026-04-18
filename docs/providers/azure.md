# Azure Provider Guide

This guide documents the Azure adapter exactly as implemented in:

- `src/providers/azure/adapter.ts`
- `src/providers/azure/client.ts`
- `tests/providers/azure-adapter.test.ts`

## 1. Authentication and registration

vClaw auto-registers the Azure adapter only when all four required credentials are present in `src/index.ts`:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_SUBSCRIPTION_ID`

Optional but recommended:

- `AZURE_DEFAULT_LOCATION` (defaults to `eastus` in `src/config.ts` and `src/providers/azure/client.ts`)

### Environment variables

```env
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<app-id>
AZURE_CLIENT_SECRET=<client-secret>
AZURE_SUBSCRIPTION_ID=<subscription-id>
AZURE_DEFAULT_LOCATION=eastus
```

## 2. Create a service principal

### Option A: Azure CLI

```bash
az login
az account set --subscription "<subscription-id>"

az ad sp create-for-rbac \
  --name vclaw-sp \
  --role Contributor \
  --scopes /subscriptions/<subscription-id>
```

The command returns JSON containing:

- `appId` -> `AZURE_CLIENT_ID`
- `password` -> `AZURE_CLIENT_SECRET`
- `tenant` -> `AZURE_TENANT_ID`

Use your subscription id for `AZURE_SUBSCRIPTION_ID`.

### Option B: Azure Portal (Microsoft Entra)

1. Go to `Microsoft Entra ID -> App registrations -> New registration`.
2. Create an app registration for vClaw.
3. Go to `Certificates & secrets` and create a client secret.
4. Go to `Subscriptions -> <your-subscription> -> Access control (IAM)`.
5. Add role assignment (`Contributor`) for the app registration.
6. Copy these values:
   - Tenant ID (Entra tenant)
   - Client ID (app registration application ID)
   - Client secret value
   - Subscription ID

## 3. Tool invocation format

Azure tools are executed through the adapter contract:

```ts
const result = await adapter.execute("azure_list_vms", { resource_group: "rg-1" });
```

- Internal planner metadata keys prefixed with `_` are stripped before dispatch.
- Unknown tool names return `success: false` with an `Unknown tool` error.

## 4. Tier examples (one per tier)

These are valid payload shapes from `tests/providers/azure-adapter.test.ts`.

### `read`

```ts
await adapter.execute("azure_list_vms", { resource_group: "rg-1" });
```

### `safe_write`

```ts
await adapter.execute("azure_create_snapshot", {
  resource_group: "rg-1",
  name: "pre-patch-snap",
  source_disk_id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/disks/osdisk-1",
  location: "eastus",
});
```

### `risky_write`

```ts
await adapter.execute("azure_create_vm", {
  resource_group: "rg-1",
  name: "web-02",
  vm_size: "Standard_B2s",
  image_publisher: "Canonical",
  image_offer: "UbuntuServer",
  image_sku: "22_04-lts",
  subnet_id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Network/virtualNetworks/vnet1/subnets/default",
  admin_username: "azureuser",
  ssh_public_key: "ssh-rsa AAAA...",
});
```

### `destructive`

```ts
await adapter.execute("azure_delete_image", {
  resource_group: "rg-1",
  image_name: "golden-ubuntu-2026-04",
});
```

## 5. Azure tool reference (all 16 tools)

## Read

### `azure_list_resource_groups`

- Tier: `read`
- Params: none
- Returns: `AzureResourceGroupInfo[]`

```ts
await adapter.execute("azure_list_resource_groups", {});
```

### `azure_list_vms`

- Tier: `read`
- Params:
  - `resource_group` (string, optional)
- Returns: `AzureVMSummary[]`

```ts
await adapter.execute("azure_list_vms", { resource_group: "rg-1" });
```

### `azure_get_vm`

- Tier: `read`
- Params:
  - `resource_group` (string, required)
  - `vm_name` (string, required)
- Returns: `AzureVMDetail`

```ts
await adapter.execute("azure_get_vm", {
  resource_group: "rg-1",
  vm_name: "web-1",
});
```

### `azure_list_disks`

- Tier: `read`
- Params:
  - `resource_group` (string, optional)
- Returns: `AzureDiskInfo[]`

```ts
await adapter.execute("azure_list_disks", { resource_group: "rg-1" });
```

### `azure_list_vnets`

- Tier: `read`
- Params:
  - `resource_group` (string, optional)
- Returns: `AzureVNetInfo[]`

```ts
await adapter.execute("azure_list_vnets", {});
```

### `azure_list_subnets`

- Tier: `read`
- Params:
  - `resource_group` (string, required)
  - `vnet_name` (string, required)
- Returns: `AzureSubnetInfo[]`

```ts
await adapter.execute("azure_list_subnets", {
  resource_group: "rg-1",
  vnet_name: "vnet1",
});
```

### `azure_list_nsgs`

- Tier: `read`
- Params:
  - `resource_group` (string, optional)
- Returns: `AzureNSGInfo[]`

```ts
await adapter.execute("azure_list_nsgs", {});
```

### `azure_list_images`

- Tier: `read`
- Params:
  - `resource_group` (string, optional)
- Returns: `AzureImageInfo[]`

```ts
await adapter.execute("azure_list_images", { resource_group: "rg-1" });
```

## Safe write

### `azure_start_vm`

- Tier: `safe_write`
- Params:
  - `resource_group` (string, required)
  - `vm_name` (string, required)
- Returns: `void`

```ts
await adapter.execute("azure_start_vm", {
  resource_group: "rg-1",
  vm_name: "web-1",
});
```

### `azure_create_snapshot`

- Tier: `safe_write`
- Params:
  - `resource_group` (string, required)
  - `name` (string, required)
  - `source_disk_id` (string, required)
  - `location` (string, optional, defaults to `AZURE_DEFAULT_LOCATION`)
- Returns: `AzureSnapshotInfo`

```ts
await adapter.execute("azure_create_snapshot", {
  resource_group: "rg-1",
  name: "snap-1",
  source_disk_id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/disks/os-disk-1",
  location: "eastus",
});
```

### `azure_create_image`

- Tier: `safe_write`
- Params:
  - `resource_group` (string, required)
  - `image_name` (string, required)
  - `vm_id` (string, required)
  - `location` (string, optional, defaults to `AZURE_DEFAULT_LOCATION`)
- Returns: `string` (new image ARM id)

```ts
await adapter.execute("azure_create_image", {
  resource_group: "rg-1",
  image_name: "web-golden-1",
  vm_id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/web-1",
});
```

## Risky write

### `azure_stop_vm`

- Tier: `risky_write`
- Params:
  - `resource_group` (string, required)
  - `vm_name` (string, required)
- Returns: `void`

```ts
await adapter.execute("azure_stop_vm", {
  resource_group: "rg-1",
  vm_name: "web-1",
});
```

### `azure_restart_vm`

- Tier: `risky_write`
- Params:
  - `resource_group` (string, required)
  - `vm_name` (string, required)
- Returns: `void`

```ts
await adapter.execute("azure_restart_vm", {
  resource_group: "rg-1",
  vm_name: "web-1",
});
```

### `azure_create_vm`

- Tier: `risky_write`
- Params:
  - `resource_group` (string, required)
  - `name` (string, required)
  - `vm_size` (string, required)
  - `image_publisher` (string, required)
  - `image_offer` (string, required)
  - `image_sku` (string, required)
  - `image_version` (string, optional, defaults to `latest`)
  - `subnet_id` (string, required)
  - `admin_username` (string, required)
  - `admin_password` (string, optional)
  - `ssh_public_key` (string, optional)
  - `os_type` (`Linux` or `Windows`, optional)
  - `location` (string, optional, defaults to `AZURE_DEFAULT_LOCATION`)
- Returns: `AzureVMSummary`

```ts
await adapter.execute("azure_create_vm", {
  resource_group: "rg-1",
  name: "new-vm",
  vm_size: "Standard_B2s",
  image_publisher: "Canonical",
  image_offer: "UbuntuServer",
  image_sku: "22_04-lts",
  image_version: "latest",
  subnet_id: "/subscriptions/s/resourceGroups/rg-1/providers/Microsoft.Network/virtualNetworks/vnet1/subnets/default",
  admin_username: "azureuser",
  ssh_public_key: "ssh-rsa AAAA...",
  location: "westus",
});
```

## Destructive

### `azure_delete_vm`

- Tier: `destructive`
- Params:
  - `resource_group` (string, required)
  - `vm_name` (string, required)
- Returns: `void`
- Notes: deletes VM compute object only; attached disks are not deleted.

```ts
await adapter.execute("azure_delete_vm", {
  resource_group: "rg-1",
  vm_name: "old-web-1",
});
```

### `azure_delete_image`

- Tier: `destructive`
- Params:
  - `resource_group` (string, required)
  - `image_name` (string, required)
- Returns: `void`

```ts
await adapter.execute("azure_delete_image", {
  resource_group: "rg-1",
  image_name: "web-golden-1",
});
```

## 6. Cluster state mapping (Azure regions -> vClaw nodes)

`getClusterState()` in `src/providers/azure/adapter.ts` maps Azure inventory into vClaw state like this:

1. Fetches all VMs (`listVMs`) and disks (`listDisks`).
2. Builds `vms[]`:
   - `node` = VM `location` (Azure region)
   - `status` mapping:
     - `running` -> `running`
     - `stopped` or `deallocated` -> `stopped`
     - `starting`, `stopping`, `deallocating` -> `unknown`
   - `cpu_cores` and `ram_mb` from `lookupVMSize(vm.vmSize)` catalog (unknown sizes map to `0`)
   - `disk_gb` from attached disk totals keyed by VM id
3. Builds `nodes[]` (one per region):
   - includes every region seen in VM locations
   - also includes regions that only contain unattached disks
   - CPU/RAM totals include only VMs in `running` state
   - disk totals include both attached and unattached disks
4. Builds `storage[]` from Azure disks:
   - `node` = disk region
   - `type` = `skuName` or `managed-disk`
   - `content` = `[attachedVmId]` when attached, else `[]`

From tests, if VMs are in `eastus` and `westus`, and an unattached disk is in `centralus`, vClaw creates three nodes: `eastus`, `westus`, `centralus`.

## 7. Source-of-truth checks before doc updates

When the adapter changes, re-check these files in the same PR:

- `src/providers/azure/adapter.ts` (tool names, params, tiers, returns)
- `src/providers/azure/client.ts` (SDK behavior, defaults, side effects)
- `tests/providers/azure-adapter.test.ts` (validated payload shapes and tier assertions)

If any tool signature changes, update this document immediately.
