import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock the KubernetesClient at the module boundary ────────
// Mirrors the proxmox-adapter / azure-adapter test pattern.

vi.mock("../../src/providers/kubernetes/client.js", () => {
  class FakeKubernetesApiError extends Error {
    status: number;
    reason: string;
    constructor(status: number, reason: string, message: string) {
      super(message);
      this.status = status;
      this.reason = reason;
    }
  }

  const mockClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getDefaultNamespace: vi.fn().mockReturnValue("default"),
    listNodes: vi.fn().mockResolvedValue([
      {
        name: "node-1",
        uid: "node-uid-1",
        status: "Ready",
        roles: ["control-plane"],
        kubeletVersion: "v1.29.0",
        osImage: "Ubuntu 22.04",
        kernelVersion: "5.15.0",
        containerRuntimeVersion: "containerd://1.7.0",
        internalIP: "10.0.0.1",
        capacity: { cpu: "8", memory: "16384Mi", pods: "110" },
        allocatable: { cpu: "7800m", memory: "15000Mi", pods: "110" },
        labels: { "node-role.kubernetes.io/control-plane": "" },
      },
      {
        name: "node-2",
        uid: "node-uid-2",
        status: "NotReady",
        roles: ["<none>"],
        kubeletVersion: "v1.29.0",
        osImage: "Ubuntu 22.04",
        kernelVersion: "5.15.0",
        containerRuntimeVersion: "containerd://1.7.0",
        capacity: { cpu: "4", memory: "8192Mi", pods: "110" },
        allocatable: { cpu: "3800m", memory: "7000Mi", pods: "110" },
        labels: {},
      },
    ]),
    getNode: vi.fn().mockResolvedValue({
      name: "node-1",
      uid: "node-uid-1",
      status: "Ready",
      roles: ["control-plane"],
      kubeletVersion: "v1.29.0",
      osImage: "Ubuntu 22.04",
      kernelVersion: "5.15.0",
      containerRuntimeVersion: "containerd://1.7.0",
      capacity: { cpu: "8", memory: "16384Mi", pods: "110" },
      allocatable: { cpu: "7800m", memory: "15000Mi", pods: "110" },
      labels: {},
    }),
    listNamespaces: vi.fn().mockResolvedValue([
      {
        name: "default",
        uid: "ns-default",
        status: "Active",
        labels: {},
      },
      {
        name: "kube-system",
        uid: "ns-kube-system",
        status: "Active",
        labels: {},
      },
    ]),
    listPods: vi.fn().mockResolvedValue([
      {
        name: "web-1",
        namespace: "default",
        uid: "pod-uid-1",
        phase: "Running",
        nodeName: "node-1",
        podIP: "10.244.0.5",
        hostIP: "10.0.0.1",
        containers: [
          {
            name: "nginx",
            image: "nginx:1.25",
            ready: true,
            restartCount: 0,
            state: "running",
          },
        ],
        labels: { app: "web" },
        restartCount: 0,
      },
      {
        name: "worker-1",
        namespace: "jobs",
        uid: "pod-uid-2",
        phase: "Pending",
        containers: [],
        labels: {},
        restartCount: 0,
      },
    ]),
    getPod: vi.fn().mockResolvedValue({
      name: "web-1",
      namespace: "default",
      uid: "pod-uid-1",
      phase: "Running",
      nodeName: "node-1",
      podIP: "10.244.0.5",
      containers: [
        {
          name: "nginx",
          image: "nginx:1.25",
          ready: true,
          restartCount: 1,
          state: "running",
        },
      ],
      labels: {},
      restartCount: 1,
    }),
    listDeployments: vi.fn().mockResolvedValue([
      {
        name: "web",
        namespace: "default",
        uid: "deploy-uid-1",
        replicas: 3,
        readyReplicas: 3,
        availableReplicas: 3,
        updatedReplicas: 3,
        strategy: "RollingUpdate",
        labels: {},
        selector: { app: "web" },
      },
    ]),
    listServices: vi.fn().mockResolvedValue([
      {
        name: "web",
        namespace: "default",
        uid: "svc-uid-1",
        type: "ClusterIP",
        clusterIP: "10.96.0.10",
        externalIPs: [],
        ports: [{ port: 80, targetPort: 8080, protocol: "TCP" }],
        selector: { app: "web" },
        labels: {},
      },
    ]),
  };

  return {
    KubernetesClient: vi.fn().mockImplementation(function () { return mockClient; }),
    KubernetesApiError: FakeKubernetesApiError,
    __mockClient: mockClient,
  };
});

// Pull out the shared mock so individual tests can tweak it.
import * as clientModule from "../../src/providers/kubernetes/client.js";
const mockClient = (clientModule as unknown as { __mockClient: Record<string, ReturnType<typeof vi.fn>> }).__mockClient;

