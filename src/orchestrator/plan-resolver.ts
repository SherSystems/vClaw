// ============================================================
// RHODES — UpgradePlan Resolver
//
// Translates a `/rhodes upgrade <cluster_id> [to <version>]` slash
// command into a concrete `UpgradePlan` by reading the graph store.
//
// Pure async-function shape. No timers, no background work. No
// direct substrate API calls — only graph + orchestrator stores.
//
// Errors are returned as `{ error: string }` (not thrown) so the
// slash-command handler can log the failure into the audit trail
// without unwinding the request lifecycle.
// ============================================================

import type { GraphStore } from "../graph/store.js";
import type { Resource } from "../graph/types.js";
import type { OrchestratorStore } from "./store.js";

// ── Dependencies ─────────────────────────────────────────────

export interface UpgradePlanResolverDeps {
  graph: GraphStore;
  orchestrator: OrchestratorStore;
  /**
   * Optional version inference. If absent, the caller MUST pass an
   * explicit `targetVersion` to the resolver. If present, it is only
   * consulted when `targetVersion` is undefined.
   *
   * Return `undefined` to signal "I can't infer one" — the resolver
   * will then return the same error as the no-inference path.
   */
  inferTargetVersion?: (cluster: Resource, sourceVersion: string) => string | undefined;
}

// ── Result types ─────────────────────────────────────────────

export interface UpgradePlanResolveSuccess {
  planId: string;
  clusterResourceId: string;
  sourceVersion: string;
  targetVersion: string;
  hostCount: number;
}

export interface UpgradePlanResolveError {
  error: string;
}

export type UpgradePlanResolveResult =
  | UpgradePlanResolveSuccess
  | UpgradePlanResolveError;

/** The function shape `SlackRoutesContext.resolveUpgradePlan` expects. */
export type UpgradePlanResolver = (
  clusterId: string,
  targetVersion: string | undefined,
  operator: string,
) => Promise<UpgradePlanResolveResult>;

// ── Constants ────────────────────────────────────────────────

/**
 * Keys we try (in order) on `cluster.properties` to find the recorded
 * source version. The vSphere writer doesn't currently put a version
 * on the cluster — it sits on the vCenter — but a future Proxmox /
 * cluster writer may. We accept either spelling.
 */
const VERSION_PROPERTY_KEYS = [
  "version",
  "pveVersion",
  "vCenterVersion",
  "vcenterVersion",
  "clusterVersion",
] as const;

/**
 * A graph resource counts as a "host" (member of a cluster, eligible
 * for the per-host upgrade loop) if its type ends with one of these
 * suffixes. Covers both the substrate spellings RHODES currently
 * writes (`vsphere_host`, `proxmox_node`) and the K8s placeholder
 * (`k8s_node`) for future substrates.
 *
 * The cluster might also have non-host members (e.g. an attached
 * datastore via `member_of` in some future schema). We deliberately
 * filter by the type suffix rather than by interface label because
 * labels can drift and the suffix convention is more stable across
 * the codebase.
 */
const HOST_TYPE_SUFFIXES = ["_host", "_node"] as const;

// ── Factory ──────────────────────────────────────────────────

export function createPlanResolver(
  deps: UpgradePlanResolverDeps,
): UpgradePlanResolver {
  const { graph, orchestrator, inferTargetVersion } = deps;

  return async function resolveUpgradePlan(
    clusterId: string,
    targetVersion: string | undefined,
    operator: string,
  ): Promise<UpgradePlanResolveResult> {
    // 1. Cluster must exist in the graph.
    const cluster = graph.getResource(clusterId);
    if (!cluster) {
      return { error: `cluster '${clusterId}' not found in graph` };
    }

    // 2. Pull the source version off the cluster properties. Try the
    //    common spellings; the first non-empty string wins.
    const sourceVersion = readVersionProperty(cluster);
    if (!sourceVersion) {
      return {
        error: `cluster '${clusterId}' has no recorded version property (looked for ${VERSION_PROPERTY_KEYS.join(", ")})`,
      };
    }

    // 3. Find all hosts that are `member_of` this cluster. The edge
    //    points FROM the host TO the cluster (see vmware/graph-writer.ts),
    //    so we read incoming `member_of` edges.
    const memberEdges = graph.edgesTo(clusterId, "member_of");
    const hostResources: Resource[] = [];
    for (const edge of memberEdges) {
      const candidate = graph.getResource(edge.fromId);
      if (!candidate) continue;
      if (!isHostResource(candidate)) continue;
      hostResources.push(candidate);
    }

    if (hostResources.length === 0) {
      return { error: `cluster '${clusterId}' has no member hosts` };
    }

    // 4. Decide target version. Explicit arg beats inference; if
    //    neither is available we have to bail.
    let resolvedTarget = targetVersion;
    if (!resolvedTarget && inferTargetVersion) {
      resolvedTarget = inferTargetVersion(cluster, sourceVersion);
    }
    if (!resolvedTarget) {
      return {
        error: `targetVersion required: pass an explicit target (e.g. \`to 8.0u3\`) or configure inferTargetVersion`,
      };
    }

    // 5. Default evacuation mode. (Future: read from cluster.properties.)
    const evacuationMode: "live_migrate" | "evict" | "replace" = "live_migrate";

    // 6. Persist the plan.
    const plan = orchestrator.createPlan({
      clusterResourceId: cluster.id,
      sourceVersion,
      targetVersion: resolvedTarget,
      hostResourceIds: hostResources.map((h) => h.id),
      evacuationMode,
      createdBy: operator,
    });

    return {
      planId: plan.id,
      clusterResourceId: plan.clusterResourceId,
      sourceVersion: plan.sourceVersion,
      targetVersion: plan.targetVersion,
      hostCount: plan.hostResourceIds.length,
    };
  };
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Return the first non-empty string value among the recognized
 * version property keys, or `null` if none is set.
 */
function readVersionProperty(cluster: Resource): string | null {
  const props = cluster.properties as Record<string, unknown>;
  for (const key of VERSION_PROPERTY_KEYS) {
    const v = props[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Heuristic: a resource counts as a "host" (cluster compute member)
 * if its type string ends with `_host` or `_node`. Keeps us flexible
 * across substrates (vsphere_host, proxmox_node, k8s_node, …) without
 * having to maintain a closed enum here that drifts from `ResourceType`.
 */
function isHostResource(r: Resource): boolean {
  return HOST_TYPE_SUFFIXES.some((suffix) => r.type.endsWith(suffix));
}
