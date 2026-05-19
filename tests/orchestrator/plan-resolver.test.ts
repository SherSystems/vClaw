// ============================================================
// UpgradePlanResolver — translates a slash-command target (cluster
// id + optional target version) into a persisted UpgradePlan by
// reading the graph store.
//
// Synthetic graph fixtures stand in for real Proxmox / vSphere
// writers — we just register the same resource types and seed
// resources directly. The resolver shouldn't care which adapter
// wrote them.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore, z } from "../../src/graph/index.js";
import type { Resource } from "../../src/graph/types.js";
import { OrchestratorStore } from "../../src/orchestrator/index.js";
import { createPlanResolver } from "../../src/orchestrator/plan-resolver.js";

// ── Fixture helpers ──────────────────────────────────────────

/** Register the resource types we use across these tests. */
function registerTypes(graph: GraphStore): void {
  graph.registerResourceType({
    provider: "vsphere",
    type: "vsphere_cluster",
    interfaceLabels: ["Cluster"],
    allowedStates: ["healthy", "degraded", "critical", "unknown"],
    propertiesSchema: z
      .object({
        moid: z.string().optional(),
        version: z.string().optional(),
        vCenterVersion: z.string().optional(),
      })
      .passthrough(),
  });
  graph.registerResourceType({
    provider: "vsphere",
    type: "vsphere_host",
    interfaceLabels: ["ComputeNode"],
    allowedStates: ["running", "maintenance", "disconnected", "error", "unknown"],
    propertiesSchema: z.object({}).passthrough(),
  });
  graph.registerResourceType({
    provider: "vsphere",
    type: "vsphere_datastore",
    interfaceLabels: ["Storage"],
    allowedStates: ["accessible", "degraded", "inaccessible", "unknown"],
    propertiesSchema: z.object({}).passthrough(),
  });
  // For Proxmox-style ids we model a "proxmox_cluster" via the
  // existing k8s_cluster slot (any registered type works — the
  // resolver doesn't care about the substrate, only the id and
  // member_of edges).
  graph.registerResourceType({
    provider: "kubernetes",
    type: "k8s_cluster",
    interfaceLabels: ["Cluster"],
    allowedStates: ["healthy", "degraded", "critical", "unknown"],
    propertiesSchema: z
      .object({
        pveVersion: z.string().optional(),
        version: z.string().optional(),
      })
      .passthrough(),
  });
  graph.registerResourceType({
    provider: "proxmox",
    type: "proxmox_node",
    interfaceLabels: ["ComputeNode"],
    allowedStates: ["running", "maintenance", "disconnected", "error", "unknown"],
    propertiesSchema: z.object({}).passthrough(),
  });
}

function seedCluster(
  graph: GraphStore,
  opts: {
    id: string;
    name?: string;
    properties?: Record<string, unknown>;
    provider?: "vsphere" | "kubernetes";
    type?: "vsphere_cluster" | "k8s_cluster";
  },
): Resource {
  return graph.upsertResource({
    id: opts.id,
    provider: opts.provider ?? "vsphere",
    type: opts.type ?? "vsphere_cluster",
    name: opts.name ?? opts.id,
    observedState: "healthy",
    properties: opts.properties ?? { version: "8.0u2" },
  });
}

function seedHostAndLink(
  graph: GraphStore,
  opts: {
    id: string;
    clusterId: string;
    provider?: "vsphere" | "proxmox";
    type?: "vsphere_host" | "proxmox_node";
  },
): Resource {
  const host = graph.upsertResource({
    id: opts.id,
    provider: opts.provider ?? "vsphere",
    type: opts.type ?? "vsphere_host",
    name: opts.id,
    observedState: "running",
    properties: {},
  });
  graph.upsertRelationship({
    fromId: host.id,
    toId: opts.clusterId,
    type: "member_of",
    origin: "direct",
  });
  return host;
}

// ── Suite ────────────────────────────────────────────────────

