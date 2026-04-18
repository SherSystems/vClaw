# VMware Provider Guide

This guide documents the VMware adapter exactly as implemented in:

- `src/providers/vmware/adapter.ts`
- `src/providers/vmware/client.ts`
- `tests/providers/vmware-adapter.test.ts`

## 1. Authentication and registration

vClaw auto-registers the VMware adapter in `src/index.ts` when this value is present:

- `VMWARE_HOST`

Recommended full configuration:

```env
VMWARE_HOST=vcenter.lab.local
VMWARE_USER=administrator@vsphere.local
VMWARE_PASSWORD=your-password
VMWARE_INSECURE=true
```

Defaults from `src/config.ts`:

- `VMWARE_INSECURE=true`

## 2. Tool invocation and errors

Tools are executed through the adapter contract:

```ts
const result = await adapter.execute("vmware_list_vms", {});
```

Execution behavior from `execute()` in `src/providers/vmware/adapter.ts`:

- Internal planner keys prefixed with `_` are stripped.
- Unknown tool names return `success: false` with `Unknown tool: <name>`.
- Client/runtime errors are caught and returned as `success: false` with `error`.

Snapshot caveat (current release):

- Snapshot APIs in this adapter are discoverable, but current client behavior returns errors because snapshots require SOAP APIs not implemented yet.
- Affected tools: `vmware_list_snapshots`, `vmware_create_snapshot`, `vmware_delete_snapshot`, `vmware_revert_snapshot`.

## 3. Tier examples

### `read`

```ts
await adapter.execute("vmware_get_vm", { vm_id: "vm-42" });
```

### `safe_write`

```ts
await adapter.execute("vmware_vm_power_on", { vm_id: "vm-42" });
```

### `risky_write`

```ts
await adapter.execute("vmware_create_vm", {
  name: "web-02",
  guest_OS: "OTHER_LINUX_64",
  cpu_count: 2,
  memory_MiB: 4096,
  datastore: "datastore-15",
  resource_pool: "resgroup-10",
});
```

### `destructive`

```ts
await adapter.execute("vmware_delete_vm", { vm_id: "vm-42" });
```

## 4. VMware tool reference (all 26 tools)

## Read

### `vmware_list_vms`

- Tier: `read`
- Params:
  - `filter_names` (string, optional)
  - `filter_power_states` (string, optional)
- Returns: `VmSummary[]`

```ts
await adapter.execute("vmware_list_vms", {
  filter_names: "web-01,db-01",
  filter_power_states: "POWERED_ON",
});
```

### `vmware_get_vm`

- Tier: `read`
- Params:
  - `vm_id` (string, required)
- Returns: `VmInfo`

```ts
await adapter.execute("vmware_get_vm", { vm_id: "vm-42" });
```

### `vmware_list_hosts`

- Tier: `read`
- Params: none
- Returns: `HostSummary[]`

```ts
await adapter.execute("vmware_list_hosts", {});
```

### `vmware_get_host`

- Tier: `read`
- Params:
  - `host_id` (string, required)
- Returns: `HostInfo`

```ts
await adapter.execute("vmware_get_host", { host_id: "host-10" });
```

### `vmware_list_datastores`

- Tier: `read`
- Params: none
- Returns: `DatastoreSummary[]`

```ts
await adapter.execute("vmware_list_datastores", {});
```

### `vmware_get_datastore`

- Tier: `read`
- Params:
  - `datastore_id` (string, required)
- Returns: `DatastoreInfo`

```ts
await adapter.execute("vmware_get_datastore", {
  datastore_id: "datastore-15",
});
```

### `vmware_list_networks`

- Tier: `read`
- Params: none
- Returns: `NetworkSummary[]`

```ts
await adapter.execute("vmware_list_networks", {});
```

### `vmware_list_clusters`

- Tier: `read`
- Params: none
- Returns: `ClusterSummary[]`

```ts
await adapter.execute("vmware_list_clusters", {});
```

### `vmware_list_resource_pools`

- Tier: `read`
- Params: none
- Returns: `ResourcePoolSummary[]`

```ts
await adapter.execute("vmware_list_resource_pools", {});
```

### `vmware_get_vm_guest`

- Tier: `read`
- Params:
  - `vm_id` (string, required)
- Returns: `GuestInfo`

```ts
await adapter.execute("vmware_get_vm_guest", { vm_id: "vm-42" });
```

### `vmware_list_folders`

- Tier: `read`
- Params:
  - `type` (string, optional, default `VIRTUAL_MACHINE`)
- Returns: `FolderSummary[]`

```ts
await adapter.execute("vmware_list_folders", { type: "VIRTUAL_MACHINE" });
```

### `vmware_list_snapshots`

- Tier: `read`
- Params:
  - `vm_id` (string, required)
- Returns: `SnapshotSummary[]`
- Notes: currently returns SOAP-not-implemented error.

```ts
await adapter.execute("vmware_list_snapshots", { vm_id: "vm-42" });
```

## Safe write

### `vmware_vm_power_on`

- Tier: `safe_write`
- Params:
  - `vm_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("vmware_vm_power_on", { vm_id: "vm-42" });
```

### `vmware_create_snapshot`

