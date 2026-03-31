import { describe, it, expect } from "vitest";
import { KubernetesAdapter } from "../../src/providers/kubernetes/adapter.js";

describe("KubernetesAdapter scaffold", () => {
  it("connects/disconnects and returns empty cluster state", async () => {
    const adapter = new KubernetesAdapter({
      kubeconfigPath: "/tmp/kubeconfig",
      context: "dev",
      namespace: "default",
    });

    expect(adapter.isConnected()).toBe(false);
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);

    const state = await adapter.getClusterState();
    expect(state.adapter).toBe("kubernetes");
    expect(state.nodes).toEqual([]);
    expect(state.vms).toEqual([]);
    expect(state.containers).toEqual([]);
    expect(state.storage).toEqual([]);

    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it("exposes no tools and returns a scaffold error for execute", async () => {
    const adapter = new KubernetesAdapter();
    expect(adapter.getTools()).toEqual([]);

    const result = await adapter.execute("kubernetes_list_pods", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not implement tool");
  });
});
