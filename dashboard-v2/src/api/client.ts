// API client for vClaw dashboard

const BASE = "";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function normalizeChaosSimulation(payload: unknown): import("../types").ChaosSimulation {
  const run = asRecord(payload) ?? {};
  const simulation = asRecord(run.simulation) ?? run;
  const blastRadius = asRecord(simulation.blast_radius);
  const affectedRaw = Array.isArray(blastRadius?.affected_vms)
    ? blastRadius.affected_vms
    : [];
  const affected = affectedRaw
    .map((item) => {
      const vm = asRecord(item);
      if (!vm) return null;
      const rawImpact = typeof vm.impact === "string" ? vm.impact : null;
      const impact = rawImpact ?? (vm.will_be_affected === true ? "direct" : "safe");
      return {
        vmid: String(vm.vmid ?? vm.id ?? ""),
        name: String(vm.name ?? vm.vmid ?? vm.id ?? "Unknown VM"),
        impact,
      };
    })
    .filter((vm): vm is { vmid: string; name: string; impact: string } => vm !== null);

  const scenario = asRecord(run.scenario);
  return {
    scenario_id: String(
      simulation.scenario_id ??
      scenario?.id ??
      run.scenario_id ??
      "",
    ),
    affected_vms: affected,
    predicted_recovery_time_s: Number(simulation.predicted_recovery_time_s ?? 0),
    risk_score: Number(simulation.risk_score ?? 0),
    recommendation: String(
      simulation.recommendation ??
      run.recommendation ??
      "Review blast radius before execution.",
    ),
  };
}

function normalizeChaosRun(payload: unknown): import("../types").ChaosRun {
  const run = asRecord(payload) ?? {};
  const scenario = asRecord(run.scenario);
  const score = asRecord(run.score);
  const actual = asRecord(run.actual);
  const simulation = normalizeChaosSimulation(run);
  const rawStatus = String(run.status ?? "executing");
  const validStatuses = new Set([
    "simulating",
    "pending",
    "simulated",
    "executing",
    "recovering",
    "verifying",
    "completed",
    "failed",
  ]);

  return {
    id: String(run.id ?? ""),
    scenario: {
      id: String(scenario?.id ?? run.scenario_id ?? ""),
      name: String(scenario?.name ?? run.scenario_name ?? run.scenario_id ?? "Unknown scenario"),
      description: String(scenario?.description ?? ""),
      severity: (scenario?.severity as import("../types").ChaosScenario["severity"]) ?? "medium",
      target_type: (scenario?.target_type as import("../types").ChaosScenario["target_type"]) ?? "vm",
      requires_approval: Boolean(scenario?.requires_approval),
      reversible: Boolean(scenario?.reversible),
    },
    status: (validStatuses.has(rawStatus) ? rawStatus : "executing") as import("../types").ChaosRun["status"],
    started_at: String(run.started_at ?? new Date().toISOString()),
    completed_at: typeof run.completed_at === "string" ? run.completed_at : undefined,
    blast_radius: simulation,
    actual_recovery_time_s: Number(run.actual_recovery_time_s ?? actual?.recovery_time_s ?? 0) || undefined,
    resilience_score: Number(run.resilience_score ?? score?.resilience_pct ?? 0) || undefined,
    verdict: (run.verdict ?? score?.verdict ?? undefined) as import("../types").ChaosRun["verdict"],
  };
}

// Cluster
export const fetchCluster = () =>
  request<import("../types").ClusterState>("/api/cluster");

export const fetchMultiCluster = () =>
  request<import("../types").MultiClusterState>("/api/cluster/all");

// Incidents
export const fetchIncidents = () =>
  request<{
    open: import("../types").Incident[];
    recent: import("../types").Incident[];
    patterns: unknown[];
  }>("/api/incidents");

// Audit
export const fetchAudit = (limit = 100) =>
  request<import("../types").AuditEntry[]>(`/api/audit?limit=${limit}`);

export const fetchAuditStats = () =>
  request<Record<string, unknown>>("/api/audit/stats");

export const fetchRunTelemetry = (days = 7) =>
  request<import("../types").RunTelemetrySummary>(
    `/api/telemetry/runs?days=${encodeURIComponent(String(days))}`,
  );

