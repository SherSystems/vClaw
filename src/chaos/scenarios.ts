// ============================================================
// vClaw — Chaos Scenarios
// Built-in failure scenarios for resilience testing
// ============================================================

// ── Interfaces ──────────────────────────────────────────────

export interface ChaosScenario {
  id: string;
  name: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  target_type: "vm" | "node" | "storage" | "network";
  /** Actions the scenario performs to inject failure */
  actions: ChaosAction[];
  /** Expected recovery behavior and SLA */
  expected_recovery: {
    description: string;
    max_recovery_time_s: number;
    verification_checks: string[];
  };
  /** Whether operator approval is required before execution */
  requires_approval: boolean;
  /** Whether the scenario can be automatically reversed */
  reversible: boolean;
}

export interface ChaosAction {
  type:
    | "stop_vm"
    | "kill_vm"
    | "stress_cpu"
    | "fill_disk"
    | "disconnect_network"
    | "custom_goal";
  /** Target identifier: vmid, node name, etc. Undefined for random-pick scenarios */
  target?: string;
  params: Record<string, unknown>;
  description: string;
  /** Optional delay before executing this action (ms) */
  delay_before_ms?: number;
}

// ── Built-in Scenarios ──────────────────────────────────────

export const BUILTIN_SCENARIOS: ChaosScenario[] = [
  // 1. VM Kill — stop a specific VM to simulate a crash
  {
    id: "vm_kill",
    name: "VM Kill",
    description:
      "Force-stop a specific VM to simulate an unexpected crash. " +
      "The healing orchestrator should detect the state change and restart it.",
    severity: "medium",
    target_type: "vm",
    actions: [
      {
        type: "stop_vm",
        params: {},
        description: "Force-stop the target VM (simulates power failure)",
      },
    ],
    expected_recovery: {
      description: "Healing orchestrator detects the VM went down and restarts it automatically",
      max_recovery_time_s: 120,
      verification_checks: [
        "vm_status_running",
        "incident_opened",
        "incident_resolved",
      ],
    },
    requires_approval: false,
    reversible: true,
  },

  // 2. Random VM Kill — pick a random running VM and stop it
  {
    id: "random_vm_kill",
    name: "Random VM Kill",
    description:
      "Select a random running VM from the cluster and force-stop it. " +
      "Tests that self-healing works regardless of which VM goes down.",
    severity: "medium",
    target_type: "vm",
    actions: [
      {
        type: "kill_vm",
        params: { random: true },
        description: "Pick a random running VM and force-stop it",
      },
    ],
    expected_recovery: {
      description: "Healing orchestrator detects and restarts the randomly-killed VM",
      max_recovery_time_s: 120,
      verification_checks: [
        "vm_status_running",
        "incident_opened",
        "incident_resolved",
      ],
    },
    requires_approval: false,
    reversible: true,
  },

  // 3. Multi-VM Kill — stop 2-3 VMs simultaneously
  {
    id: "multi_vm_kill",
    name: "Multi-VM Kill",
    description:
      "Stop 2-3 VMs simultaneously to test concurrent healing capabilities. " +
      "Validates the orchestrator can handle multiple failures at once without thrashing.",
    severity: "high",
    target_type: "vm",
    actions: [
      {
        type: "kill_vm",
        params: { count: 2, random: true },
        description: "Force-stop 2-3 running VMs simultaneously",
      },
    ],
    expected_recovery: {
      description: "All affected VMs are detected and restarted concurrently",
      max_recovery_time_s: 180,
      verification_checks: [
        "all_vms_running",
        "incidents_opened",
        "incidents_resolved",
        "no_circuit_breaker_trip",
      ],
    },
    requires_approval: true,
    reversible: true,
  },

  // 4. Node Drain — stop all VMs on a node (simulates node failure)
  {
    id: "node_drain",
    name: "Node Drain",
    description:
      "Stop every VM on a specific node to simulate a complete node failure. " +
      "This is a high-blast-radius scenario that tests bulk healing and potential migration.",
    severity: "critical",
    target_type: "node",
    actions: [
      {
        type: "stop_vm",
        params: { all_on_node: true },
        description: "Force-stop all VMs on the target node",
      },
    ],
    expected_recovery: {
      description: "All VMs on the node are detected as down and restarted (or migrated to a healthy node)",
      max_recovery_time_s: 300,
      verification_checks: [
        "all_vms_running",
        "incidents_opened",
        "incidents_resolved",
        "no_circuit_breaker_trip",
      ],
    },
    requires_approval: true,
    reversible: true,
  },

];

/**
 * Look up a built-in scenario by ID.
 */
export function getScenario(id: string): ChaosScenario | undefined {
  return BUILTIN_SCENARIOS.find((s) => s.id === id);
}

/**
 * Return all built-in scenarios.
 */
export function getAllScenarios(): ChaosScenario[] {
  return [...BUILTIN_SCENARIOS];
}
