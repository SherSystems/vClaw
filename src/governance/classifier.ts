// ============================================================
// Action Tier Classifier
// Determines the governance tier for any action + params combo
// ============================================================

import type { ActionTier, ToolDefinition } from "../types.js";

// ── Forbidden Patterns ──────────────────────────────────────
// Actions matching these patterns are unconditionally blocked.

const FORBIDDEN_PATTERNS: RegExp[] = [
  /^delete_all$/i,
  /^format_storage$/i,
  /^modify_host_config$/i,
  /^disable_firewall$/i,
  /^destroy_cluster$/i,
  /^wipe/i,
  /^rm_rf/i,
];

// ── Tier Ordering ───────────────────────────────────────────
// Higher index = more dangerous. Used for elevation logic.

const TIER_ORDER: ActionTier[] = [
  "read",
  "safe_write",
  "risky_write",
  "destructive",
  "never",
];

function tierIndex(tier: ActionTier): number {
  return TIER_ORDER.indexOf(tier);
}

function elevateTier(current: ActionTier, target: ActionTier): ActionTier {
  return tierIndex(target) > tierIndex(current) ? target : current;
}

// ── Param-Based Elevation Rules ─────────────────────────────

interface ElevationRule {
  /** Match against param keys */
  condition: (params: Record<string, unknown>) => boolean;
  /** Minimum tier this should be elevated to */
  target: ActionTier;
}

const ELEVATION_RULES: ElevationRule[] = [
  // Creating multiple VMs in one action is risky
  {
    condition: (params) => {
      const count = params.count ?? params.num_vms ?? params.quantity;
      return typeof count === "number" && count > 1;
    },
    target: "risky_write",
  },

  // High resource allocations are risky
  {
    condition: (params) => {
      const ram = params.ram_mb ?? params.memory_mb;
      return typeof ram === "number" && ram > 16384; // > 16 GB
    },
    target: "risky_write",
  },

  // Large disk allocations are risky
  {
    condition: (params) => {
      const disk = params.disk_gb ?? params.storage_gb;
      return typeof disk === "number" && disk > 500;
    },
    target: "risky_write",
  },

  // Force flags always elevate
  {
    condition: (params) =>
      params.force === true || params.skip_checks === true,
    target: "destructive",
  },

  // Deleting anything is at minimum risky
  {
    condition: (params) => params.action === "delete" || params.delete === true,
    target: "risky_write",
  },

  // Operating on multiple targets
  {
    condition: (params) => {
      const targets = params.vmids ?? params.targets ?? params.ids;
      return Array.isArray(targets) && targets.length > 3;
    },
    target: "risky_write",
  },
];

// ── Public API ──────────────────────────────────────────────

/**
 * Classify an action into a governance tier.
 *
 * 1. Check forbidden patterns — always returns "never"
 * 2. Look up base tier from tool definition
 * 3. Apply param-based elevation rules
 */
export function classifyAction(
  toolName: string,
  params: Record<string, unknown>,
  tools: ToolDefinition[],
): ActionTier {
  // Step 1: Forbidden pattern check
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(toolName)) {
      return "never";
    }
  }

  // Step 2: Base tier from tool definition
  const tool = tools.find((t) => t.name === toolName);
  let tier: ActionTier = tool?.tier ?? "risky_write"; // default to risky if unknown

  // Step 3: Param-based elevation
  for (const rule of ELEVATION_RULES) {
    if (rule.condition(params)) {
      tier = elevateTier(tier, rule.target);
    }
  }

  return tier;
}