// Health
export const fetchPredictions = () =>
  request<{ predictions: import("../types").Prediction[] }>("/api/health/predictions");

export const fetchRightsizing = () =>
  request<{ recommendations: import("../types").RightsizingRec[] }>("/api/health/rightsizing");

// Metric history
export const fetchMetricHistory = (node: string, metric: string, range: string) =>
  request<{ points: { timestamp: number; value: number }[] }>(
    `/api/metrics/history?node=${encodeURIComponent(node)}&metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}`,
  );

// Chaos
export const fetchChaosScenarios = () =>
  request<import("../types").ChaosScenario[]>("/api/chaos/scenarios");

export const fetchChaosStatus = async () => {
  const run = await request<unknown>("/api/chaos/status");
  if (run == null) return null;
  return normalizeChaosRun(run);
};

export const fetchChaosHistory = async () => {
  const payload = await request<unknown>("/api/chaos/history");
  if (!Array.isArray(payload)) return [];
  return payload.map((run) => normalizeChaosRun(run));
};

export const simulateChaos = async (scenario: string, params: Record<string, unknown>) => {
  const payload = await request<unknown>("/api/chaos/simulate", {
    method: "POST",
    body: JSON.stringify({ scenario, params }),
  });
  return normalizeChaosSimulation(payload);
};

export const executeChaos = async (scenario: string, params: Record<string, unknown>) => {
  const payload = await request<unknown>("/api/chaos/execute", {
    method: "POST",
    body: JSON.stringify({ scenario, params }),
  });
  return normalizeChaosRun(payload);
};

export const cancelChaos = () =>
  request<{ ok: boolean; run_id: string }>("/api/chaos/cancel");

// Migration
export const fetchMigrationVMs = (provider: "vmware" | "proxmox" | "aws" | "azure") =>
  request<{ vms: import("../types").MigrationVM[] }>(`/api/migration/vms?provider=${provider}`);

export const planMigration = (direction: import("../types").MigrationDirection, vmId: string | number) =>
  request<import("../types").MigrationPlan>("/api/migration/plan", {
    method: "POST",
    body: JSON.stringify({ direction, vm_id: vmId }),
  });

export const executeMigration = (direction: import("../types").MigrationDirection, vmId: string | number) =>
  request<import("../types").MigrationPlan>("/api/migration/execute", {
    method: "POST",
    body: JSON.stringify({ direction, vm_id: vmId }),
  });

export const fetchMigrationHistory = () =>
  request<{ migrations: import("../types").MigrationPlan[] }>("/api/migration/history");

// Agent command
export const sendAgentCommand = (command: string) =>
  request<Record<string, unknown>>("/api/agent/command", {
    method: "POST",
    body: JSON.stringify({ command }),
  });

// Topology
export const fetchApps = () =>
  request<import("../types").Application[]>("/api/topology/apps");

export const fetchApp = (id: string) =>
  request<import("../types").Application>(`/api/topology/apps/${id}`);

export const createApp = (data: { name: string; tier: string; owner?: string; description?: string; tags?: string[] }) =>
  request<import("../types").Application>("/api/topology/apps", { method: "POST", body: JSON.stringify(data) });

export const deleteApp = (id: string) =>
  request<void>(`/api/topology/apps/${id}`, { method: "DELETE" });

export const addAppMember = (appId: string, member: { workload_id: string; workload_type: string; provider: string; role: string; critical?: boolean }) =>
  request<any>(`/api/topology/apps/${appId}/members`, { method: "POST", body: JSON.stringify(member) });

export const removeAppMember = (appId: string, workloadId: string) =>
  request<void>(`/api/topology/apps/${appId}/members/${workloadId}`, { method: "DELETE" });

export const addAppDependency = (appId: string, dep: { from_workload: string; to_workload: string; port: number; service: string; protocol?: string }) =>
  request<any>(`/api/topology/apps/${appId}/dependencies`, { method: "POST", body: JSON.stringify(dep) });

export const fetchTopologyGraph = () =>
  request<import("../types").TopologyGraph>("/api/topology/graph");

export const fetchImpactAnalysis = (workloadId: string) =>
  request<import("../types").ImpactReport>(`/api/topology/impact/${workloadId}`);
