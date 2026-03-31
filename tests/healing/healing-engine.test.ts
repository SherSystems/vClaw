import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/agent/events.js";
import type { AgentCore, AgentRunResult } from "../../src/agent/core.js";
import { IncidentCoordinator } from "../../src/healing/incident-coordinator.js";
import { HealingEngine, type HealingEngineConfig, type TickSummary } from "../../src/healing/healing-engine.js";
import { PlaybookEngine, type Playbook } from "../../src/healing/playbooks.js";
import type { RCAAnalyzer } from "../../src/healing/rca-analyzer.js";
import { HealthMonitor } from "../../src/monitoring/health.js";
import type { Anomaly, AnomalyDetector } from "../../src/monitoring/anomaly.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import { AgentEventType } from "../../src/types.js";

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "anomaly-1",
    type: "threshold",
    severity: "critical",
    metric: "vm_status",
    labels: { node: "pve1", vmid: "101", name: "web-01" },
    current_value: 0,
    message: "VM crashed",
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "vm_crashed_test",
    name: "Recover VM",
    description: "restart crashed vm",
    trigger: {
      metric: "vm_status",
      type: "threshold",
      severity: "critical",
    },
    actions: [
      {
        type: "restart_vm",
        params: {},
        description: "Restart VM",
      },
    ],
    cooldown_minutes: 1,
    requires_approval: false,
    max_retries: 1,
    ...overrides,
  };
}

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
    duration_ms: 25,
    errors,
    outputs: [],
  };
}

function makeSummary(): TickSummary {
  return {
    timestamp: new Date().toISOString(),
    anomaliesDetected: 0,
    healingsStarted: 0,
    healingsCompleted: 0,
    healingsFailed: 0,
    openIncidents: 0,
    activeHeals: 0,
    circuitBreakerPaused: false,
  };
}

