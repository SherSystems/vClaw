# AWS Provider Guide

This guide documents the AWS adapter exactly as implemented in:

- `src/providers/aws/adapter.ts`
- `src/providers/aws/client.ts`
- `tests/providers/aws-adapter.test.ts`

## 1. Authentication and registration

vClaw auto-registers the AWS adapter in `src/index.ts` only when both values are present:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

Recommended configuration:

```env
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_SESSION_TOKEN=
```

Defaults from `src/config.ts`:

- `AWS_REGION=us-east-1`
- `AWS_SESSION_TOKEN` is optional

## 2. Tool invocation and errors

Tools are executed through the adapter contract:

```ts
const result = await adapter.execute("aws_list_instances", {
  state: "running",
});
```

Execution behavior from `execute()` in `src/providers/aws/adapter.ts`:

- Internal planner keys prefixed with `_` are stripped.
- Unknown tool names return `success: false` with `Unknown tool: <name>`.
- Client/runtime errors are caught and returned as `success: false` with `error`.
- `aws_launch_instance` splits `security_group_ids` comma-separated strings into an array.

## 3. Tier examples

### `read`

```ts
await adapter.execute("aws_list_instances", {
  name: "web-1",
  state: "running",
});
```

### `safe_write`

```ts
await adapter.execute("aws_create_ami", {
  instance_id: "i-0abcdef1234567890",
  name: "web-1-golden-2026-04",
  description: "Golden AMI before April patch cycle",
});
```

### `risky_write`

```ts
await adapter.execute("aws_launch_instance", {
  ami_id: "ami-0abcde1234567890f",
  instance_type: "t3.micro",
  subnet_id: "subnet-0abc1234",
  security_group_ids: "sg-0123abcd,sg-0456efgh",
  key_name: "ops-key",
  name: "web-2",
});
```

### `destructive`

```ts
await adapter.execute("aws_terminate_instance", {
  instance_id: "i-0abcdef1234567890",
});
```

## 4. AWS tool reference (all 16 tools)

## Read

### `aws_list_instances`

- Tier: `read`
- Params:
  - `name` (string, optional)
  - `state` (string, optional)
- Returns: `EC2InstanceSummary[]`

```ts
await adapter.execute("aws_list_instances", {
  name: "web-1",
  state: "running",
});
```

### `aws_get_instance`

- Tier: `read`
- Params:
  - `instance_id` (string, required)
- Returns: `EC2InstanceDetail`

```ts
await adapter.execute("aws_get_instance", {
  instance_id: "i-0abcdef1234567890",
});
```

### `aws_list_volumes`

- Tier: `read`
- Params: none
- Returns: `EBSVolumeSummary[]`

```ts
await adapter.execute("aws_list_volumes", {});
```

### `aws_list_vpcs`

- Tier: `read`
- Params: none
- Returns: `VPCInfo[]`

```ts
await adapter.execute("aws_list_vpcs", {});
```

### `aws_list_subnets`

- Tier: `read`
- Params:
  - `vpc_id` (string, optional)
- Returns: `SubnetInfo[]`

```ts
await adapter.execute("aws_list_subnets", {
  vpc_id: "vpc-0abc1234",
});
```

### `aws_list_security_groups`

- Tier: `read`
- Params:
  - `vpc_id` (string, optional)
- Returns: `SecurityGroupInfo[]`

```ts
await adapter.execute("aws_list_security_groups", {
  vpc_id: "vpc-0abc1234",
});
```

### `aws_list_amis`

- Tier: `read`
- Params: none
- Returns: `AMIInfo[]`

```ts
await adapter.execute("aws_list_amis", {});
```

### `aws_list_snapshots`

- Tier: `read`
- Params: none
- Returns: `EBSSnapshotInfo[]`

```ts
await adapter.execute("aws_list_snapshots", {});
```

## Safe write

### `aws_start_instance`

- Tier: `safe_write`
- Params:
  - `instance_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("aws_start_instance", {
  instance_id: "i-0abcdef1234567890",
});
```

### `aws_create_ami`

- Tier: `safe_write`
- Params:
  - `instance_id` (string, required)
  - `name` (string, required)
  - `description` (string, optional)
- Returns: `string` (new AMI id)

```ts
await adapter.execute("aws_create_ami", {
  instance_id: "i-0abcdef1234567890",
  name: "web-1-golden-2026-04",
  description: "Golden AMI before maintenance",
});
```

### `aws_create_snapshot`

- Tier: `safe_write`
- Params:
  - `volume_id` (string, required)
  - `description` (string, optional)
- Returns: `EBSSnapshotInfo`

```ts
await adapter.execute("aws_create_snapshot", {
  volume_id: "vol-0abcdef1234567890",
  description: "Pre-maintenance EBS snapshot",
});
```

## Risky write

### `aws_stop_instance`

- Tier: `risky_write`
- Params:
  - `instance_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("aws_stop_instance", {
  instance_id: "i-0abcdef1234567890",
});
```

### `aws_reboot_instance`

- Tier: `risky_write`
- Params:
  - `instance_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("aws_reboot_instance", {
  instance_id: "i-0abcdef1234567890",
});
```

### `aws_launch_instance`

- Tier: `risky_write`
- Params:
  - `ami_id` (string, required)
  - `instance_type` (string, required)
  - `subnet_id` (string, optional)
  - `security_group_ids` (string, optional, comma-separated)
  - `key_name` (string, optional)
  - `name` (string, optional)
- Returns: `EC2InstanceSummary`

```ts
await adapter.execute("aws_launch_instance", {
  ami_id: "ami-0abcde1234567890f",
  instance_type: "t3.micro",
  subnet_id: "subnet-0abc1234",
  security_group_ids: "sg-0123abcd,sg-0456efgh",
  key_name: "ops-key",
  name: "web-2",
});
```

## Destructive

### `aws_terminate_instance`

- Tier: `destructive`
- Params:
  - `instance_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("aws_terminate_instance", {
  instance_id: "i-0abcdef1234567890",
});
```

### `aws_deregister_ami`

- Tier: `destructive`
- Params:
  - `image_id` (string, required)
- Returns: `void`

```ts
await adapter.execute("aws_deregister_ami", {
  image_id: "ami-0abcde1234567890f",
});
```

## 5. Cluster state mapping

`getClusterState()` in `src/providers/aws/adapter.ts` maps AWS inventory into vClaw state:

1. Reads instances and EBS volumes.
2. Maps EC2 instances into `vms[]`:
   - `running` -> `running`
   - `stopped` -> `stopped`
   - `terminated` -> `stopped`
   - transitional states -> `unknown`
3. Maps Availability Zones into `nodes[]`.
4. Maps volumes into `storage[]`, grouped by Availability Zone.

## 6. Source-of-truth checks before doc updates

When this adapter changes, re-check these files in the same PR:

- `src/providers/aws/adapter.ts` (tool names, params, tiers, returns)
- `src/providers/aws/client.ts` (AWS SDK behavior, default filters, side effects)
- `tests/providers/aws-adapter.test.ts` (validated payload shapes and dispatch behavior)
