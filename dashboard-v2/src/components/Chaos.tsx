import { useStore } from "../store";
import { useEffect, useState, useRef } from "react";
import {
  fetchChaosScenarios,
  fetchChaosStatus,
  fetchChaosHistory,
  simulateChaos,
  executeChaos,
} from "../api/client";
import type { ChaosScenario, ChaosSimulation, ChaosRun } from "../types";

const PHASES = ["Executing", "Recovering", "Verifying", "Complete"] as const;

function phaseIndex(status: ChaosRun["status"]): number {
  switch (status) {
    case "executing":
      return 0;
    case "recovering":
      return 1;
    case "verifying":
      return 2;
    case "completed":
      return 3;
    default:
      return -1;
  }
}

function riskClass(score: number): string {
  if (score <= 33) return "risk-low";
  if (score <= 66) return "risk-medium";
  return "risk-high";
}

function formatTimer(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export default function Chaos() {
  const cluster = useStore((s) => s.cluster);
  const events = useStore((s) => s.events);

  const [scenarios, setScenarios] = useState<ChaosScenario[]>([]);
  const [selectedScenario, setSelectedScenario] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("");
  const [simulation, setSimulation] = useState<ChaosSimulation | null>(null);
  const [activeRun, setActiveRun] = useState<ChaosRun | null>(null);
  const [history, setHistory] = useState<ChaosRun[]>([]);
  const [execStartTime, setExecStartTime] = useState<number | null>(null);
  const [execTimer, setExecTimer] = useState("00:00");
  const [logEntries, setLogEntries] = useState<{ time: string; msg: string }[]>([]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Load scenarios, status, history on mount
  useEffect(() => {
    fetchChaosScenarios()
      .then(setScenarios)
      .catch(() => {});
    fetchChaosStatus()
      .then((run) => {
        if (run) {
          setActiveRun(run);
          setExecStartTime(new Date(run.started_at).getTime());
        }
      })
      .catch(() => {});
    fetchChaosHistory()
      .then(setHistory)
      .catch(() => {});
  }, []);

  // Timer management
  useEffect(() => {
    if (execStartTime && activeRun && !["completed", "failed"].includes(activeRun.status)) {
      timerRef.current = setInterval(() => {
        setExecTimer(formatTimer(Date.now() - execStartTime));
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [execStartTime, activeRun]);

  // Handle chaos SSE events
  useEffect(() => {
    if (!events.length) return;
    const latest = events[events.length - 1];
    const ts = new Date(latest.timestamp).toLocaleTimeString();

    switch (latest.type) {
      case "chaos_started": {
        const sd = latest.data as Record<string, unknown>;
        setActiveRun((prev) => ({
          ...(prev || {} as ChaosRun),
          id: (sd.run_id as string) || prev?.id || "",
          status: "executing" as const,
          scenario: prev?.scenario || { id: sd.scenario_id as string, name: sd.scenario_id as string } as ChaosRun["scenario"],
          started_at: new Date().toISOString(),
        }) as ChaosRun);
        setExecStartTime(Date.now());
        setLogEntries((prev) => [...prev, { time: ts, msg: "Chaos scenario started" }]);
        break;
      }

      case "chaos_recovery_detected":
        setActiveRun((prev) =>
          prev ? { ...prev, status: "recovering" } : prev
        );
        setLogEntries((prev) => [
          ...prev,
          { time: ts, msg: (latest.data.message as string) || "Recovery detected" },
        ]);
        break;

      case "chaos_completed": {
        const d = latest.data as Record<string, unknown>;
        setActiveRun((prev) => prev ? { ...prev, status: "completed" as const, verdict: ((d.verdict as string) || "unknown") as ChaosRun["verdict"], resilience_score: (d.resilience_pct as number) ?? prev.resilience_score, actual_recovery_time_s: (d.actual_recovery_s as number) ?? prev.actual_recovery_time_s } : prev);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        setLogEntries((prev) => [
          ...prev,
          { time: ts, msg: `Chaos run completed — verdict: ${(d.verdict as string) || "unknown"}` },
        ]);
        // Refresh history from API instead of pushing incomplete SSE data
        fetchChaosHistory().then(setHistory).catch(() => {});
        break;
      }

      case "chaos_failed": {
        const d = latest.data as Record<string, unknown>;
        setActiveRun((prev) => prev ? { ...prev, status: "failed", error: (d.error as string) } : prev);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        setLogEntries((prev) => [
          ...prev,
          { time: ts, msg: `Chaos run failed: ${(latest.data.error as string) || "unknown error"}` },
        ]);
        break;
      }
    }
  }, [events]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logEntries]);

  const runningVMs = cluster?.vms?.filter((v) => v.status === "running") || [];

  const handleSimulate = async () => {
    if (!selectedScenario) return;
    try {
      const params: Record<string, unknown> = {};
      if (selectedTarget) params.vmid = selectedTarget;
      const sim = await simulateChaos(selectedScenario, params);
      setSimulation(sim);
    } catch {
      // handled silently
    }
  };

  const handleExecute = async () => {
    if (!simulation || !selectedScenario) return;
    const ok = window.confirm(
      "This will execute a destructive chaos scenario against your infrastructure. Continue?"
    );
    if (!ok) return;
    try {
      const params: Record<string, unknown> = {};
      if (selectedTarget) params.vmid = selectedTarget;
      const run = await executeChaos(selectedScenario, params);
      setActiveRun(run);
      setExecStartTime(Date.now());
      setLogEntries([{ time: new Date().toLocaleTimeString(), msg: "Execution initiated" }]);
    } catch {
      // handled silently
    }
  };

  const currentPhase = activeRun ? phaseIndex(activeRun.status) : -1;
  const isFailed = activeRun?.status === "failed";
  const isCompleted = activeRun?.status === "completed";

  return (
    <>
      {/* Main Chaos Card */}
      <div className="card">
        <div className="card-head">
          <span>Chaos Engineering</span>
          <span className="badge" style={{ background: "var(--red, #ef4444)", color: "#fff" }}>
            DESTRUCTIVE
          </span>
        </div>

        {/* Controls */}
        <div className="chaos-controls">
          <div className="chaos-field">
            <label>Scenario</label>
            <select
              value={selectedScenario}
              onChange={(e) => {
                setSelectedScenario(e.target.value);
                setSimulation(null);
              }}
            >
              <option value="">Select scenario...</option>
              {scenarios.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.name} ({sc.severity})
                </option>
              ))}
            </select>
          </div>

          <div className="chaos-field">
            <label>Target VM</label>
            <select value={selectedTarget} onChange={(e) => setSelectedTarget(e.target.value)}>
              <option value="">Auto-select</option>
              {runningVMs.map((vm) => (
                <option key={vm.id} value={vm.id}>
                  {vm.name}
                </option>
              ))}
            </select>
          </div>

          <button
            className="btn-simulate"
            disabled={!selectedScenario}
            onClick={handleSimulate}
          >
            Simulate
          </button>

          <button
            className="btn-execute-chaos"
            disabled={!simulation}
            onClick={handleExecute}
          >
            Execute
          </button>
        </div>

        {/* Simulation Results */}
        <div className={`chaos-sim-results${simulation ? " visible" : ""}`}>
          <div className="chaos-sim-title">Blast Radius Simulation</div>

          <div className="chaos-blast-list">
            {simulation?.affected_vms?.map((vm) => (
              <div key={vm.vmid} className="chaos-blast-item">
                <span className="dot" />
                <span>{vm.name}</span>
                <span>{vm.impact}</span>
              </div>
            ))}
          </div>

          <div className="chaos-sim-stats">
            <div>
              <strong>{simulation?.affected_vms?.length || 0}</strong>
              <span>Affected</span>
            </div>
            <div>
              <strong>{simulation?.predicted_recovery_time_s || 0}s</strong>
              <span>Recovery Time</span>
            </div>
            <div>
              <strong className={simulation ? riskClass(simulation.risk_score) : ""}>
                {simulation?.risk_score ?? 0}
              </strong>
              <span>Risk Score</span>
            </div>
          </div>

          <div className="chaos-sim-recommendation">
            {simulation?.recommendation}
          </div>
        </div>

        {/* Live Execution */}
        <div className={`chaos-execution${activeRun ? " visible" : ""}`}>
          <div className="chaos-exec-header">
            <span className={`chaos-exec-status-badge ${activeRun?.status || ""}`}>
              {activeRun?.status || ""}
            </span>
            <span className="chaos-exec-timer">{execTimer}</span>
          </div>

          <div className="chaos-exec-phases">
            {PHASES.map((phase, i) => {
              let cls = "chaos-phase";
              if (isFailed && i === currentPhase) cls += " failed";
              else if (i < currentPhase) cls += " done";
              else if (i === currentPhase) cls += " active";
              return (
                <div key={phase} className={cls}>
                  {phase}
                </div>
              );
            })}
          </div>

          <div className="chaos-exec-log">
            {logEntries.map((entry, i) => (
              <div key={i} className="chaos-log-entry">
                <span className="chaos-log-time">{entry.time}</span>
                <span>{entry.msg}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* Results */}
        <div className={`chaos-results${isCompleted ? " visible" : ""}`}>
          <div className="chaos-verdict">
            <span>VERDICT</span>
            <span className={`chaos-verdict-value ${activeRun?.verdict || ""}`}>
              {activeRun?.verdict?.toUpperCase() || ""}
            </span>
          </div>

          <div className="chaos-resilience-score">
            <span className="chaos-resilience-number">
              {activeRun?.resilience_score ?? 0}%
            </span>
            <span>Resilience Score</span>
          </div>

          <div className="chaos-comparison">
            <div>
              <strong>Predicted Recovery</strong>
              <span>{activeRun?.blast_radius?.predicted_recovery_time_s ?? "—"}s</span>
            </div>
            <div>
              <strong>Actual Recovery</strong>
              <span>{activeRun?.actual_recovery_time_s ?? "—"}s</span>
            </div>
          </div>
        </div>
      </div>

      {/* Past Chaos Runs */}
      <div className="card">
        <div className="card-head">
          <span>Past Chaos Runs</span>
          <span className="badge">{history.length}</span>
        </div>

        {history.length === 0 ? (
          <div className="empty-state">No chaos runs yet</div>
        ) : (
          history.map((run) => (
            <div key={run.id} className="chaos-history-item">
              <span>{run.scenario?.name || (run as unknown as Record<string, unknown>).scenario_id as string || "Unknown"}</span>
              <span className={`chaos-verdict-value ${run.verdict || ""}`}>
                {run.verdict?.toUpperCase() || run.status}
              </span>
              <span>{new Date(run.started_at).toLocaleString()}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
