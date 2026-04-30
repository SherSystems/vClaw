// ============================================================
// vClaw — Kubernetes Adapter
// Read-only first pass: covers nodes, namespaces, pods,
// deployments, and services. Lifecycle ops are intentionally
// deferred to a follow-up iteration.
// ============================================================

import type {
  ClusterState,
  ContainerInfo,
  InfraAdapter,
  NodeInfo,
  StorageInfo,
  ToolCallResult,
  ToolDefinition,
} from "../types.js";

import { KubernetesClient } from "./client.js";
import type {
  K8sDeployment,
  K8sNamespace,
  K8sNode,
  K8sPod,
  K8sService,
} from "./types.js";

// ── Config ──────────────────────────────────────────────────

export interface KubernetesAdapterConfig {
  kubeconfigPath?: string;
  context?: string;
  namespace?: string;
  insecureSkipTlsVerify?: boolean;
  /** Test-only — when present, bypasses kubeconfig discovery. */
  serverOverride?: string;
  tokenOverride?: string;
}

// ── Tool definitions ────────────────────────────────────────

const ADAPTER_NAME = "kubernetes";

function tool(
  name: string,
  description: string,
  tier: ToolDefinition["tier"],
  params: ToolDefinition["params"] = [],
  returns = "object"
): ToolDefinition {
  return { name, description, tier, adapter: ADAPTER_NAME, params, returns };
}

function param(
  name: string,
  type: string,
  required: boolean,
  description: string,
  defaultValue?: unknown
): ToolDefinition["params"][number] {
  const p: ToolDefinition["params"][number] = { name, type, required, description };
  if (defaultValue !== undefined) p.default = defaultValue;
  return p;
}

const namespaceParam = param(
  "namespace",
  "string",
  false,
  "Namespace to query. Pass '*' or 'all' for cluster-wide. Defaults to the adapter's configured namespace."
);

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── Read tools ────────────────────────────────────────────
  tool(
    "kubernetes_list_nodes",
    "List all Kubernetes nodes in the cluster with status and capacity",
    "read",
    [],
    "K8sNode[]"
  ),

  tool(
    "kubernetes_get_node",
    "Get detailed info about a specific Kubernetes node",
    "read",
    [param("name", "string", true, "Node name")],
    "K8sNode"
  ),

  tool(
    "kubernetes_list_namespaces",
    "List all namespaces in the cluster",
    "read",
    [],
    "K8sNamespace[]"
  ),

  tool(
    "kubernetes_list_pods",
    "List pods, optionally filtered by namespace",
    "read",
    [namespaceParam],
    "K8sPod[]"
  ),

  tool(
    "kubernetes_get_pod",
    "Get detailed info about a specific pod",
    "read",
    [
      param("namespace", "string", true, "Namespace the pod lives in"),
      param("name", "string", true, "Pod name"),
    ],
    "K8sPod"
  ),

  tool(
    "kubernetes_list_deployments",
    "List deployments, optionally filtered by namespace",
    "read",
    [namespaceParam],
    "K8sDeployment[]"
  ),

  tool(
    "kubernetes_list_services",
    "List services, optionally filtered by namespace",
    "read",
    [namespaceParam],
    "K8sService[]"
  ),
];

// ── Adapter ─────────────────────────────────────────────────

export class KubernetesAdapter implements InfraAdapter {
  readonly name = ADAPTER_NAME;
  readonly config: KubernetesAdapterConfig;
  private client: KubernetesClient;
  private _connected = false;