import { KubernetesAdapter, __test } from "../../src/providers/kubernetes/adapter.js";
import { ToolRegistry } from "../../src/providers/registry.js";

// ── Tests ───────────────────────────────────────────────────

describe("KubernetesAdapter — lifecycle", () => {
  beforeEach(() => {
    for (const fn of Object.values(mockClient)) {
      if (typeof fn?.mockClear === "function") fn.mockClear();
    }
    // Restore default behaviours
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.isConnected.mockReturnValue(true);
  });

  it("connects, reports name, and disconnects", async () => {
    const adapter = new KubernetesAdapter({
      kubeconfigPath: "/tmp/kubeconfig",
      context: "dev",
      namespace: "default",
    });

    expect(adapter.name).toBe("kubernetes");
    expect(adapter.isConnected()).toBe(false);
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it("propagates connect failures (cluster unreachable)", async () => {
    mockClient.connect.mockRejectedValueOnce(
      new Error("Kubernetes request failed: ECONNREFUSED 127.0.0.1:6443")
    );

    const adapter = new KubernetesAdapter();
    await expect(adapter.connect()).rejects.toThrow(/ECONNREFUSED/);
    expect(adapter.isConnected()).toBe(false);
  });
});

describe("KubernetesAdapter — read tools", () => {
  let adapter: KubernetesAdapter;

  beforeEach(async () => {
    for (const fn of Object.values(mockClient)) {
      if (typeof fn?.mockClear === "function") fn.mockClear();
    }
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.isConnected.mockReturnValue(true);
    mockClient.getDefaultNamespace.mockReturnValue("default");
    adapter = new KubernetesAdapter();
    await adapter.connect();
  });

  it("registers exactly the read tools we ship", () => {
    const tools = adapter.getTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "kubernetes_get_node",
      "kubernetes_get_pod",
      "kubernetes_list_deployments",
      "kubernetes_list_namespaces",
      "kubernetes_list_nodes",
      "kubernetes_list_pods",
      "kubernetes_list_services",
    ]);
    for (const t of tools) {
      expect(t.adapter).toBe("kubernetes");
      expect(t.tier).toBe("read");
    }
  });

  it("kubernetes_list_nodes returns shaped data", async () => {
    const result = await adapter.execute("kubernetes_list_nodes", {});
    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string; status: string }>;
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ name: "node-1", status: "Ready" });
    expect(data[1]).toMatchObject({ name: "node-2", status: "NotReady" });
  });

  it("kubernetes_get_node forwards name and returns one node", async () => {
    const result = await adapter.execute("kubernetes_get_node", {
      name: "node-1",
    });
    expect(result.success).toBe(true);
    expect(mockClient.getNode).toHaveBeenCalledWith("node-1");
    expect((result.data as { name: string }).name).toBe("node-1");
  });

  it("kubernetes_list_namespaces returns all namespaces", async () => {
    const result = await adapter.execute("kubernetes_list_namespaces", {});
    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string }>;
    expect(data.map((n) => n.name)).toEqual(["default", "kube-system"]);
  });

  it("kubernetes_list_pods passes namespace through (including '*')", async () => {
    const r1 = await adapter.execute("kubernetes_list_pods", {
      namespace: "default",
    });
    expect(r1.success).toBe(true);
    expect(mockClient.listPods).toHaveBeenLastCalledWith("default");

    const r2 = await adapter.execute("kubernetes_list_pods", {
      namespace: "*",
    });
    expect(r2.success).toBe(true);
    expect(mockClient.listPods).toHaveBeenLastCalledWith("*");
  });

  it("kubernetes_get_pod returns details for the requested pod", async () => {
    const result = await adapter.execute("kubernetes_get_pod", {
      namespace: "default",
      name: "web-1",
    });
    expect(result.success).toBe(true);
    expect(mockClient.getPod).toHaveBeenCalledWith("default", "web-1");
    const data = result.data as { name: string; restartCount: number };
    expect(data.name).toBe("web-1");
    expect(data.restartCount).toBe(1);
  });

  it("kubernetes_list_deployments returns deployments", async () => {
    const result = await adapter.execute("kubernetes_list_deployments", {});
    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string; replicas: number }>;
    expect(data[0]).toMatchObject({ name: "web", replicas: 3 });
  });

  it("kubernetes_list_services returns services with port info", async () => {
    const result = await adapter.execute("kubernetes_list_services", {});
    expect(result.success).toBe(true);
    const data = result.data as Array<{
      name: string;
      ports: { port: number }[];
    }>;
    expect(data[0]).toMatchObject({ name: "web" });
    expect(data[0].ports[0].port).toBe(80);
  });

  it("rejects unknown tool names", async () => {
    const result = await adapter.execute("kubernetes_delete_pod", {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });
});

