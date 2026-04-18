# Kubernetes Provider Guide

This guide documents the Kubernetes adapter exactly as implemented in:

- `src/providers/kubernetes/adapter.ts`
- `tests/providers/kubernetes-adapter.test.ts`

## 1. Current status

The Kubernetes provider is currently a scaffold.

Current behavior:

- Adapter class exists (`KubernetesAdapter`).
- `connect()` and `disconnect()` only flip in-memory connection state.
- `getTools()` returns an empty list.
- `execute()` always returns `success: false` for any tool.
- `getClusterState()` returns an empty state.

Also important: this adapter is not currently registered in `src/index.ts`, so it is not active in normal vClaw startup flows.

## 2. Constructor config surface

`KubernetesAdapterConfig` supports:

- `kubeconfigPath` (optional)
- `context` (optional)
- `namespace` (optional)

Example construction:

```ts
const adapter = new KubernetesAdapter({
  kubeconfigPath: "/tmp/kubeconfig",
  context: "dev",
  namespace: "default",
});
```

## 3. Execution behavior and errors

No tool surface exists yet.

```ts
const result = await adapter.execute("kubernetes_list_pods", {});
// { success: false, error: "Kubernetes adapter scaffold does not implement tool: kubernetes_list_pods" }
```

Error behavior from `execute()`:

- Any requested tool returns `success: false`.
- Error message includes the attempted tool name.

## 4. Tool reference

There are no public Kubernetes tools in the current implementation.

- `getTools()` -> `[]`

```ts
const tools = adapter.getTools();
// []
```

## 5. Cluster state mapping

Current scaffold state from `getClusterState()`:

- `adapter: "kubernetes"`
- `nodes: []`
- `vms: []`
- `containers: []`
- `storage: []`
- `timestamp: <current ISO datetime>`

```ts
const state = await adapter.getClusterState();
```

## 6. Planned integration points

The adapter source includes planned first-class integration points:

- `kubectl get nodes -o json` / `GET /api/v1/nodes`
- `kubectl get pods -A -o json` / `GET /api/v1/pods`
- `kubectl get events -A --sort-by=.lastTimestamp` / `GET /api/v1/events`
- `kubectl top nodes|pods` / metrics.k8s.io APIs

## 7. Source-of-truth checks before doc updates

When Kubernetes support is implemented, re-check these files in the same PR:

- `src/providers/kubernetes/adapter.ts` (tool names, params, tiers, returns)
- `src/index.ts` (registration and config gating)
- `tests/providers/kubernetes-adapter.test.ts` (real tool behavior once scaffold is replaced)
