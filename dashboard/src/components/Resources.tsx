import { useEffect, useState } from "react";
import { useStore } from "../store";
import { fetchPredictions, fetchRightsizing } from "../api/client";
import type { Prediction, RightsizingRec } from "../types";
import MetricChart from "./MetricChart";

function formatMetric(metric: string): string {
  return metric
    .replace(/_pct$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function gaugeColor(pct: number): string {
  if (pct >= 80) return "var(--red)";
  if (pct >= 60) return "var(--amber)";
  return "var(--green)";
}

function statusText(prediction: Prediction): string {
  if (prediction.status === "critical") return "Critical - immediate attention needed";
  if (prediction.status === "warning") return "Warning - approaching threshold";
  if (prediction.slope_per_hour < 0.1) return "Healthy - stable trend";
  return "Healthy - slow growth, >48h to threshold";
}

const CIRC = 2 * Math.PI * 52; // ~326.7

export default function Resources() {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [recommendations, setRecommendations] = useState<RightsizingRec[]>([]);
  const lastHealth = useStore((s) => s.lastHealth);
  const cluster = useStore((s) => s.cluster);
  const healthHistory = useStore((s) => s.healthHistory);

  useEffect(() => {
    const load = () => {
      fetchPredictions()
        .then((d) => setPredictions(d.predictions))
        .catch(() => {});
      fetchRightsizing()
        .then((d) => setRecommendations(d.recommendations))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // Derive resource stats from lastHealth or fall back to cluster node data
  const res = lastHealth?.resources;
  const nodes = cluster?.nodes ?? [];
  const firstNode = nodes[0];

  const cpuPct = res?.cpu_usage_pct ?? firstNode?.cpu_usage_pct ?? 0;
  const ramPct = res?.ram_usage_pct ?? (firstNode ? (firstNode.ram_used_mb / firstNode.ram_total_mb) * 100 : 0);
  const diskPct = res?.disk_usage_pct ?? firstNode?.disk_usage_pct ?? 0;

  const ramUsedGB = (res?.ram_used_mb ?? firstNode?.ram_used_mb ?? 0) / 1024;
  const ramTotalGB = (res?.ram_total_mb ?? firstNode?.ram_total_mb ?? 0) / 1024;
  const diskUsedGB = res?.disk_used_gb ?? firstNode?.disk_used_gb ?? 0;
  const diskTotalGB = res?.disk_total_gb ?? firstNode?.disk_total_gb ?? 0;
  const cpuCores = res?.cpu_cores ?? firstNode?.cpu_cores ?? 0;

  const sigOver = recommendations.filter((r) => r.savings_pct > 50).length;
  const slightOver = recommendations.filter((r) => r.savings_pct > 20 && r.savings_pct <= 50).length;
  const minor = recommendations.filter((r) => r.savings_pct <= 20).length;

  return (
    <>
      {/* Section 1: Predictive Forecasting */}
      <div className="card">
        <div className="card-head">
          <h3>Predictive Forecasting</h3>
          <span className="card-badge">BETA</span>
        </div>
        <div className="card-body">
          {predictions.length === 0 ? (
            <p className="empty-state">No predictions available</p>
          ) : (
            <div className="predictions-grid">
              {predictions.map((p, i) => (
                <div key={i} className={`prediction-card status-${p.status}`}>
                  <div className="prediction-header">
                    <span className="prediction-metric">{formatMetric(p.metric)}</span>
                    <span className="prediction-node">{p.labels.node ?? ""}</span>
                  </div>

                  <div className="prediction-value-row">
                    <span className="prediction-current">{p.current.toFixed(1)}%</span>
                    <span
                      className="prediction-trend"
                      style={{
                        color:
                          p.slope_per_hour > 0.1
                            ? "red"
                            : p.slope_per_hour < -0.1
                            ? "green"
                            : "gray",
                      }}
                    >
                      {p.slope_per_hour > 0.1 ? "↑" : p.slope_per_hour < -0.1 ? "↓" : "→"}
                    </span>
                    <span className="prediction-slope">
                      {p.slope_per_hour >= 0 ? "+" : ""}
                      {p.slope_per_hour.toFixed(2)}%/hr
                    </span>
                  </div>

                  <div className="prediction-bar-container">
                    <div
                      className={`prediction-bar-current ${p.status}`}
                      style={{ width: `${Math.min(p.current, 100)}%` }}
                    />
                    <div
                      className={`prediction-bar-projected ${p.status}`}
                      style={{ width: `${Math.min(p.projected_24h, 100)}%` }}
                    />
                    <div className="prediction-bar-threshold" style={{ left: "90%" }} />
                  </div>

                  <div className="prediction-countdown">
                    {p.hours_to_critical != null ? (
                      <span className={`time-value ${p.status}`}>Time to critical: {Math.round(p.hours_to_critical)}h</span>
                    ) : (
                      <span>Healthy</span>
                    )}
                  </div>

                  <div className={`prediction-status-text ${p.status}`}>{statusText(p)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Section 2: VM Right-Sizing */}
      <div className="card">
        <div className="card-head">
          <h3>VM Right-Sizing</h3>
          <span className="card-badge">{recommendations.length} VMs</span>
        </div>
        <div className="card-body">
          {recommendations.length === 0 ? (
            <p className="empty-state">No right-sizing recommendations</p>
          ) : (
            <>
              <div className="rightsizing-summary">
                <span className="pill red">{sigOver} significantly over</span>
                <span className="pill amber">{slightOver} slightly over</span>
                <span className="pill green">{minor} minor</span>
              </div>

              <div className="rightsizing-grid">
                {recommendations.map((r) => {
                  const severity =
                    r.savings_pct > 50
                      ? "severity-red"
                      : r.savings_pct > 20
                      ? "severity-amber"
                      : "severity-green";
                  const cpuRecPos = Math.min((r.cpu_recommended / r.cpu_allocated) * 100, 100);
                  const ramRecPos = Math.min((r.ram_recommended_mb / r.ram_allocated_mb) * 100, 100);

                  // Color logic: red if very low usage (overprovisioned), amber if medium, teal if well-utilized
                  const cpuBarColor = r.cpu_avg_pct < 20 ? "var(--red)" : r.cpu_avg_pct < 40 ? "var(--amber)" : "var(--teal)";
                  const ramBarColor = r.ram_avg_pct < 30 ? "var(--red)" : r.ram_avg_pct < 50 ? "var(--amber)" : "var(--teal)";

                  const ramAllocStr = r.ram_allocated_mb >= 1024
                    ? `${(r.ram_allocated_mb / 1024).toFixed(1)} GB`
                    : `${Math.round(r.ram_allocated_mb)} MB`;
                  const ramRecStr = r.ram_recommended_mb >= 1024
                    ? `${(r.ram_recommended_mb / 1024).toFixed(1)} GB`
                    : `${Math.round(r.ram_recommended_mb)} MB`;

                  return (
                    <div key={r.vmid} className={`rightsizing-card ${severity}`}>
                      <div className="rightsizing-header">
                        <span className="rightsizing-vm-name">{r.name}</span>
                        <span className="rightsizing-vm-meta">
                          VMID {r.vmid} · {r.node}
                        </span>
                        <span className={`rightsizing-savings ${severity.replace("severity-", "")}`}>
                          {Math.round(r.savings_pct)}% savings
                        </span>
                      </div>

                      <div className="rightsizing-resource">
                        <span className="rightsizing-resource-label">CPU</span>
                        <div className="rightsizing-bar-container">
                          <div
                            className="rightsizing-bar-used"
                            style={{ width: `${Math.min(r.cpu_avg_pct, 100)}%`, background: cpuBarColor, opacity: 0.7 }}
                          />
                          <div
                            className="rightsizing-bar-used"
                            style={{ width: `${Math.min(r.cpu_peak_pct, 100)}%`, background: cpuBarColor, opacity: 0.25 }}
                          />
                          <div
                            className="rightsizing-bar-recommended"
                            style={{ left: `${cpuRecPos}%` }}
                          />
                        </div>
                        <div className="rightsizing-resource-detail">
                          {r.cpu_allocated} cores → <span className="rec">{r.cpu_recommended}</span>
                        </div>
                      </div>

                      <div className="rightsizing-resource">
                        <span className="rightsizing-resource-label">RAM</span>
                        <div className="rightsizing-bar-container">
                          <div
                            className="rightsizing-bar-used"
                            style={{ width: `${Math.min(r.ram_avg_pct, 100)}%`, background: ramBarColor, opacity: 0.7 }}
                          />
                          <div
                            className="rightsizing-bar-used"
                            style={{ width: `${Math.min(r.ram_peak_pct, 100)}%`, background: ramBarColor, opacity: 0.25 }}
                          />
                          <div
                            className="rightsizing-bar-recommended"
                            style={{ left: `${ramRecPos}%` }}
                          />
                        </div>
                        <div className="rightsizing-resource-detail">
                          {ramAllocStr} → <span className="rec">{ramRecStr}</span>
                        </div>
                      </div>

                      <div className="rightsizing-stats">
                        <span className="rightsizing-stat">CPU avg <span>{r.cpu_avg_pct.toFixed(0)}%</span> peak <span>{r.cpu_peak_pct.toFixed(0)}%</span></span>
                        <span className="rightsizing-stat">RAM avg <span>{r.ram_avg_pct.toFixed(0)}%</span> peak <span>{r.ram_peak_pct.toFixed(0)}%</span></span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Section 3: Cluster Resources */}
      <div className="card">
        <div className="card-head">
          <h3>Cluster Resources</h3>
          <span className="card-badge">
            {lastHealth ? new Date(lastHealth.timestamp).toLocaleTimeString() : "--"}
          </span>
        </div>
        <div className="card-body">
          <div className="resource-gauges">
            {/* CPU Gauge */}
            <div className="gauge-card">
              <div className="gauge-svg">
                <svg viewBox="0 0 120 120">
                  <circle
                    className="gauge-track"
                    cx={60}
                    cy={60}
                    r={52}
                  />
                  <circle
                    className="gauge-fill"
                    cx={60}
                    cy={60}
                    r={52}
                    stroke={gaugeColor(cpuPct)}
                    strokeDasharray={`${(cpuPct / 100) * CIRC} ${CIRC}`}
                  />
                </svg>
                <div className="gauge-pct">
                  {cpuPct.toFixed(0)}<span className="gauge-pct-unit">%</span>
                </div>
              </div>
              <div className="gauge-label">CPU</div>
              <div className="gauge-detail">{cpuCores} cores</div>
            </div>

            {/* RAM Gauge */}
            <div className="gauge-card">
              <div className="gauge-svg">
                <svg viewBox="0 0 120 120">
                  <circle
                    className="gauge-track"
                    cx={60}
                    cy={60}
                    r={52}
                  />
                  <circle
                    className="gauge-fill"
                    cx={60}
                    cy={60}
                    r={52}
                    stroke={gaugeColor(ramPct)}
                    strokeDasharray={`${(ramPct / 100) * CIRC} ${CIRC}`}
                  />
                </svg>
                <div className="gauge-pct">
                  {ramPct.toFixed(0)}<span className="gauge-pct-unit">%</span>
                </div>
              </div>
              <div className="gauge-label">RAM</div>
              <div className="gauge-detail">
                {ramUsedGB.toFixed(1)} / {ramTotalGB.toFixed(1)} GB
              </div>
            </div>

            {/* Disk Gauge */}
            <div className="gauge-card">
              <div className="gauge-svg">
                <svg viewBox="0 0 120 120">
                  <circle
                    className="gauge-track"
                    cx={60}
                    cy={60}
                    r={52}
                  />
                  <circle
                    className="gauge-fill"
                    cx={60}
                    cy={60}
                    r={52}
                    stroke={gaugeColor(diskPct)}
                    strokeDasharray={`${(diskPct / 100) * CIRC} ${CIRC}`}
                  />
                </svg>
                <div className="gauge-pct">
                  {diskPct.toFixed(0)}<span className="gauge-pct-unit">%</span>
                </div>
              </div>
              <div className="gauge-label">Disk</div>
              <div className="gauge-detail">
                {diskUsedGB.toFixed(1)} / {diskTotalGB.toFixed(1)} GB
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Section 4: Metric History Charts */}
      {nodes.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Metric History</h3>
            <span className="card-badge">{nodes.length} nodes</span>
          </div>
          <div className="card-body">
            {nodes.map((n) => (
              <div key={n.name} className="metric-history-node">
                <h4 className="metric-history-node-title">{n.name}</h4>
                <div className="metric-history-grid">
                  <MetricChart
                    node={n.name}
                    metric="node_cpu_pct"
                    label="CPU History"
                  />
                  <MetricChart
                    node={n.name}
                    metric="node_mem_pct"
                    label="RAM History"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
