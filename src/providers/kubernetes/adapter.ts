import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
} from "../types.js";

export interface KubernetesAdapterConfig {
  kubeconfigPath?: string;
  context?: string;
  namespace?: string;
}

/**
 * Kubernetes adapter scaffold.
 * Planned first-class integration points:
 * - `kubectl get nodes -o json` / `GET /api/v1/nodes`
 * - `kubectl get pods -A -o json` / `GET /api/v1/pods`
 * - `kubectl get events -A --sort-by=.lastTimestamp` / `GET /api/v1/events`
 * - `kubectl top nodes|pods` / metrics.k8s.io APIs
 */
export class KubernetesAdapter implements InfraAdapter {
  readonly name = "kubernetes";
  private _connected = false;
  readonly config: KubernetesAdapterConfig;

  constructor(config: KubernetesAdapterConfig = {}) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    // Scaffold only: no tool surface yet.
    return [];
  }

  async execute(tool: string, _params: Record<string, unknown>): Promise<ToolCallResult> {
    return {
      success: false,
      error: `Kubernetes adapter scaffold does not implement tool: ${tool}`,
    };
  }

  async getClusterState(): Promise<ClusterState> {
    // Scaffold state: empty until Kubernetes inventory sync is implemented.
    return {
      adapter: this.name,
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }
}
