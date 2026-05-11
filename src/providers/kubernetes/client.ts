// ============================================================
// RHODES — Kubernetes API Client
// Minimal read-only REST client over the kube-apiserver.
// Uses native node:https + kubeconfig parsing (js-yaml) so we
// don't pull in the heavyweight @kubernetes/client-node.
// ============================================================

import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import type {
  K8sContainerStatus,
  K8sDeployment,
  K8sNamespace,
  K8sNode,
  K8sPod,
  K8sService,
} from "./types.js";

// ── Config & connection state ───────────────────────────────

export interface KubernetesClientConfig {
  /** Path to kubeconfig file. Defaults to $KUBECONFIG or ~/.kube/config. */
  kubeconfigPath?: string;
  /** kubeconfig context name. Defaults to current-context in the file. */
  context?: string;
  /** Default namespace when callers omit one. */
  namespace?: string;
  /** Skip TLS verification (e.g. minikube). */
  insecureSkipTlsVerify?: boolean;
  /** Override server URL — primarily for tests. */
  serverOverride?: string;
  /** Override bearer token — primarily for tests. */
  tokenOverride?: string;
}

interface ResolvedConnection {
  server: string;
  token?: string;
  caBundle?: Buffer;
  clientCert?: Buffer;
  clientKey?: Buffer;
  insecureSkipTlsVerify: boolean;
  defaultNamespace: string;
}

// ── Raw kube-apiserver shapes (intentionally narrow) ────────

interface RawObjectMeta {
  name?: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
}

interface RawList<T> {
  items: T[];
}

interface RawNode {
  metadata?: RawObjectMeta;
  status?: {
    conditions?: { type: string; status: string }[];
    nodeInfo?: {
      kubeletVersion?: string;
      osImage?: string;
      kernelVersion?: string;
      containerRuntimeVersion?: string;
    };
    addresses?: { type: string; address: string }[];
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
  };
}

interface RawNamespace {
  metadata?: RawObjectMeta;
  status?: { phase?: string };
}

interface RawContainerStatus {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  state?: {
    running?: object;
    waiting?: { reason?: string };
    terminated?: { reason?: string };
  };
}

interface RawPod {
  metadata?: RawObjectMeta;
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    podIP?: string;
    hostIP?: string;
    startTime?: string;
    containerStatuses?: RawContainerStatus[];
  };
}

interface RawDeployment {
  metadata?: RawObjectMeta;
  spec?: {
    replicas?: number;
    strategy?: { type?: string };
    selector?: { matchLabels?: Record<string, string> };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
  };
}

interface RawService {
  metadata?: RawObjectMeta;
  spec?: {
    type?: string;
    clusterIP?: string;
    externalIPs?: string[];
    selector?: Record<string, string>;
    ports?: {
      name?: string;
      port: number;
      targetPort?: number | string;
      protocol?: string;
      nodePort?: number;
    }[];
  };
}

// ── kubeconfig parsing ──────────────────────────────────────

interface RawKubeconfigCluster {
  name: string;
  cluster: {
    server: string;
    "certificate-authority"?: string;
    "certificate-authority-data"?: string;
    "insecure-skip-tls-verify"?: boolean;
  };
}

interface RawKubeconfigUser {
  name: string;
  user: {
    token?: string;
    "client-certificate"?: string;
    "client-certificate-data"?: string;
    "client-key"?: string;
    "client-key-data"?: string;
  };
}

interface RawKubeconfigContext {
  name: string;
  context: { cluster: string; user: string; namespace?: string };
}

interface RawKubeconfig {
  "current-context"?: string;
  contexts?: RawKubeconfigContext[];
  clusters?: RawKubeconfigCluster[];
  users?: RawKubeconfigUser[];
}

function defaultKubeconfigPath(): string {
  return process.env.KUBECONFIG || path.join(os.homedir(), ".kube", "config");
}

function decodeMaybeBase64(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  return Buffer.from(value, "base64");
}

function loadFileMaybe(p: string | undefined): Buffer | undefined {
  if (!p) return undefined;
  return fs.readFileSync(p);
}

