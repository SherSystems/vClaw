# Proxmox Provider Guide

This guide documents the Proxmox adapter exactly as implemented in:

- `src/providers/proxmox/adapter.ts`
- `src/providers/proxmox/client.ts`
- `tests/providers/proxmox-adapter.test.ts`

## 1. Authentication and registration

vClaw auto-registers the Proxmox adapter in `src/index.ts` only when both values are present:

- `PROXMOX_TOKEN_ID`
- `PROXMOX_TOKEN_SECRET`

Required connection variables:

```env
PROXMOX_HOST=192.168.1.100
PROXMOX_PORT=8006
PROXMOX_TOKEN_ID=root@pam!vclaw
PROXMOX_TOKEN_SECRET=your-token-secret
PROXMOX_ALLOW_SELF_SIGNED=true
```

Defaults from `src/config.ts`:

- `PROXMOX_HOST=localhost`
- `PROXMOX_PORT=8006`
- `PROXMOX_ALLOW_SELF_SIGNED=true`

## 2. Tool invocation and errors

Tools are executed through the adapter contract:

```ts
const result = await adapter.execute("list_vms", { node: "pve1" });
```

Execution behavior from `execute()` in `src/providers/proxmox/adapter.ts`:

- Internal planner keys prefixed with `_` are stripped.
- Unknown tool names return `success: false` with `Unknown tool: <name>`.
- Client/runtime errors are caught and returned as `success: false` with `error`.

## 3. Tier examples

### `read`

```ts
await adapter.execute("list_vms", { node: "pve1" });
```

### `safe_write`

```ts
await adapter.execute("create_snapshot", {
  node: "pve1",
  vmid: 100,
  snapname: "before-update",
  description: "Pre-update snapshot",
});
```

### `risky_write`

```ts
await adapter.execute("create_vm", {
  node: "pve1",
  vmid: 200,
  name: "web-02",
  memory: 4096,
  cores: 2,
});
```

### `destructive`

```ts
await adapter.execute("delete_vm", {
  node: "pve1",
  vmid: 200,
  purge: true,
});
```

## 4. Proxmox tool reference (all 31 tools)

## Read

### `list_vms`

- Tier: `read`
- Params:
  - `node` (string, optional)
- Returns: `VMInfo[]`

```ts
await adapter.execute("list_vms", { node: "pve1" });
```

### `get_vm_status`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
- Returns: `VMStatus`

```ts
await adapter.execute("get_vm_status", { node: "pve1", vmid: 100 });
```

### `list_nodes`

- Tier: `read`
- Params: none
- Returns: `NodeInfo[]`

```ts
await adapter.execute("list_nodes", {});
```

### `get_node_stats`

- Tier: `read`
- Params:
  - `node` (string, required)
- Returns: `NodeStats`

```ts
await adapter.execute("get_node_stats", { node: "pve1" });
```

### `list_snapshots`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
- Returns: `Snapshot[]`

```ts
await adapter.execute("list_snapshots", { node: "pve1", vmid: 100 });
```

### `get_vm_config`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
- Returns: `VMConfig`

```ts
await adapter.execute("get_vm_config", { node: "pve1", vmid: 100 });
```

### `list_storage`

- Tier: `read`
- Params:
  - `node` (string, optional)
- Returns: `StorageInfo[]`

```ts
await adapter.execute("list_storage", { node: "pve1" });
```

### `list_isos`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `storage` (string, required)
- Returns: `ISO[]`

```ts
await adapter.execute("list_isos", {
  node: "pve1",
  storage: "local",
});
```

### `list_templates`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `storage` (string, required)
- Returns: `Template[]`

```ts
await adapter.execute("list_templates", {
  node: "pve1",
  storage: "local",
});
```

### `get_task_status`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `upid` (string, required)
- Returns: `TaskStatus`

```ts
await adapter.execute("get_task_status", {
  node: "pve1",
  upid: "UPID:pve1:000ABC:123:start",
});
```

### `list_tasks`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `limit` (number, optional, default `50`)
- Returns: `Task[]`

```ts
await adapter.execute("list_tasks", {
  node: "pve1",
  limit: 25,
});
```

