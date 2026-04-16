import { useStore } from "../store";
import { useEffect, useState, useRef } from "react";
import {
  fetchMigrationVMs,
  planMigration,
  executeMigration,
  fetchMigrationHistory,
} from "../api/client";
import type { MigrationVM, MigrationPlan, MigrationDirection } from "../types";

const DIRECTIONS: { id: MigrationDirection; label: string; from: string; to: string }[] = [
  { id: "vmware_to_proxmox", label: "VMware \u2192 Proxmox", from: "vmware", to: "proxmox" },
  { id: "proxmox_to_vmware", label: "Proxmox \u2192 VMware", from: "proxmox", to: "vmware" },
  { id: "vmware_to_aws", label: "VMware \u2192 AWS", from: "vmware", to: "aws" },
  { id: "aws_to_vmware", label: "AWS \u2192 VMware", from: "aws", to: "vmware" },
  { id: "proxmox_to_aws", label: "Proxmox \u2192 AWS", from: "proxmox", to: "aws" },
  { id: "aws_to_proxmox", label: "AWS \u2192 Proxmox", from: "aws", to: "proxmox" },
];

const STEP_LABELS: Record<string, string> = {
  export_config: "Export Config",
  power_off: "Power Off VM",
  transfer_disk: "Transfer Disk",
  convert_disk: "Convert Disk",
  resolve_target: "Resolve Target",
  import_vm: "Import VM",
  create_vm: "Create VM",
  cleanup: "Cleanup",
  // AWS steps
  upload_to_s3: "Upload to S3",
  import_ami: "Import as AMI",
  launch_instance: "Launch EC2 Instance",
  create_ami: "Create AMI",
  export_to_s3: "Export to S3",
  download_disk: "Download Disk",
  stage_setup: "Setup Staging",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "--";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const sec = Math.floor((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export default function Migrations() {
  const activeMigration = useStore((s) => s.activeMigration);
  const setActiveMigration = useStore((s) => s.setActiveMigration);
  const completeMigration = useStore((s) => s.completeMigration);
  const migrationHistory = useStore((s) => s.migrationHistory);
  const setMigrationHistory = useStore((s) => s.setMigrationHistory);
  const events = useStore((s) => s.events);

  const [direction, setDirection] = useState<MigrationDirection>("vmware_to_proxmox");
  const [vms, setVMs] = useState<MigrationVM[]>([]);
  const [selectedVM, setSelectedVM] = useState("");
  const [plan, setPlan] = useState<(MigrationPlan & { analysis?: any }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executionTimer, setExecutionTimer] = useState("00:00");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [logEntries, setLogEntries] = useState<{ time: string; msg: string }[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const dirEntry = DIRECTIONS.find((d) => d.id === direction)!;
  const sourceProvider = dirEntry.from as "vmware" | "proxmox" | "aws";
  const targetProvider = dirEntry.to as "vmware" | "proxmox" | "aws";

  // Load VMs for selected direction
  useEffect(() => {
    setVMs([]);
    setSelectedVM("");
    setPlan(null);
    setError(null);
    fetchMigrationVMs(sourceProvider)
      .then((res) => setVMs(res.vms || []))
      .catch(() => setError("Failed to load VMs"));
  }, [sourceProvider]);

  // Load migration history on mount
  useEffect(() => {
    fetchMigrationHistory()
      .then((res) => setMigrationHistory(res.migrations || []))
      .catch(() => {});
  }, [setMigrationHistory]);

  // Timer for active migration
  useEffect(() => {
    if (activeMigration && !["completed", "failed"].includes(activeMigration.status)) {
      const startTime = activeMigration.startedAt
        ? new Date(activeMigration.startedAt).getTime()
        : Date.now();
      timerRef.current = setInterval(() => {
        const sec = Math.floor((Date.now() - startTime) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        setExecutionTimer(`${m}:${s}`);
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
  }, [activeMigration]);

  // Handle migration SSE events
  useEffect(() => {
    if (!events.length) return;
    const latest = events[events.length - 1];
    const ts = new Date(latest.timestamp).toLocaleTimeString();
    const d = latest.data as Record<string, unknown>;

    switch (latest.type) {
      case "migration_started":
        setLogEntries((prev) => [...prev, { time: ts, msg: `Migration started: ${d.vm_name || d.vm_id}` }]);
        break;
      case "migration_step":
        setLogEntries((prev) => [...prev, { time: ts, msg: `${d.step}: ${d.detail || d.status}` }]);
        break;
      case "migration_completed": {
        setLogEntries((prev) => [...prev, { time: ts, msg: "Migration completed successfully" }]);
        if (activeMigration) {
          const completed = { ...activeMigration, status: "completed" as const, completedAt: new Date().toISOString() };
          completeMigration(completed);
        }
        break;
      }
      case "migration_failed":
        setLogEntries((prev) => [...prev, { time: ts, msg: `Migration failed: ${d.error || "unknown"}` }]);
        break;
    }
  }, [events, activeMigration, completeMigration]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logEntries]);

  const handlePlan = async () => {
    if (!selectedVM) return;
    setLoading(true);
    setError(null);
    try {
      const result = await planMigration(direction, selectedVM);
      setPlan(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create migration plan");
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!selectedVM || !plan) return;
    const ok = window.confirm(
      `This will migrate "${plan.vmConfig?.name || selectedVM}" from ${sourceProvider.toUpperCase()} to ${targetProvider.toUpperCase()}. The source VM will be powered off. Continue?`
    );
    if (!ok) return;

    setLoading(true);
    setError(null);
    setLogEntries([{ time: new Date().toLocaleTimeString(), msg: "Starting migration..." }]);

    try {
      const result = await executeMigration(direction, selectedVM);
      setActiveMigration(result);
      if (result.status === "completed") {
        completeMigration(result);
        setLogEntries((prev) => [...prev, { time: new Date().toLocaleTimeString(), msg: "Migration completed" }]);
      } else if (result.status === "failed") {
        setError(result.error || "Migration failed");
        setLogEntries((prev) => [...prev, { time: new Date().toLocaleTimeString(), msg: `Failed: ${result.error}` }]);
      }
      setPlan(null);
      setSelectedVM("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Migration failed");
    } finally {
      setLoading(false);
    }
  };

  const isRunning = activeMigration && !["completed", "failed"].includes(activeMigration.status);

  return (
    <>
      {/* Main Migration Card */}
      <div className="card">
        <div className="card-head">
          <span>Cross-Provider Migration</span>
          <span className="badge" style={{ background: "var(--teal)", color: "#000" }}>
            BIDIRECTIONAL
          </span>
        </div>

        {/* Direction + VM Selector */}
        <div className="mig-controls">
          <div className="mig-field">
            <label>Direction</label>
            <select
              value={direction}
              onChange={(e) => {
                setDirection(e.target.value as MigrationDirection);
                setPlan(null);
              }}
              disabled={!!isRunning}
            >
              {DIRECTIONS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mig-field">
            <label>Source VM</label>
            <select
              value={selectedVM}
              onChange={(e) => {
                setSelectedVM(e.target.value);
                setPlan(null);
              }}
              disabled={!!isRunning}
            >
              <option value="">Select VM...</option>
              {vms.map((vm) => (
                <option key={vm.id} value={vm.id}>
                  {vm.name} ({vm.cpu} CPU, {vm.memoryMiB} MiB, {vm.diskGB} GB)
                </option>
              ))}
            </select>
          </div>

          <button
            className="btn-mig-plan"
            disabled={!selectedVM || loading || !!isRunning}
            onClick={handlePlan}
          >
            {loading && !plan ? "Planning..." : "Plan"}
          </button>

          <button
            className="btn-mig-execute"
            disabled={!plan || loading || !!isRunning}
            onClick={handleExecute}
          >
            {loading && plan ? "Migrating..." : "Migrate"}
          </button>
        </div>

        {error && (
          <div className="mig-error">{error}</div>
        )}

        {/* Plan Preview */}
        {plan && (
          <div className="mig-plan-preview">
            <div className="mig-plan-title">Migration Plan</div>

            <div className="mig-plan-summary">
              <div className="mig-plan-row">
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">VM</span>
                  <span className="mig-plan-value">{plan.vmConfig?.name || plan.source?.vmName || selectedVM}</span>
                </div>
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">CPU</span>
                  <span className="mig-plan-value">{plan.vmConfig?.cpuCount || "?"} cores</span>
                </div>
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">RAM</span>
                  <span className="mig-plan-value">{plan.vmConfig?.memoryMiB || "?"} MiB</span>
                </div>
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">Disks</span>
                  <span className="mig-plan-value">
                    {plan.vmConfig?.disks?.length || 0}
                    {plan.vmConfig?.disks?.[0] && ` (${formatBytes(plan.vmConfig.disks[0].capacityBytes)})`}
                  </span>
                </div>
                <div className="mig-plan-cell">
                  <span className="mig-plan-label">Firmware</span>
                  <span className="mig-plan-value">{plan.vmConfig?.firmware?.toUpperCase() || "BIOS"}</span>
                </div>
              </div>
            </div>

            <div className="mig-plan-steps">
              <span className="mig-plan-label">Steps</span>
              <div className="mig-step-list">
                {plan.steps?.map((step, i) => (
                  <div key={step.name} className="mig-step-chip">
                    <span className="mig-step-num">{i + 1}</span>
                    {STEP_LABELS[step.name] || step.name}
                  </div>
                ))}
              </div>
            </div>

            <div className="mig-plan-route">
              <div className="mig-route-node">
                <span className="mig-route-provider">{plan.source?.provider?.toUpperCase()}</span>
                <span className="mig-route-detail">{plan.source?.vmName || selectedVM}</span>
              </div>
              <div className="mig-route-arrow">
                <svg width="32" height="16" viewBox="0 0 32 16">
                  <line x1="0" y1="8" x2="26" y2="8" stroke="var(--teal)" strokeWidth="2" />
                  <polygon points="26,3 32,8 26,13" fill="var(--teal)" />
                </svg>
              </div>
              <div className="mig-route-node">
                <span className="mig-route-provider">{plan.target?.provider?.toUpperCase()}</span>
                <span className="mig-route-detail">
                  {plan.target?.instanceType || plan.target?.storage || plan.target?.node}
                </span>
              </div>
            </div>

            {/* AWS Workload Analysis */}
            {plan.analysis && (
              <div className="mig-analysis">
                <div className="mig-plan-title" style={{ marginTop: 16 }}>Workload Analysis</div>
                <div className="mig-plan-summary">
                  <div className="mig-plan-row">
                    {plan.analysis.target?.recommended?.instanceType && (
                      <div className="mig-plan-cell">
                        <span className="mig-plan-label">EC2 Type</span>
                        <span className="mig-plan-value" style={{ color: "#FF9900" }}>
                          {plan.analysis.target.recommended.instanceType}
                        </span>
                      </div>
                    )}
                    {plan.analysis.costEstimate && (
                      <div className="mig-plan-cell">
                        <span className="mig-plan-label">Est. Cost</span>
                        <span className="mig-plan-value" style={{ color: "var(--teal)" }}>
                          ${plan.analysis.costEstimate.monthlyUSD?.toFixed(2)}/mo
                        </span>
                      </div>
                    )}
                    {plan.analysis.storage && (
                      <div className="mig-plan-cell">
                        <span className="mig-plan-label">Storage</span>
                        <span className="mig-plan-value">
                          {plan.analysis.storage.estimatedTargetGB?.toFixed(1)} GB EBS
                        </span>
                      </div>
                    )}
                    {plan.analysis.migrationTimeEstimateMinutes != null && (
                      <div className="mig-plan-cell">
                        <span className="mig-plan-label">Est. Time</span>
                        <span className="mig-plan-value">
                          ~{plan.analysis.migrationTimeEstimateMinutes} min
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                {plan.analysis.risks?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <span className="mig-plan-label">Risks</span>
                    <div style={{ marginTop: 4 }}>
                      {plan.analysis.risks.map((risk: string, i: number) => (
                        <div key={i} style={{ fontSize: 12, color: "#f59e0b", padding: "2px 0" }}>
                          ⚠ {risk}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {plan.analysis.target?.alternatives?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <span className="mig-plan-label">Alternatives</span>
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      {plan.analysis.target.alternatives.map((alt: any, i: number) => (
                        <span key={i} className="mig-step-chip" style={{ fontSize: 11 }}>
                          {alt.instanceType} (${alt.estimatedMonthlyCost?.toFixed(0)}/mo)
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Active Migration Execution */}
        {(activeMigration || logEntries.length > 0) && (
          <div className="mig-execution">
            <div className="mig-exec-header">
              <span className={`mig-exec-status ${activeMigration?.status || "completed"}`}>
                {activeMigration?.status?.toUpperCase() || "COMPLETED"}
              </span>
              {isRunning && <span className="mig-exec-timer">{executionTimer}</span>}
            </div>

            {activeMigration?.steps && (
              <div className="mig-exec-steps">
                {activeMigration.steps.map((step) => (
                  <div
                    key={step.name}
                    className={`mig-exec-step ${step.status}`}
                  >
                    <span className="mig-exec-step-icon">
                      {step.status === "completed" ? "\u2713" : step.status === "failed" ? "\u2717" : step.status === "pending" ? "\u25CB" : "\u25CF"}
                    </span>
                    <span>{STEP_LABELS[step.name] || step.name}</span>
                    {step.detail && <span className="mig-exec-step-detail">{step.detail}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="mig-exec-log">
              {logEntries.map((entry, i) => (
                <div key={i} className="mig-log-entry">
                  <span className="mig-log-time">{entry.time}</span>
                  <span>{entry.msg}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Migration History */}
      <div className="card">
        <div className="card-head">
          <span>Migration History</span>
          <span className="badge">{migrationHistory.length}</span>
        </div>

        {migrationHistory.length === 0 ? (
          <div className="empty-state">No migrations yet</div>
        ) : (
          <div className="mig-history">
            {migrationHistory.map((m) => (
              <div key={m.id} className="mig-history-item">
                <div className="mig-history-main">
                  <span className="mig-history-name">{m.vmConfig?.name || m.source?.vmName || "Unknown"}</span>
                  <span className={`mig-history-status ${m.status}`}>
                    {m.status === "completed" ? "SUCCESS" : m.status.toUpperCase()}
                  </span>
                </div>
                <div className="mig-history-detail">
                  <span>{m.source?.provider?.toUpperCase()} -&gt; {m.target?.provider?.toUpperCase()}</span>
                  <span>{m.startedAt ? new Date(m.startedAt).toLocaleString() : "--"}</span>
                  <span>{formatDuration(m.startedAt, m.completedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
