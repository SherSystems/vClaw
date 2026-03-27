// ============================================================
// vClaw — Autopilot Rules Engine
// Self-healing rules that evaluate cluster state changes and
// produce actionable matches for the autopilot daemon.
// ============================================================

import type {
  AutopilotRule,
  ClusterState,
  VMInfo,
  NodeInfo,
} from "../types.js";

// ── RuleMatch ───────────────────────────────────────────────

export interface RuleMatch {
  rule: AutopilotRule;
  trigger: string;
  action: string;
  params: Record<string, unknown>;
}

// ── Default Rules ───────────────────────────────────────────

export const DEFAULT_RULES: AutopilotRule[] = [
  {
    id: "vm_auto_restart",
    name: "Auto-restart stopped VMs",
    condition: "vm_was_running_now_stopped",
    action: "start_vm",
    params: {},
    tier: "safe_write",
    enabled: true,
    cooldown_s: 120,
  },
  {
    id: "resource_alert_ram",
    name: "High RAM usage alert",
    condition: "node_ram_above_90",
    action: "alert",
    params: { severity: "warning" },
    tier: "read",
    enabled: true,
    cooldown_s: 300,
  },
  {
    id: "resource_alert_disk",
    name: "Critical disk usage alert",
    condition: "storage_above_95",
    action: "alert",
    params: { severity: "critical" },
    tier: "read",
    enabled: true,
    cooldown_s: 300,
  },
  {
    id: "node_offline_alert",
    name: "Node offline alert",
    condition: "node_went_offline",
    action: "alert",
    params: { severity: "critical" },
    tier: "read",
    enabled: true,
    cooldown_s: 60,
  },
];

// ── Rule Evaluation ─────────────────────────────────────────

/**
 * Evaluate all enabled rules against the current and previous cluster state.
 * Returns an array of RuleMatch objects for rules whose conditions are met
 * and whose cooldown period has elapsed.
 */
export function evaluateRules(
  rules: AutopilotRule[],
  currentState: ClusterState,
  previousState: ClusterState | null,
  now: Date,
): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Check cooldown
    if (rule.last_triggered_at) {
      const lastTriggered = new Date(rule.last_triggered_at).getTime();
      const cooldownMs = rule.cooldown_s * 1000;
      if (now.getTime() - lastTriggered < cooldownMs) {
        continue;
      }
    }

    const ruleMatches = evaluateCondition(rule, currentState, previousState);
    matches.push(...ruleMatches);
  }

  return matches;
}

// ── Condition Evaluators ────────────────────────────────────

function evaluateCondition(
  rule: AutopilotRule,
  currentState: ClusterState,
  previousState: ClusterState | null,
): RuleMatch[] {
  switch (rule.condition) {
    case "vm_was_running_now_stopped":
      return checkVmStopped(rule, currentState, previousState);

    case "node_ram_above_90":
      return checkNodeRam(rule, currentState);

    case "storage_above_95":
      return checkStorageUsage(rule, currentState);

    case "node_went_offline":
      return checkNodeOffline(rule, currentState, previousState);

    default:
      return [];
  }
}

/**
 * Detect VMs that were running in the previous state but are now stopped.
 */
function checkVmStopped(
  rule: AutopilotRule,
  currentState: ClusterState,
  previousState: ClusterState | null,
): RuleMatch[] {
  if (!previousState) return [];

  const matches: RuleMatch[] = [];

  // Build a map of previous VM states
  const prevVmMap = new Map<string | number, VMInfo>();
  for (const vm of previousState.vms) {
    prevVmMap.set(vm.id, vm);
  }

  for (const vm of currentState.vms) {
    const prevVm = prevVmMap.get(vm.id);
    if (
      prevVm &&
      prevVm.status === "running" &&
      vm.status === "stopped"
    ) {
      matches.push({
        rule,
        trigger: `VM "${vm.name}" (${vm.id}) was running but is now stopped on node ${vm.node}`,
        action: rule.action,
        params: {
          vmid: vm.id,
          node: vm.node,
          vm_name: vm.name,
        },
      });
    }
  }

  return matches;
}

/**
 * Detect nodes with RAM usage above 90%.
 */
function checkNodeRam(
  rule: AutopilotRule,
  currentState: ClusterState,
): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const node of currentState.nodes) {
    if (node.status !== "online" || node.ram_total_mb === 0) continue;

    const ramPct = (node.ram_used_mb / node.ram_total_mb) * 100;
    if (ramPct > 90) {
      matches.push({
        rule,
        trigger: `Node "${node.name}" RAM usage at ${ramPct.toFixed(1)}% (${node.ram_used_mb}/${node.ram_total_mb} MB)`,
        action: rule.action,
        params: {
          node: node.name,
          ram_pct: Math.round(ramPct * 10) / 10,
          ram_used_mb: node.ram_used_mb,
          ram_total_mb: node.ram_total_mb,
          severity: rule.params.severity ?? "warning",
        },
      });
    }
  }

  return matches;
}

/**
 * Detect storage pools with usage above 95%.
 */
function checkStorageUsage(
  rule: AutopilotRule,
  currentState: ClusterState,
): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const storage of currentState.storage) {
    if (storage.total_gb === 0) continue;

    const usedPct = (storage.used_gb / storage.total_gb) * 100;
    if (usedPct > 95) {
      matches.push({
        rule,
        trigger: `Storage "${storage.id}" on ${storage.node} at ${usedPct.toFixed(1)}% (${storage.used_gb}/${storage.total_gb} GB)`,
        action: rule.action,
        params: {
          storage_id: storage.id,
          node: storage.node,
          used_pct: Math.round(usedPct * 10) / 10,
          used_gb: storage.used_gb,
          total_gb: storage.total_gb,
          severity: rule.params.severity ?? "critical",
        },
      });
    }
  }

  return matches;
}

/**
 * Detect nodes that went from online to offline.
 */
function checkNodeOffline(
  rule: AutopilotRule,
  currentState: ClusterState,
  previousState: ClusterState | null,
): RuleMatch[] {
  if (!previousState) return [];

  const matches: RuleMatch[] = [];

  const prevNodeMap = new Map<string, NodeInfo>();
  for (const node of previousState.nodes) {
    prevNodeMap.set(node.id, node);
  }

  for (const node of currentState.nodes) {
    const prevNode = prevNodeMap.get(node.id);
    if (
      prevNode &&
      prevNode.status === "online" &&
      node.status === "offline"
    ) {
      matches.push({
        rule,
        trigger: `Node "${node.name}" went offline (was online in previous check)`,
        action: rule.action,
        params: {
          node: node.name,
          node_id: node.id,
          severity: rule.params.severity ?? "critical",
        },
      });
    }
  }

  return matches;
}