function anomalyKey(anomaly: Anomaly): string {
  const labelString = Object.entries(anomaly.labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${anomaly.type}:${anomaly.metric}:{${labelString}}`;
}

interface TestContext {
  dataDir: string;
  eventBus: EventBus;
  healthMonitor: HealthMonitor;
  detectMock: ReturnType<typeof vi.fn>;
  incidentCoordinator: IncidentCoordinator;
  playbookEngine: PlaybookEngine;
  runMock: ReturnType<typeof vi.fn>;
  rcaAnalyzeMock: ReturnType<typeof vi.fn>;
  engine: HealingEngine;
}

function makeContext(configOverrides: Partial<HealingEngineConfig> = {}): TestContext {
  const dataDir = `/tmp/vclaw-healing-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventBus = new EventBus();
  const toolRegistry = {
    execute: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getClusterState: vi.fn().mockResolvedValue(null),
    getAllTools: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistry;
  const healthMonitor = new HealthMonitor(toolRegistry, eventBus);
  const detectMock = vi.fn().mockReturnValue([]);
  const anomalyDetector = { detect: detectMock } as unknown as AnomalyDetector;
  const incidentCoordinator = new IncidentCoordinator(eventBus, dataDir);
  const playbookEngine = new PlaybookEngine(eventBus);
  const runMock = vi.fn().mockResolvedValue(makeRunResult(true));
  const agentCore = {
    run: runMock,
    aiConfig: { provider: "openai", apiKey: "test-key", model: "gpt-test" },
  } as unknown as AgentCore;
  const rcaAnalyzeMock = vi.fn().mockResolvedValue(undefined);
  const rcaAnalyzer = { analyze: rcaAnalyzeMock } as unknown as RCAAnalyzer;
  const engine = new HealingEngine(
    eventBus,
    healthMonitor,
    anomalyDetector,
    incidentCoordinator,
    {
      pollIntervalMs: configOverrides.pollIntervalMs ?? 100,
      healingEnabled: configOverrides.healingEnabled ?? true,
      maxConcurrentHeals: configOverrides.maxConcurrentHeals ?? 2,
    },
    {
      agentCore,
      playbookEngine,
      rcaAnalyzer,
    },
  );

  return {
    dataDir,
    eventBus,
    healthMonitor,
    detectMock,
    incidentCoordinator,
    playbookEngine,
    runMock,
    rcaAnalyzeMock,
    engine,
  };
}

describe("HealingEngine", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts and stops idempotently and guards timer tick failures", async () => {
    vi.useFakeTimers();
    const context = makeContext({ pollIntervalMs: 100 });
    tempDirs.push(context.dataDir);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const startSpy = vi.spyOn(context.healthMonitor, "start");
    const stopSpy = vi.spyOn(context.healthMonitor, "stop");
    const tickSpy = vi.spyOn(context.engine, "tick").mockRejectedValue(new Error("tick failed"));

    context.engine.start();
    context.engine.start();
    expect(startSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5200);

    expect(tickSpy).toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.some((call) => String(call[0]).includes("[healing] First tick failed:")),
    ).toBe(true);

    context.engine.stop();
    context.engine.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalled();
  });

  it("exposes active heal metadata via getStatus while a run is in flight", async () => {
    const context = makeContext();
    tempDirs.push(context.dataDir);
    context.playbookEngine.register(makePlaybook());

    let resolveRun: ((result: AgentRunResult) => void) | null = null;
    context.runMock.mockImplementationOnce(
      () =>
        new Promise<AgentRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );

    const summary = makeSummary();
    const anomaly = makeAnomaly();
    const pending = context.engine.handleAnomaly(anomaly, summary);
    await Promise.resolve();

    const status = context.engine.getStatus();
    expect(status.activeHeals).toHaveLength(1);
    expect(status.activeHeals[0].anomalyKey).toBe(anomalyKey(anomaly));
    expect(status.openIncidents).toHaveLength(1);

    resolveRun?.(makeRunResult(true));
    await pending;
  });

  it("escalates when anomaly repeats within escalation window", async () => {
    const context = makeContext();
    tempDirs.push(context.dataDir);

    const anomaly = makeAnomaly();
    const key = anomalyKey(anomaly);
    context.incidentCoordinator.recordEscalation(key);
    context.incidentCoordinator.recordEscalation(key);
    context.incidentCoordinator.recordEscalation(key);

    const summary = makeSummary();
    await context.engine.handleAnomaly(anomaly, summary);

    expect(context.runMock).not.toHaveBeenCalled();
    const escalations = context.eventBus
      .getHistory()
      .filter((event) => event.type === AgentEventType.HealingEscalated);
    expect(escalations).toHaveLength(1);
    expect(String(escalations[0].data.reason)).toContain("Anomaly triggered");
  });

  it("escalates playbooks that require approval", async () => {
    const context = makeContext();
    tempDirs.push(context.dataDir);
    context.playbookEngine.register(makePlaybook({ id: "pb-approval", requires_approval: true }));

    const summary = makeSummary();
    await context.engine.handleAnomaly(makeAnomaly(), summary);

    expect(context.runMock).not.toHaveBeenCalled();
    const escalation = context.eventBus
      .getHistory()
      .find((event) => event.type === AgentEventType.HealingEscalated);
    expect(escalation).toBeDefined();
    expect(escalation?.data.playbook_id).toBe("pb-approval");
  });

  it("skips execution when max concurrent heals limit is reached", async () => {
    const context = makeContext({ maxConcurrentHeals: 0 });
    tempDirs.push(context.dataDir);
    context.playbookEngine.register(makePlaybook());

    const summary = makeSummary();
    await context.engine.handleAnomaly(makeAnomaly(), summary);

    expect(context.runMock).not.toHaveBeenCalled();
    expect(context.incidentCoordinator.incidentManager.getOpen()).toHaveLength(1);
  });

  it("marks incident failed when run result is unsuccessful", async () => {
    const context = makeContext();
    tempDirs.push(context.dataDir);
    context.playbookEngine.register(makePlaybook());
    context.runMock.mockResolvedValueOnce(makeRunResult(false, ["step failed"]));

    const summary = makeSummary();
    await context.engine.handleAnomaly(makeAnomaly(), summary);

    expect(summary.healingsFailed).toBe(1);
    const recent = context.incidentCoordinator.incidentManager.getRecent(1)[0];
    expect(recent.status).toBe("failed");
    expect(recent.resolution).toContain("step failed");
  });

  it("handles rejected runs and trips circuit breaker after three failures", async () => {
    const context = makeContext();
    tempDirs.push(context.dataDir);
    context.playbookEngine.register(makePlaybook({ cooldown_minutes: 0 }));
    context.runMock.mockRejectedValue(new Error("runner crashed"));

    const summary = makeSummary();
    for (let i = 0; i < 3; i++) {
      await context.engine.handleAnomaly(
        makeAnomaly({
          id: `anomaly-${i + 1}`,
          labels: { node: "pve1", vmid: String(101 + i), name: `web-0${i + 1}` },
        }),
        summary,
      );
    }

    expect(summary.healingsFailed).toBe(3);
    const status = context.engine.getStatus();
    expect(status.circuitBreaker.paused).toBe(true);
    expect(status.circuitBreaker.consecutiveFailures).toBe(3);

    const pausedEvents = context.eventBus
      .getHistory()
      .filter((event) => event.type === AgentEventType.HealingPaused);
    expect(pausedEvents).toHaveLength(1);
  });

  it("logs RCA failures without blocking successful healing", async () => {
    const context = makeContext();
    tempDirs.push(context.dataDir);
    context.playbookEngine.register(makePlaybook());
    context.rcaAnalyzeMock.mockRejectedValueOnce(new Error("rca unavailable"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const summary = makeSummary();
    await context.engine.handleAnomaly(makeAnomaly(), summary);
    await Promise.resolve();

    expect(summary.healingsCompleted).toBe(1);
    expect(
      errorSpy.mock.calls.some((call) => String(call[0]).includes("RCA analysis failed for incident")),
    ).toBe(true);
  });

  it("wraps metric-store timestamps for detector query/getLatest", async () => {
    const context = makeContext();
    tempDirs.push(context.dataDir);

    context.healthMonitor.store.record("vm_status", 1, { node: "pve1", vmid: "101", name: "web-01" });
    context.detectMock.mockImplementationOnce((store) => {
      const points = store.query("vm_status", { node: "pve1", vmid: "101", name: "web-01" }, 30);
      expect(points).toHaveLength(1);
      expect(points[0].timestamp).toContain("T");

      const latest = store.getLatest("vm_status", { node: "pve1", vmid: "101", name: "web-01" });
      expect(latest).not.toBeNull();
      expect(latest?.timestamp).toContain("T");
      expect(store.getLatest("vm_status", { node: "missing" })).toBeNull();
      return [];
    });

    await context.engine.tick();
    const tickEvents = context.eventBus.getHistory().filter((event) => event.type === AgentEventType.HealingTick);
    expect(tickEvents).toHaveLength(1);
  });

  it("logs tick errors for both Error and non-Error throws", async () => {
    const context = makeContext();
    tempDirs.push(context.dataDir);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    context.detectMock.mockImplementationOnce(() => {
      throw new Error("detector exploded");
    });
    await context.engine.tick();

    context.detectMock.mockImplementationOnce(() => {
      throw "string failure";
    });
    await context.engine.tick();

    expect(
      errorSpy.mock.calls.some((call) => String(call[0]).includes("[healing] Tick error: detector exploded")),
    ).toBe(true);
    expect(
      errorSpy.mock.calls.some((call) => String(call[0]).includes("[healing] Tick error: string failure")),
    ).toBe(true);
  });
});