function resolveFromKubeconfig(
  cfg: RawKubeconfig,
  contextName: string | undefined
): ResolvedConnection {
  const targetContext = contextName || cfg["current-context"];
  if (!targetContext) {
    throw new Error("kubeconfig: no current-context and no context override");
  }

  const ctx = cfg.contexts?.find((c) => c.name === targetContext);
  if (!ctx) {
    throw new Error(`kubeconfig: context "${targetContext}" not found`);
  }

  const cluster = cfg.clusters?.find((c) => c.name === ctx.context.cluster);
  if (!cluster) {
    throw new Error(`kubeconfig: cluster "${ctx.context.cluster}" not found`);
  }

  const user = cfg.users?.find((u) => u.name === ctx.context.user);
  if (!user) {
    throw new Error(`kubeconfig: user "${ctx.context.user}" not found`);
  }

  const caBundle =
    decodeMaybeBase64(cluster.cluster["certificate-authority-data"]) ||
    loadFileMaybe(cluster.cluster["certificate-authority"]);

  const clientCert =
    decodeMaybeBase64(user.user["client-certificate-data"]) ||
    loadFileMaybe(user.user["client-certificate"]);

  const clientKey =
    decodeMaybeBase64(user.user["client-key-data"]) ||
    loadFileMaybe(user.user["client-key"]);

  return {
    server: cluster.cluster.server,
    token: user.user.token,
    caBundle,
    clientCert,
    clientKey,
    insecureSkipTlsVerify: cluster.cluster["insecure-skip-tls-verify"] === true,
    defaultNamespace: ctx.context.namespace || "default",
  };
}

function resolveInCluster(): ResolvedConnection | null {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) return null;

  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
  const nsPath = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

  if (!fs.existsSync(tokenPath)) return null;
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const caBundle = fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined;
  const defaultNamespace = fs.existsSync(nsPath)
    ? fs.readFileSync(nsPath, "utf8").trim()
    : "default";

  return {
    server: `https://${host}:${port}`,
    token,
    caBundle,
    insecureSkipTlsVerify: false,
    defaultNamespace,
  };
}

// ── Errors ──────────────────────────────────────────────────

export class KubernetesApiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = "KubernetesApiError";
    this.status = status;
    this.reason = reason;
  }
}

// ── Client ──────────────────────────────────────────────────

export class KubernetesClient {
  private readonly cfg: KubernetesClientConfig;
  private connection: ResolvedConnection | null = null;
  private connected = false;

