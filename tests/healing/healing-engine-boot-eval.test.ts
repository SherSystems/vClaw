import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/agent/events.js";
import type { AgentCore, AgentRunResult } from "../../src/agent/core.js";
import { IncidentCoordinator } from "../../src/healing/incident-coordinator.js";
import { HealingEngine } from "../../src/healing/healing-engine.js";
import {
  DEFAULT_PLAYBOOKS,
  PlaybookEngine,
} from "../../src/healing/playbooks.js";
import type { RCAAnalyzer } from "../../src/healing/rca-analyzer.js";
import { HealthMonitor } from "../../src/monitoring/health.js";
import type { AnomalyDetector } from "../../src/monitoring/anomaly.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import { AgentEventType } from "../../src/types.js";

function makeRunResult(success = true, errors: string[] = []): AgentRunResult {
  return {
    success,
    plan: {
      id: "plan-1",
      goal_id: "goal-1",
      steps: [],
      created_at: new Date().toISOString(),
      status: success ? "completed" : "failed",
      resource_estimate: {
        ram_mb: 0,
        disk_gb: 0,
        cpu_cores: 0,
        vms_created: 0,
        containers_created: 0,
      },
      reasoning: "test",
      revision: 1,
    },
    steps_completed: success ? 1 : 0,
    steps_failed: success ? 0 : 1,
    replans: 0,
    duration_ms: 10,
    errors,
    outputs: [],
  };
}

// Test that boot-eval anomalies — synthesized at startup for VMs already in
// a bad state — flow through the playbook-matching pipeline identically to
// real running→paused transitions detected mid-flight. This guards the
// reported asymmetry where last night's boot caught two paused_io_error VMs
// but no plan landed in pending-approvals.
describe("HealingEngine boot-eval → playbook firing", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires the proxmox_storage_exhaustion_pause playbook for a paused_io_error VM discovered at boot", async () => {
    const dataDir = `/tmp/rhodes-boot-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempDirs.push(dataDir);
    const eventBus = new EventBus();
    const toolRegistry = {
      execute: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getClusterState: vi.fn().mockResolvedValue(null),
      getAllTools: vi.fn().mockReturnValue([]),
    } as unknown as ToolRegistry;

    const healthMonitor = new HealthMonitor(toolRegistry, eventBus);
    const detectMock = vi.fn().mockReturnValue([]);
    const anomalyDetector = {
      detect: detectMock,
    } as unknown as AnomalyDetector;
    const incidentCoordinator = new IncidentCoordinator(eventBus, dataDir);
    const playbookEngine = new PlaybookEngine(eventBus);
    const runMock = vi.fn().mockResolvedValue(makeRunResult(true));
    const agentCore = {
      run: runMock,
      aiConfig: { provider: "openai", apiKey: "test", model: "test" },
    } as unknown as AgentCore;
    const rcaAnalyzer = {
      analyze: vi.fn().mockResolvedValue(undefined),
    } as unknown as RCAAnalyzer;

    // Register the real default playbooks (storage-pause + others).
    for (const pb of DEFAULT_PLAYBOOKS) {
      playbookEngine.register(pb);
    }

    const engine = new HealingEngine(
      eventBus,
      healthMonitor,
      anomalyDetector,
      incidentCoordinator,
      {
        pollIntervalMs: 100,
        healingEnabled: true,
        maxConcurrentHeals: 2,
        bootEvalEnabled: true,
      },
      { agentCore, playbookEngine, rcaAnalyzer, toolRegistry },
    );

    // Seed the metric store with a paused_io_error vm_status sample —
    // the same shape HealthMonitor.collectVMs() produces when it sees a
    // VM in that runtime state. This is the boot-time precondition that
    // evaluateInitialState() walks.
    healthMonitor.store.record("vm_status", 1, {
      vmid: "101",
      node: "pve1",
      name: "JellyFinServer",
      runtime_status: "paused_io_error",
      reason: "paused_io_error",
    });

    await engine.tick();

    // The storage-pause playbook requires approval, so it should NOT
    // have invoked the agent runner. Instead it should have escalated
    // and matched the playbook (event_bus has the matched + escalated
    // events).
    expect(runMock).not.toHaveBeenCalled();

    const history = eventBus.getHistory();
    const matched = history.filter(
      (e) => e.type === AgentEventType.PlaybookMatched,
    );
    expect(matched).toHaveLength(1);
    expect((matched[0].data as { playbook_ids: string[] }).playbook_ids).toContain(
      "proxmox_storage_exhaustion_pause",
    );

    const escalated = history.filter(
      (e) => e.type === AgentEventType.HealingEscalated,
    );
    expect(escalated).toHaveLength(1);
    expect((escalated[0].data as { playbook_id: string }).playbook_id).toBe(
      "proxmox_storage_exhaustion_pause",
    );

    // An incident should have been opened from the boot-eval anomaly.
    const open = incidentCoordinator.incidentManager.getOpen();
    expect(open).toHaveLength(1);
    expect(open[0].metric).toBe("vm_status");
    expect(open[0].anomaly_type).toBe("state_change");
    expect(open[0].labels.reason).toBe("paused_io_error");
  });

  it("does not fire boot-eval a second time after the first tick", async () => {
    const dataDir = `/tmp/rhodes-boot-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempDirs.push(dataDir);
    const eventBus = new EventBus();
    const toolRegistry = {
      execute: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getClusterState: vi.fn().mockResolvedValue(null),
      getAllTools: vi.fn().mockReturnValue([]),
    } as unknown as ToolRegistry;
    const healthMonitor = new HealthMonitor(toolRegistry, eventBus);
    const detectMock = vi.fn().mockReturnValue([]);
    const incidentCoordinator = new IncidentCoordinator(eventBus, dataDir);
    const playbookEngine = new PlaybookEngine(eventBus);
    for (const pb of DEFAULT_PLAYBOOKS) playbookEngine.register(pb);

    const engine = new HealingEngine(
      eventBus,
      healthMonitor,
      { detect: detectMock } as unknown as AnomalyDetector,
      incidentCoordinator,
      {
        pollIntervalMs: 100,
        healingEnabled: true,
        maxConcurrentHeals: 2,
        bootEvalEnabled: true,
      },
      {
        agentCore: {
          run: vi.fn().mockResolvedValue(makeRunResult(true)),
          aiConfig: { provider: "openai", apiKey: "test", model: "test" },
        } as unknown as AgentCore,
        playbookEngine,
        rcaAnalyzer: {
          analyze: vi.fn().mockResolvedValue(undefined),
        } as unknown as RCAAnalyzer,
        toolRegistry,
      },
    );

    healthMonitor.store.record("vm_status", 1, {
      vmid: "101",
      node: "pve1",
      name: "JellyFinServer",
      runtime_status: "paused_io_error",
      reason: "paused_io_error",
    });

    await engine.tick();
    await engine.tick();

    const open = incidentCoordinator.incidentManager.getOpen();
    // Only one incident — the deduplication via findOpenIncident kicks in
    // on the second tick, and boot-eval itself is gated by
    // `bootEvalPending` to fire only once.
    expect(open).toHaveLength(1);
  });
});