### `search_logs`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `start` (number, optional)
  - `limit` (number, optional, default `500`)
  - `since` (string, optional)
  - `until` (string, optional)
  - `service` (string, optional)
- Returns: `SyslogEntry[]`

```ts
await adapter.execute("search_logs", {
  node: "pve1",
  service: "pvedaemon",
  limit: 100,
});
```

### `list_network_interfaces`

- Tier: `read`
- Params:
  - `node` (string, required)
- Returns: `NetworkInterface[]`

```ts
await adapter.execute("list_network_interfaces", { node: "pve1" });
```

### `get_vm_firewall_rules`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
- Returns: `FirewallRule[]`

```ts
await adapter.execute("get_vm_firewall_rules", {
  node: "pve1",
  vmid: 100,
});
```

### `wait_for_task`

- Tier: `read`
- Params:
  - `node` (string, required)
  - `upid` (string, required)
  - `timeout_ms` (number, optional, default `120000`)
  - `poll_interval_ms` (number, optional, default `2000`)
- Returns: `TaskStatus`

```ts
await adapter.execute("wait_for_task", {
  node: "pve1",
  upid: "UPID:pve1:000ABC:123:start",
  timeout_ms: 60000,
  poll_interval_ms: 1000,
});
```

## Safe write

### `start_vm`

- Tier: `safe_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
- Returns: `string` (task UPID)

```ts
await adapter.execute("start_vm", { node: "pve1", vmid: 100 });
```

### `create_snapshot`

- Tier: `safe_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `snapname` (string, required)
  - `description` (string, optional)
  - `vmstate` (boolean, optional, default `false`)
- Returns: `string` (task UPID)

```ts
await adapter.execute("create_snapshot", {
  node: "pve1",
  vmid: 100,
  snapname: "pre-maintenance",
  description: "Snapshot before patching",
  vmstate: false,
});
```

### `resume_vm`