  constructor(cfg: KubernetesClientConfig = {}) {
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    this.connection = this.resolveConnection();
    // Probe /version to verify reachability + auth.
    try {
      await this.request<unknown>("GET", "/version");
      this.connected = true;
    } catch (err) {
      this.connected = false;
      throw err;
    }
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getDefaultNamespace(): string {
    return this.connection?.defaultNamespace || this.cfg.namespace || "default";
  }

  private resolveConnection(): ResolvedConnection {
    // Test/explicit override beats everything.
    if (this.cfg.serverOverride) {
      return {
        server: this.cfg.serverOverride,
        token: this.cfg.tokenOverride,
        insecureSkipTlsVerify: this.cfg.insecureSkipTlsVerify ?? true,
        defaultNamespace: this.cfg.namespace || "default",
      };
    }

    const inCluster = resolveInCluster();
    if (inCluster) {
      if (this.cfg.namespace) inCluster.defaultNamespace = this.cfg.namespace;
      if (this.cfg.insecureSkipTlsVerify !== undefined) {
        inCluster.insecureSkipTlsVerify = this.cfg.insecureSkipTlsVerify;
      }
      return inCluster;
    }

    const kubeconfigPath = this.cfg.kubeconfigPath || defaultKubeconfigPath();
    if (!fs.existsSync(kubeconfigPath)) {
      throw new Error(
        `Kubernetes connection failed: kubeconfig not found at ${kubeconfigPath} ` +
          `and no in-cluster service account available`
      );
    }

    let parsed: RawKubeconfig;
    try {
      parsed = yaml.load(fs.readFileSync(kubeconfigPath, "utf8")) as RawKubeconfig;
    } catch (err) {
      throw new Error(
        `Kubernetes connection failed: invalid kubeconfig at ${kubeconfigPath}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }

    const resolved = resolveFromKubeconfig(parsed, this.cfg.context);
    if (this.cfg.namespace) resolved.defaultNamespace = this.cfg.namespace;
    if (this.cfg.insecureSkipTlsVerify !== undefined) {
      resolved.insecureSkipTlsVerify = this.cfg.insecureSkipTlsVerify;
    }
    return resolved;
  }

  // ── Generic request ─────────────────────────────────────

  private request<T>(method: string, apiPath: string): Promise<T> {
    if (!this.connection) {
      throw new Error("Kubernetes client is not connected");
    }
    const conn = this.connection;
    const url = new URL(apiPath, conn.server);

    return new Promise<T>((resolve, reject) => {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (conn.token) headers.Authorization = `Bearer ${conn.token}`;

      const isHttps = url.protocol === "https:";
      const transport = isHttps ? https : http;

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search || ""}`,
        method,
        headers,
      };

      if (isHttps) {
        options.rejectUnauthorized = !conn.insecureSkipTlsVerify;
        if (conn.caBundle) options.ca = conn.caBundle;
        if (conn.clientCert) options.cert = conn.clientCert;
        if (conn.clientKey) options.key = conn.clientKey;
      }

      const req = transport.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              resolve(data as unknown as T);
            }
            return;
          }

          let reason = res.statusMessage || "Unknown";
          let message = `Kubernetes API error: ${status} ${reason}`;
          try {
            const parsed = JSON.parse(data) as {
              reason?: string;
              message?: string;
            };
            if (parsed.reason) reason = parsed.reason;
            if (parsed.message) message = parsed.message;
          } catch {
            if (data) message += ` — ${data.slice(0, 500)}`;
          }
          reject(new KubernetesApiError(status, reason, message));
        });
      });

      req.on("error", (err) => {
        reject(new Error(`Kubernetes request failed: ${err.message}`));
      });

      req.setTimeout(30_000, () => {
        req.destroy();
        reject(
          new Error(`Kubernetes request timed out: ${method} ${apiPath}`)
        );
      });

      req.end();
    });
  }

  // ── Read operations ─────────────────────────────────────

  async listNodes(): Promise<K8sNode[]> {
    const resp = await this.request<RawList<RawNode>>(
      "GET",
      "/api/v1/nodes"
    );
    return (resp.items || []).map(mapNode);
  }

  async getNode(name: string): Promise<K8sNode> {
    if (!name) throw new Error("getNode: name is required");
    const resp = await this.request<RawNode>(
      "GET",
      `/api/v1/nodes/${encodeURIComponent(name)}`
    );
    return mapNode(resp);
  }

  async listNamespaces(): Promise<K8sNamespace[]> {
    const resp = await this.request<RawList<RawNamespace>>(
      "GET",
      "/api/v1/namespaces"
    );
    return (resp.items || []).map(mapNamespace);
  }

  async listPods(namespace?: string): Promise<K8sPod[]> {
    const ns = namespace ?? this.getDefaultNamespace();
    const path =
      ns === "*" || ns === "all"
        ? "/api/v1/pods"
        : `/api/v1/namespaces/${encodeURIComponent(ns)}/pods`;
    const resp = await this.request<RawList<RawPod>>("GET", path);
    return (resp.items || []).map(mapPod);
  }

  async getPod(namespace: string, name: string): Promise<K8sPod> {
    if (!name) throw new Error("getPod: name is required");
    const ns = namespace || this.getDefaultNamespace();
    const resp = await this.request<RawPod>(
      "GET",
      `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`
    );
    return mapPod(resp);
  }

  async listDeployments(namespace?: string): Promise<K8sDeployment[]> {
    const ns = namespace ?? this.getDefaultNamespace();
    const path =
      ns === "*" || ns === "all"
        ? "/apis/apps/v1/deployments"
        : `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments`;
    const resp = await this.request<RawList<RawDeployment>>("GET", path);
    return (resp.items || []).map(mapDeployment);
  }

  async listServices(namespace?: string): Promise<K8sService[]> {
    const ns = namespace ?? this.getDefaultNamespace();
    const path =
      ns === "*" || ns === "all"
        ? "/api/v1/services"
        : `/api/v1/namespaces/${encodeURIComponent(ns)}/services`;
    const resp = await this.request<RawList<RawService>>("GET", path);
    return (resp.items || []).map(mapService);
  }
}

// ── Mappers ─────────────────────────────────────────────────

function nodeStatus(raw: RawNode): K8sNode["status"] {
  const conditions = raw.status?.conditions ?? [];
  const ready = conditions.find((c) => c.type === "Ready");
  if (!ready) return "Unknown";
  if (ready.status === "True") return "Ready";
  if (ready.status === "False") return "NotReady";
  return "Unknown";
}

function nodeRoles(labels: Record<string, string>): string[] {
  const roles: string[] = [];
  for (const k of Object.keys(labels)) {
    if (k.startsWith("node-role.kubernetes.io/")) {
      const role = k.substring("node-role.kubernetes.io/".length);
      if (role) roles.push(role);
    }
  }
  return roles.length > 0 ? roles : ["<none>"];
}