describe("KubernetesAdapter — error paths", () => {
  let adapter: KubernetesAdapter;

  beforeEach(async () => {
    for (const fn of Object.values(mockClient)) {
      if (typeof fn?.mockClear === "function") fn.mockClear();
    }
    mockClient.connect.mockResolvedValue(undefined);
    adapter = new KubernetesAdapter();
    await adapter.connect();
  });

  it("returns an error result when the API call fails (auth)", async () => {
    const ApiError = (
      clientModule as unknown as {
        KubernetesApiError: new (s: number, r: string, m: string) => Error;
      }
    ).KubernetesApiError;
    mockClient.listPods.mockRejectedValueOnce(
      new ApiError(401, "Unauthorized", "Unauthorized")
    );

    const result = await adapter.execute("kubernetes_list_pods", {
      namespace: "default",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unauthorized/);
  });

  it("returns an error result when a namespace is not found", async () => {
    const ApiError = (
      clientModule as unknown as {
        KubernetesApiError: new (s: number, r: string, m: string) => Error;
      }
    ).KubernetesApiError;
    mockClient.listPods.mockRejectedValueOnce(
      new ApiError(404, "NotFound", 'namespaces "missing" not found')
    );

    const result = await adapter.execute("kubernetes_list_pods", {
      namespace: "missing",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("getClusterState swallows partial failures and returns empty state", async () => {
    mockClient.listNodes.mockRejectedValueOnce(new Error("boom"));
    mockClient.listPods.mockRejectedValueOnce(new Error("boom"));

    const state = await adapter.getClusterState();
    expect(state.adapter).toBe("kubernetes");
    expect(state.nodes).toEqual([]);
    expect(state.containers).toEqual([]);
    expect(state.vms).toEqual([]);
    expect(state.storage).toEqual([]);
    expect(typeof state.timestamp).toBe("string");
  });
});

describe("KubernetesAdapter — cluster state mapping", () => {
  let adapter: KubernetesAdapter;

  beforeEach(async () => {
    for (const fn of Object.values(mockClient)) {
      if (typeof fn?.mockClear === "function") fn.mockClear();
    }
    mockClient.connect.mockResolvedValue(undefined);
    adapter = new KubernetesAdapter();
    await adapter.connect();
  });

  it("maps nodes (Ready/NotReady) and pods into ClusterState", async () => {
    const state = await adapter.getClusterState();
    expect(state.adapter).toBe("kubernetes");
    expect(state.nodes).toHaveLength(2);
    expect(state.nodes[0]).toMatchObject({
      name: "node-1",
      status: "online",
      cpu_cores: 8,
    });
    expect(state.nodes[1].status).toBe("offline");

    expect(state.containers).toHaveLength(2);
    const running = state.containers.find((c) => c.status === "running");
    expect(running?.name).toBe("default/web-1");
    expect(running?.ip_address).toBe("10.244.0.5");

    const pending = state.containers.find((c) => c.status === "unknown");
    expect(pending?.name).toBe("jobs/worker-1");
  });
});

describe("KubernetesAdapter — tool registry integration", () => {
  it("registers cleanly and dispatches through ToolRegistry", async () => {
    for (const fn of Object.values(mockClient)) {
      if (typeof fn?.mockClear === "function") fn.mockClear();
    }
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.isConnected.mockReturnValue(true);

    const registry = new ToolRegistry();
    const adapter = new KubernetesAdapter();
    await adapter.connect();
    registry.registerAdapter(adapter);

    const k8sTools = registry.getToolsByAdapter("kubernetes");
    expect(k8sTools.length).toBeGreaterThanOrEqual(7);

    const result = await registry.execute("kubernetes_list_nodes", {});
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });
});

describe("KubernetesAdapter — quantity parsing helpers", () => {
  it("parses CPU as cores and milli-cores", () => {
    expect(__test.parseCpu("4")).toBe(4);
    expect(__test.parseCpu("500m")).toBe(0.5);
    expect(__test.parseCpu("2500m")).toBe(2.5);
    expect(__test.parseCpu(undefined)).toBe(0);
    expect(__test.parseCpu("")).toBe(0);
  });

  it("parses memory with binary and decimal suffixes", () => {
    expect(__test.parseMemoryMiB("1024Mi")).toBe(1024);
    expect(__test.parseMemoryMiB("1Gi")).toBe(1024);
    expect(__test.parseMemoryMiB("1024Ki")).toBe(1);
    // 1G (decimal) ≈ 953.67 MiB
    expect(__test.parseMemoryMiB("1G")).toBe(954);
    expect(__test.parseMemoryMiB(undefined)).toBe(0);
  });
});