- Tier: `safe_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
- Returns: `string` (task UPID)

```ts
await adapter.execute("resume_vm", { node: "pve1", vmid: 100 });
```

## Risky write

### `create_vm`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `name` (string, optional)
  - `memory` (number, optional, default `2048`)
  - `cores` (number, optional, default `2`)
  - `sockets` (number, optional, default `1`)
  - `cpu` (string, optional, default `host`)
  - `ostype` (string, optional)
  - `iso` (string, optional)
  - `scsihw` (string, optional, default `virtio-scsi-single`)
  - `scsi0` (string, optional)
  - `net0` (string, optional)
  - `boot` (string, optional)
  - `agent` (string, optional)
  - `bios` (string, optional)
  - `machine` (string, optional)
  - `numa` (number, optional)
  - `onboot` (number, optional)
  - `start` (boolean, optional, default `false`)
  - `tags` (string, optional)
- Returns: `string` (task UPID)

```ts
await adapter.execute("create_vm", {
  node: "pve1",
  vmid: 300,
  name: "web-03",
  memory: 4096,
  cores: 2,
  scsi0: "local-lvm:32",
  net0: "virtio,bridge=vmbr0",
  start: true,
});
```

### `create_ct`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `hostname` (string, optional)
  - `ostemplate` (string, required)
  - `memory` (number, optional, default `512`)
  - `cores` (number, optional, default `1`)
  - `swap` (number, optional, default `512`)
  - `rootfs` (string, optional)
  - `net0` (string, optional)
  - `password` (string, optional)
  - `ssh_public_keys` (string, optional)
  - `start` (boolean, optional, default `false`)
  - `onboot` (number, optional)
  - `unprivileged` (boolean, optional, default `true`)
- Returns: `string` (task UPID)

```ts
await adapter.execute("create_ct", {
  node: "pve1",
  vmid: 401,
  hostname: "api-ct-1",
  ostemplate: "local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst",
  memory: 1024,
  cores: 2,
  start: true,
});
```

### `clone_vm`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `newid` (number, required)
  - `name` (string, optional)
  - `target` (string, optional)
  - `full` (boolean, optional, default `true`)
  - `storage` (string, optional)
  - `description` (string, optional)
- Returns: `string` (task UPID)

```ts
await adapter.execute("clone_vm", {
  node: "pve1",
  vmid: 9000,
  newid: 9100,
  name: "web-clone-1",
  full: true,
  storage: "local-lvm",
});
```

### `stop_vm`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
- Returns: `string` (task UPID)

```ts
await adapter.execute("stop_vm", { node: "pve1", vmid: 100 });
```

### `shutdown_vm`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `timeout` (number, optional)
- Returns: `string` (task UPID)

```ts
await adapter.execute("shutdown_vm", {
  node: "pve1",
  vmid: 100,
  timeout: 90,
});
```

### `reboot_vm`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
- Returns: `string` (task UPID)

```ts
await adapter.execute("reboot_vm", { node: "pve1", vmid: 100 });
```

### `update_vm_config`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `config` (object, required)
- Returns: `void`

```ts
await adapter.execute("update_vm_config", {
  node: "pve1",
  vmid: 100,
  config: {
    memory: 8192,
    cores: 4,
  },
});
```

### `resize_disk`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `disk` (string, required)
  - `size` (string, required)
- Returns: `void`

```ts
await adapter.execute("resize_disk", {
  node: "pve1",
  vmid: 100,
  disk: "scsi0",
  size: "+20G",
});
```

### `migrate_vm`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `target` (string, required)
  - `online` (boolean, optional, default `true`)
  - `force` (boolean, optional, default `false`)
  - `with_local_disks` (boolean, optional, default `false`)
  - `targetstorage` (string, optional)
- Returns: `string` (task UPID)

```ts
await adapter.execute("migrate_vm", {
  node: "pve1",
  vmid: 100,
  target: "pve2",
  online: true,
});
```

### `add_firewall_rule`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `type` (string, required)
  - `action` (string, required)
  - `enable` (boolean, optional, default `true`)
  - `comment` (string, optional)
  - `source` (string, optional)
  - `dest` (string, optional)
  - `sport` (string, optional)
  - `dport` (string, optional)
  - `proto` (string, optional)
  - `macro` (string, optional)
  - `iface` (string, optional)
  - `log` (string, optional)
- Returns: `void`

```ts
await adapter.execute("add_firewall_rule", {
  node: "pve1",
  vmid: 100,
  type: "in",
  action: "ACCEPT",
  proto: "tcp",
  dport: "22",
  source: "10.0.0.0/24",
  comment: "Allow SSH from management subnet",
});
```

### `rollback_snapshot`

- Tier: `risky_write`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `snapname` (string, required)
- Returns: `string` (task UPID)

```ts
await adapter.execute("rollback_snapshot", {
  node: "pve1",
  vmid: 100,
  snapname: "pre-maintenance",
});
```

## Destructive

### `delete_vm`

- Tier: `destructive`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `purge` (boolean, optional, default `false`)
- Returns: `string` (task UPID)

```ts
await adapter.execute("delete_vm", {
  node: "pve1",
  vmid: 300,
  purge: true,
});
```

### `delete_snapshot`

- Tier: `destructive`
- Params:
  - `node` (string, required)
  - `vmid` (number, required)
  - `snapname` (string, required)
- Returns: `string` (task UPID)

```ts
await adapter.execute("delete_snapshot", {
  node: "pve1",
  vmid: 100,
  snapname: "pre-maintenance",
});
```

## 5. Cluster state mapping

`getClusterState()` in `src/providers/proxmox/adapter.ts` maps Proxmox data into vClaw state:

1. Reads nodes from `/nodes` and maps CPU/RAM/disk metrics into `NodeInfo`.
2. For each online node, fetches VM inventory and maps:
   - `qemu` entries -> `vms[]`
   - `lxc` entries -> `containers[]`
3. Fetches per-node storage pools and maps them into `storage[]`.
4. Maps VM status:
   - `running` -> `running`
   - `stopped` -> `stopped`
   - `paused` -> `paused`

## 6. Source-of-truth checks before doc updates

When this adapter changes, re-check these files in the same PR:

- `src/providers/proxmox/adapter.ts` (tool names, params, tiers, returns)
- `src/providers/proxmox/client.ts` (API behavior and task semantics)
- `tests/providers/proxmox-adapter.test.ts` (validated payload shapes and tier assertions)