- Tier: `safe_write`
- Params:
  - `vm_id` (string, required)
  - `name` (string, required)
  - `description` (string, optional)
  - `memory` (boolean, optional, default `false`)
- Returns: `string`
- Notes: currently returns SOAP-not-implemented error.

```ts
await adapter.execute("vmware_create_snapshot", {
  vm_id: "vm-42",
  name: "before-update",
  description: "Pre-maintenance snapshot",
  memory: false,
});
```

### `vmware_vm_guest_shutdown`

- Tier: `safe_write`
- Params:
  - `vm_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("vmware_vm_guest_shutdown", { vm_id: "vm-42" });
```

### `vmware_vm_guest_reboot`

- Tier: `safe_write`
- Params:
  - `vm_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("vmware_vm_guest_reboot", { vm_id: "vm-42" });
```

## Risky write

### `vmware_vm_power_off`

- Tier: `risky_write`
- Params:
  - `vm_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("vmware_vm_power_off", { vm_id: "vm-42" });
```

### `vmware_vm_reset`

- Tier: `risky_write`
- Params:
  - `vm_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("vmware_vm_reset", { vm_id: "vm-42" });
```

### `vmware_vm_suspend`

- Tier: `risky_write`
- Params:
  - `vm_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("vmware_vm_suspend", { vm_id: "vm-42" });
```

### `vmware_create_vm`

- Tier: `risky_write`
- Params:
  - `name` (string, required)
  - `guest_OS` (string, required)
  - `datastore` (string, optional)
  - `resource_pool` (string, optional)
  - `folder` (string, optional)
  - `host` (string, optional)
  - `cluster` (string, optional)
  - `cpu_count` (number, optional, default `2`)
  - `memory_MiB` (number, optional, default `2048`)
  - `disk_capacity_bytes` (number, optional)
- Returns: `string` (new VM id)
- Notes: if `folder` is omitted, adapter auto-resolves the first `VIRTUAL_MACHINE` folder.

```ts
await adapter.execute("vmware_create_vm", {
  name: "web-02",
  guest_OS: "OTHER_LINUX_64",
  datastore: "datastore-15",
  resource_pool: "resgroup-10",
  cpu_count: 2,
  memory_MiB: 4096,
  disk_capacity_bytes: 42949672960,
});
```

### `vmware_delete_snapshot`

- Tier: `risky_write`
- Params:
  - `vm_id` (string, required)
  - `snapshot_id` (string, required)
- Returns: `void`
- Notes: currently returns SOAP-not-implemented error.

```ts
await adapter.execute("vmware_delete_snapshot", {
  vm_id: "vm-42",
  snapshot_id: "snapshot-1",
});
```

### `vmware_revert_snapshot`

- Tier: `risky_write`
- Params:
  - `vm_id` (string, required)
  - `snapshot_id` (string, required)
- Returns: `void`
- Notes: currently returns SOAP-not-implemented error.

```ts
await adapter.execute("vmware_revert_snapshot", {
  vm_id: "vm-42",
  snapshot_id: "snapshot-1",
});
```

### `vmware_vm_update_cpu`

- Tier: `risky_write`
- Params:
  - `vm_id` (string, required)
  - `count` (number, required)
  - `cores_per_socket` (number, optional)
- Returns: `void`

```ts
await adapter.execute("vmware_vm_update_cpu", {
  vm_id: "vm-42",
  count: 8,
  cores_per_socket: 2,
});
```

### `vmware_vm_update_memory`

- Tier: `risky_write`
- Params:
  - `vm_id` (string, required)
  - `size_MiB` (number, required)
- Returns: `void`

```ts
await adapter.execute("vmware_vm_update_memory", {
  vm_id: "vm-42",
  size_MiB: 16384,
});
```

### `vmware_vm_relocate`

- Tier: `risky_write`
- Params:
  - `vm_id` (string, required)
  - `host_id` (string, required)
  - `datastore_id` (string, optional)
- Returns: `string` (task id)

```ts
await adapter.execute("vmware_vm_relocate", {
  vm_id: "vm-42",
  host_id: "host-11",
  datastore_id: "datastore-20",
});
```

## Destructive

### `vmware_delete_vm`

- Tier: `destructive`
- Params:
  - `vm_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("vmware_delete_vm", { vm_id: "vm-42" });
```

## 5. Cluster state mapping

`getClusterState()` in `src/providers/vmware/adapter.ts` maps vCenter inventory into vClaw state:

1. Reads hosts, VMs, and datastores.
2. Maps hosts to `NodeInfo` with two paths:
   - preferred: `getHost()` metrics
   - fallback: aggregate host-level estimates from VM summary data
3. Maps VMs to `vms[]` and power states:
   - `POWERED_ON` -> `running`
   - `POWERED_OFF` -> `stopped`
   - `SUSPENDED` -> `paused`
4. Maps datastores to `storage[]`.

## 6. Source-of-truth checks before doc updates

When this adapter changes, re-check these files in the same PR:

- `src/providers/vmware/adapter.ts` (tool names, params, tiers, returns)
- `src/providers/vmware/client.ts` (REST vs SOAP behavior and side effects)
- `tests/providers/vmware-adapter.test.ts` (validated payload shapes and unsupported snapshot assertions)