describe("createPlanResolver", () => {
  let dir: string;
  let graph: GraphStore;
  let orchestrator: OrchestratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-plan-resolver-"));
    graph = new GraphStore(join(dir, "graph.db"));
    orchestrator = new OrchestratorStore(join(dir, "orchestrator.db"));
    registerTypes(graph);
  });

  afterEach(() => {
    graph.close();
    orchestrator.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a plan from a cluster with three vsphere_host members", async () => {
    const clusterId = "vsphere:vsphere_cluster:prod-east";
    seedCluster(graph, { id: clusterId, properties: { version: "8.0u2" } });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h2", clusterId });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h3", clusterId });

    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "pranav@shersystems.com");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.clusterResourceId).toBe(clusterId);
    expect(result.sourceVersion).toBe("8.0u2");
    expect(result.targetVersion).toBe("8.0u3");
    expect(result.hostCount).toBe(3);
  });

  it("returns an error when the cluster is not in the graph", async () => {
    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(
      "vsphere:vsphere_cluster:nope",
      "8.0u3",
      "operator@example.com",
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/not found in graph/);
    }
  });

  it("returns an error when the cluster has no version property", async () => {
    const clusterId = "vsphere:vsphere_cluster:no-version";
    seedCluster(graph, { id: clusterId, properties: { moid: "domain-c100" } });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });

    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "op@x");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/no recorded version/);
    }
  });

  it("returns an error when the cluster has no member hosts", async () => {
    const clusterId = "vsphere:vsphere_cluster:empty";
    seedCluster(graph, { id: clusterId });
    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "op@x");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/no member hosts/);
    }
  });

  it("returns an error when targetVersion is omitted and no inferTargetVersion is configured", async () => {
    const clusterId = "vsphere:vsphere_cluster:no-target";
    seedCluster(graph, { id: clusterId });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });
    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, undefined, "op@x");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/targetVersion required/);
    }
  });

  it("uses inferTargetVersion when targetVersion is omitted", async () => {
    const clusterId = "vsphere:vsphere_cluster:infer";
    seedCluster(graph, { id: clusterId, properties: { version: "8.0u2" } });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });
    const resolve = createPlanResolver({
      graph,
      orchestrator,
      inferTargetVersion: (_cluster, source) =>
        source === "8.0u2" ? "8.0u3" : undefined,
    });
    const result = await resolve(clusterId, undefined, "op@x");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.targetVersion).toBe("8.0u3");
    expect(result.sourceVersion).toBe("8.0u2");
  });

  it("returns an error when inferTargetVersion declines (returns undefined)", async () => {
    const clusterId = "vsphere:vsphere_cluster:infer-declines";
    seedCluster(graph, { id: clusterId, properties: { version: "8.0u2" } });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });
    const resolve = createPlanResolver({
      graph,
      orchestrator,
      inferTargetVersion: () => undefined,
    });
    const result = await resolve(clusterId, undefined, "op@x");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/targetVersion required/);
    }
  });

  it("handles a proxmox-style cluster id with proxmox_node members and a pveVersion property", async () => {
    const clusterId = "kubernetes:k8s_cluster:prox-prod";
    seedCluster(graph, {
      id: clusterId,
      provider: "kubernetes",
      type: "k8s_cluster",
      properties: { pveVersion: "8.2.4" },
    });
    seedHostAndLink(graph, {
      id: "proxmox:proxmox_node:pranavlab",
      clusterId,
      provider: "proxmox",
      type: "proxmox_node",
    });
    seedHostAndLink(graph, {
      id: "proxmox:proxmox_node:pranavlab-2",
      clusterId,
      provider: "proxmox",
      type: "proxmox_node",
    });
    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.3.0", "ops@sher");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.sourceVersion).toBe("8.2.4");
    expect(result.hostCount).toBe(2);
  });

  it("filters non-host resources that are linked via member_of", async () => {
    const clusterId = "vsphere:vsphere_cluster:mixed";
    seedCluster(graph, { id: clusterId });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });

    // Spurious member_of edge to a datastore (a poorly-modelled writer
    // might emit this). Resolver must drop it.
    const ds = graph.upsertResource({
      id: "vsphere:vsphere_datastore:ds1",
      provider: "vsphere",
      type: "vsphere_datastore",
      name: "ds1",
      observedState: "accessible",
      properties: {},
    });
    graph.upsertRelationship({
      fromId: ds.id,
      toId: clusterId,
      type: "member_of",
      origin: "direct",
    });

    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "op@x");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.hostCount).toBe(1);
  });

  it("persists the plan into the OrchestratorStore so the returned planId is loadable", async () => {
    const clusterId = "vsphere:vsphere_cluster:e2e";
    seedCluster(graph, { id: clusterId });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h2", clusterId });

    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "pranav@shersystems.com");
    if ("error" in result) throw new Error("expected success: " + result.error);

    const loaded = orchestrator.getPlan(result.planId);
    expect(loaded).not.toBeNull();
    expect(loaded!.clusterResourceId).toBe(clusterId);
    expect(loaded!.hostResourceIds).toEqual([
      "vsphere:vsphere_host:h1",
      "vsphere:vsphere_host:h2",
    ]);
    expect(loaded!.targetVersion).toBe("8.0u3");
    expect(loaded!.sourceVersion).toBe("8.0u2");
    expect(loaded!.evacuationMode).toBe("live_migrate");
  });

  it("captures the operator parameter into createPlan.createdBy", async () => {
    const clusterId = "vsphere:vsphere_cluster:operator-capture";
    seedCluster(graph, { id: clusterId });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });

    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "alice@example.com");
    if ("error" in result) throw new Error(result.error);

    const loaded = orchestrator.getPlan(result.planId);
    expect(loaded!.createdBy).toBe("alice@example.com");
  });

  it("treats a cluster with zero member_of edges as 'no member hosts'", async () => {
    const clusterId = "vsphere:vsphere_cluster:zero-edges";
    seedCluster(graph, { id: clusterId });
    // No member_of edges at all.
    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "op@x");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/no member hosts/);
    }
  });

  it("does NOT call inferTargetVersion when an explicit targetVersion is passed", async () => {
    const clusterId = "vsphere:vsphere_cluster:explicit-target";
    seedCluster(graph, { id: clusterId });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });

    const infer = vi.fn(() => "ignored-version");
    const resolve = createPlanResolver({
      graph,
      orchestrator,
      inferTargetVersion: infer,
    });
    const result = await resolve(clusterId, "8.0u3", "op@x");
    if ("error" in result) throw new Error(result.error);
    expect(result.targetVersion).toBe("8.0u3");
    expect(infer).not.toHaveBeenCalled();
  });

  it("only counts member_of edges — other relationship types pointing at the cluster are ignored", async () => {
    const clusterId = "vsphere:vsphere_cluster:manifold";
    seedCluster(graph, { id: clusterId });
    // One real member.
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h-real", clusterId });
    // A host that "manages" the cluster (synthetic — would normally
    // be a managed_by edge from the cluster to a vcenter). Either way,
    // not a member_of edge.
    const otherHost = graph.upsertResource({
      id: "vsphere:vsphere_host:h-other",
      provider: "vsphere",
      type: "vsphere_host",
      name: "h-other",
      observedState: "running",
      properties: {},
    });
    graph.upsertRelationship({
      fromId: otherHost.id,
      toId: clusterId,
      type: "managed_by",
      origin: "direct",
    });

    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "op@x");
    if ("error" in result) throw new Error(result.error);
    expect(result.hostCount).toBe(1);

    const loaded = orchestrator.getPlan(result.planId);
    expect(loaded!.hostResourceIds).toEqual(["vsphere:vsphere_host:h-real"]);
  });

  it("prefers `version` over other recognized version property keys", async () => {
    const clusterId = "vsphere:vsphere_cluster:multi-version-keys";
    seedCluster(graph, {
      id: clusterId,
      properties: { version: "8.0u2", vCenterVersion: "7.0u3" },
    });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });
    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "op@x");
    if ("error" in result) throw new Error(result.error);
    expect(result.sourceVersion).toBe("8.0u2");
  });

  it("falls back to vCenterVersion when no `version` key is present", async () => {
    const clusterId = "vsphere:vsphere_cluster:vcenter-only";
    seedCluster(graph, {
      id: clusterId,
      properties: { vCenterVersion: "7.0u3" },
    });
    seedHostAndLink(graph, { id: "vsphere:vsphere_host:h1", clusterId });
    const resolve = createPlanResolver({ graph, orchestrator });
    const result = await resolve(clusterId, "8.0u3", "op@x");
    if ("error" in result) throw new Error(result.error);
    expect(result.sourceVersion).toBe("7.0u3");
  });
});