function mapNode(raw: RawNode): K8sNode {
  const meta = raw.metadata || {};
  const labels = meta.labels || {};
  const info = raw.status?.nodeInfo || {};
  const capacity = raw.status?.capacity || {};
  const allocatable = raw.status?.allocatable || {};
  const internalIP = (raw.status?.addresses || []).find(
    (a) => a.type === "InternalIP"
  )?.address;

  return {
    name: meta.name || "",
    uid: meta.uid || "",
    status: nodeStatus(raw),
    roles: nodeRoles(labels),
    kubeletVersion: info.kubeletVersion || "",
    osImage: info.osImage || "",
    kernelVersion: info.kernelVersion || "",
    containerRuntimeVersion: info.containerRuntimeVersion || "",
    internalIP,
    capacity: {
      cpu: capacity.cpu || "0",
      memory: capacity.memory || "0",
      pods: capacity.pods || "0",
      storage: capacity["ephemeral-storage"],
    },
    allocatable: {
      cpu: allocatable.cpu || "0",
      memory: allocatable.memory || "0",
      pods: allocatable.pods || "0",
      storage: allocatable["ephemeral-storage"],
    },
    creationTimestamp: meta.creationTimestamp,
    labels,
  };
}

function mapNamespace(raw: RawNamespace): K8sNamespace {
  const meta = raw.metadata || {};
  return {
    name: meta.name || "",
    uid: meta.uid || "",
    status: raw.status?.phase || "Unknown",
    creationTimestamp: meta.creationTimestamp,
    labels: meta.labels || {},
  };
}

function mapContainerStatus(c: RawContainerStatus): K8sContainerStatus {
  let state: K8sContainerStatus["state"] = "unknown";
  let reason: string | undefined;
  if (c.state?.running) state = "running";
  else if (c.state?.waiting) {
    state = "waiting";
    reason = c.state.waiting.reason;
  } else if (c.state?.terminated) {
    state = "terminated";
    reason = c.state.terminated.reason;
  }
  return {
    name: c.name,
    image: c.image,
    ready: c.ready,
    restartCount: c.restartCount,
    state,
    reason,
  };
}

function mapPodPhase(phase?: string): K8sPod["phase"] {
  switch (phase) {
    case "Pending":
    case "Running":
    case "Succeeded":
    case "Failed":
      return phase;
    default:
      return "Unknown";
  }
}

function mapPod(raw: RawPod): K8sPod {
  const meta = raw.metadata || {};
  const containerStatuses = raw.status?.containerStatuses || [];
  const containers = containerStatuses.map(mapContainerStatus);
  const restartCount = containers.reduce((sum, c) => sum + c.restartCount, 0);
  return {
    name: meta.name || "",
    namespace: meta.namespace || "",
    uid: meta.uid || "",
    phase: mapPodPhase(raw.status?.phase),
    nodeName: raw.spec?.nodeName,
    podIP: raw.status?.podIP,
    hostIP: raw.status?.hostIP,
    containers,
    startTime: raw.status?.startTime,
    creationTimestamp: meta.creationTimestamp,
    labels: meta.labels || {},
    restartCount,
  };
}

function mapDeployment(raw: RawDeployment): K8sDeployment {
  const meta = raw.metadata || {};
  return {
    name: meta.name || "",
    namespace: meta.namespace || "",
    uid: meta.uid || "",
    replicas: raw.spec?.replicas ?? 0,
    readyReplicas: raw.status?.readyReplicas ?? 0,
    availableReplicas: raw.status?.availableReplicas ?? 0,
    updatedReplicas: raw.status?.updatedReplicas ?? 0,
    strategy: raw.spec?.strategy?.type || "RollingUpdate",
    creationTimestamp: meta.creationTimestamp,
    labels: meta.labels || {},
    selector: raw.spec?.selector?.matchLabels || {},
  };
}

function mapService(raw: RawService): K8sService {
  const meta = raw.metadata || {};
  const ports = (raw.spec?.ports || []).map((p) => ({
    name: p.name,
    port: p.port,
    targetPort: p.targetPort ?? p.port,
    protocol: p.protocol || "TCP",
    nodePort: p.nodePort,
  }));
  return {
    name: meta.name || "",
    namespace: meta.namespace || "",
    uid: meta.uid || "",
    type: raw.spec?.type || "ClusterIP",
    clusterIP: raw.spec?.clusterIP,
    externalIPs: raw.spec?.externalIPs || [],
    ports,
    selector: raw.spec?.selector || {},
    creationTimestamp: meta.creationTimestamp,
    labels: meta.labels || {},
  };
}