  constructor(config: KubernetesAdapterConfig = {}) {
    this.config = config;
    this.client = new KubernetesClient({
      kubeconfigPath: config.kubeconfigPath,
      context: config.context,
      namespace: config.namespace,
      insecureSkipTlsVerify: config.insecureSkipTlsVerify,
      serverOverride: config.serverOverride,
      tokenOverride: config.tokenOverride,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this.client.disconnect();
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !k.startsWith("_"))
    );
    try {
      const data = await this.dispatch(toolName, cleanParams);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async dispatch(
    toolName: string,
    p: Record<string, unknown>
  ): Promise<unknown> {
    switch (toolName) {
      case "kubernetes_list_nodes":
        return this.client.listNodes();

      case "kubernetes_get_node":
        return this.client.getNode(p.name as string);

      case "kubernetes_list_namespaces":
        return this.client.listNamespaces();

      case "kubernetes_list_pods":
        return this.client.listPods(p.namespace as string | undefined);

      case "kubernetes_get_pod":
        return this.client.getPod(
          p.namespace as string,
          p.name as string
        );

      case "kubernetes_list_deployments":
        return this.client.listDeployments(
          p.namespace as string | undefined
        );

      case "kubernetes_list_services":
        return this.client.listServices(p.namespace as string | undefined);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ── Cluster state ───────────────────────────────────────

  async getClusterState(): Promise<ClusterState> {
    let rawNodes: K8sNode[] = [];
    let rawPods: K8sPod[] = [];
    try {
      [rawNodes, rawPods] = await Promise.all([
        this.client.listNodes(),
        this.client.listPods("*"),
      ]);
    } catch {
      // On partial cluster failure, return whatever we have without throwing —
      // matches Proxmox/AWS adapter behaviour.
    }

    const nodes: NodeInfo[] = rawNodes.map(mapNodeForState);
    const containers: ContainerInfo[] = rawPods.map((pod) =>
      mapPodForState(pod)
    );
    const storage: StorageInfo[] = []; // PV/PVC mapping deferred to next pass.

    return {
      adapter: ADAPTER_NAME,
      nodes,
      vms: [],
      containers,
      storage,
      timestamp: new Date().toISOString(),
    };
  }
}

// ── Internal helpers (exported for tests) ───────────────────

export const __test = {
  mapNodeForState,
  mapPodForState,
  parseCpu,
  parseMemoryMiB,
};

function parseCpu(value: string | undefined): number {
  if (!value) return 0;
  // Kubernetes CPU is a number of cores or "<n>m" for milli-cores.
  if (value.endsWith("m")) {
    const milli = Number.parseFloat(value.slice(0, -1));
    return Number.isFinite(milli) ? milli / 1000 : 0;
  }
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function parseMemoryMiB(value: string | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  // Binary suffixes: Ki, Mi, Gi, Ti
  // Decimal suffixes: K, M, G, T (kubernetes convention)
  const suffixes: Record<string, number> = {
    Ki: 1 / 1024,
    Mi: 1,
    Gi: 1024,
    Ti: 1024 * 1024,
    K: 1000 / (1024 * 1024),
    M: 1_000_000 / (1024 * 1024),
    G: 1_000_000_000 / (1024 * 1024),
    T: 1_000_000_000_000 / (1024 * 1024),
  };
  for (const [suffix, factor] of Object.entries(suffixes)) {
    if (trimmed.endsWith(suffix)) {
      const n = Number.parseFloat(trimmed.slice(0, -suffix.length));
      if (!Number.isFinite(n)) return 0;
      return Math.round(n * factor);
    }
  }
  // Plain bytes
  const bytes = Number.parseFloat(trimmed);
  if (!Number.isFinite(bytes)) return 0;
  return Math.round(bytes / (1024 * 1024));
}

function mapNodeForState(node: K8sNode): NodeInfo {
  const cpuCores = parseCpu(node.capacity.cpu);
  const ramMiB = parseMemoryMiB(node.capacity.memory);
  return {
    id: node.uid || node.name,
    name: node.name,
    status:
      node.status === "Ready"
        ? "online"
        : node.status === "NotReady"
        ? "offline"
        : "unknown",
    cpu_cores: cpuCores,
    cpu_usage_pct: 0, // metrics-server / metrics.k8s.io not consumed yet
    ram_total_mb: ramMiB,
    ram_used_mb: 0,
    disk_total_gb: 0,
    disk_used_gb: 0,
    disk_usage_pct: 0,
    uptime_s: 0,
  };
}

function mapPodForState(pod: K8sPod): ContainerInfo {
  const status: ContainerInfo["status"] =
    pod.phase === "Running"
      ? "running"
      : pod.phase === "Pending" || pod.phase === "Unknown"
      ? "unknown"
      : "stopped";
  return {
    id: pod.uid || `${pod.namespace}/${pod.name}`,
    name: `${pod.namespace}/${pod.name}`,
    node: pod.nodeName || "<unscheduled>",
    status,
    cpu_cores: 0, // requires metrics-server
    ram_mb: 0,
    disk_gb: 0,
    ip_address: pod.podIP,
    os: pod.containers[0]?.image,
  };
}
