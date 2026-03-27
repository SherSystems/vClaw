// ============================================================
// Policy Engine — Loads and validates YAML policy files
// ============================================================

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { z } from "zod";
import type { PolicyConfig } from "../types.js";

// ── Zod Schema ──────────────────────────────────────────────

const ApprovalModeSchema = z.enum([
  "approve_plan",
  "approve_risky",
  "approve_all",
  "auto",
]);

// The YAML uses "approve_fix" which maps to "approve_risky" semantically,
// but we accept it as a valid value during parsing and normalize later.
const YamlApprovalModeSchema = z.enum([
  "approve_plan",
  "approve_risky",
  "approve_all",
  "approve_fix",
  "auto",
]);

const PolicyConfigSchema = z.object({
  version: z.number().int().positive(),
  approval: z.object({
    build_mode: YamlApprovalModeSchema,
    watch_mode: YamlApprovalModeSchema,
    investigate_mode: YamlApprovalModeSchema,
  }),
  guardrails: z.object({
    max_vms_per_action: z.number().int().positive(),
    max_ram_allocation_pct: z.number().min(1).max(100),
    max_disk_allocation_pct: z.number().min(1).max(100),
    require_snapshot_before_modify: z.boolean(),
    cooldown_between_restarts_s: z.number().nonnegative(),
    max_restart_attempts: z.number().int().nonnegative(),
  }),
  boundaries: z.object({
    allowed_networks: z.array(z.string()),
    allowed_storage: z.array(z.string()),
    forbidden_vmids: z.array(z.number()),
    forbidden_actions: z.array(z.string()),
  }),
  audit: z.object({
    log_all_actions: z.boolean(),
    log_reasoning: z.boolean(),
    log_rejected_plans: z.boolean(),
    retention_days: z.number().int().positive(),
  }),
});

// ── Helpers ─────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the project root (two levels up from src/governance/) */
function projectRoot(): string {
  return resolve(__dirname, "..", "..");
}

/** Default policy path: <project_root>/policies/default.yaml */
function defaultPolicyPath(): string {
  return resolve(projectRoot(), "policies", "default.yaml");
}

/**
 * Normalize YAML approval modes to the canonical ApprovalMode union.
 * "approve_fix" is accepted in YAML as a friendly alias for "approve_risky".
 */
function normalizeApprovalMode(
  mode: string,
): PolicyConfig["approval"]["build_mode"] {
  if (mode === "approve_fix") return "approve_risky";
  return mode as PolicyConfig["approval"]["build_mode"];
}

// ── Public API ──────────────────────────────────────────────

/**
 * Load and validate a YAML policy file.
 * Falls back to policies/default.yaml when no path is provided.
 */
export function loadPolicy(path?: string): PolicyConfig {
  const filePath = path ?? defaultPolicyPath();
  const raw = readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw);

  const validated = PolicyConfigSchema.parse(parsed);

  // Normalize approval modes
  const config: PolicyConfig = {
    ...validated,
    approval: {
      build_mode: normalizeApprovalMode(validated.approval.build_mode),
      watch_mode: normalizeApprovalMode(validated.approval.watch_mode),
      investigate_mode: normalizeApprovalMode(
        validated.approval.investigate_mode,
      ),
    },
  };

  return config;
}
