// ============================================================
// RHODES — Orchestrator Store Schema (DDL)
//
// Two tables: `upgrade_plans` (declarative input) and `upgrade_runs`
// (execution state). Per-host progress lives inside the run's JSON
// blob — small (host count rarely exceeds 32 per cluster) and only
// queried via the run, never independently.
//
// Idempotent. Matches the pattern of src/healing/ticket-store.ts and
// src/graph/schema.ts.
// ============================================================

export const ORCHESTRATOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS upgrade_plans (
  id                  TEXT PRIMARY KEY,
  cluster_resource_id TEXT NOT NULL,
  target_version      TEXT NOT NULL,
  source_version      TEXT NOT NULL,
  host_resource_ids   TEXT NOT NULL,            -- JSON array
  evacuation_mode     TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  approved_at         TEXT,
  approved_by         TEXT,
  CHECK (json_valid(host_resource_ids)),
  CHECK (evacuation_mode IN ('live_migrate', 'evict', 'replace'))
);

CREATE INDEX IF NOT EXISTS idx_plans_cluster ON upgrade_plans(cluster_resource_id);

CREATE TABLE IF NOT EXISTS upgrade_runs (
  id                  TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL,
  phase               TEXT NOT NULL,
  current_host_index  INTEGER NOT NULL DEFAULT -1,
  hosts               TEXT NOT NULL,            -- JSON array of HostUpgradeProgress
  started_at          TEXT,
  completed_at        TEXT,
  error_message       TEXT,
  FOREIGN KEY (plan_id) REFERENCES upgrade_plans(id) ON DELETE CASCADE,
  CHECK (json_valid(hosts)),
  CHECK (phase IN ('pending', 'approved', 'preflight', 'executing',
                   'rolling_back', 'completed', 'failed', 'aborted'))
);

CREATE INDEX IF NOT EXISTS idx_runs_plan ON upgrade_runs(plan_id);
CREATE INDEX IF NOT EXISTS idx_runs_phase ON upgrade_runs(phase);
`;
