import { useStore } from "../store";
import { Sparkline, metricColor } from "./Sparkline";

export function Header() {
  const connected = useStore((s) => s.connected);
  const mode = useStore((s) => s.mode);
  const cluster = useStore((s) => s.cluster);
  const lastHealth = useStore((s) => s.lastHealth);

  const nodesTotal = lastHealth?.nodes?.total ?? cluster?.nodes?.length ?? 0;
  const nodesOnline = lastHealth?.nodes?.online ?? cluster?.nodes?.length ?? 0;
  const vmCount = cluster?.vms?.length ?? 0;
  const containerCount = cluster?.containers?.length ?? 0;
  const runningVms =
    lastHealth?.vms?.running ??
    cluster?.vms?.filter((v) => v.status === "running")?.length ??
    0;
  const metricHistory = useStore((s) => s.metricHistory);
  const firstNode = cluster?.nodes?.[0];
  const avgCpu = lastHealth?.resources?.cpu_usage_pct ?? firstNode?.cpu_usage_pct ?? 0;
  const avgRam = lastHealth?.resources?.ram_usage_pct ??
    (firstNode ? (firstNode.ram_used_mb / firstNode.ram_total_mb) * 100 : 0);

  return (
    <>
      <header className="header">
        <div className="logo">
          <img src="/vclaw-logo.png" alt="vClaw" width="30" height="30" />
          <span style={{marginLeft: 2}}>v<span className="brand-accent">Claw</span></span>
        </div>

        <div className="header-right">
          <button className="cmd-k-trigger">
            Ask vClaw
            <span className="cmd-palette-kbd">⌘K</span>
          </button>

          <div className="conn-status">
            <span className={`conn-dot${connected ? " live" : ""}`} />
            {connected ? "Live" : "Reconnecting..."}
          </div>

          <span className={`mode-pill ${mode}`}>
            {mode.toUpperCase()}
          </span>
        </div>
      </header>

      <div className="stat-row">
        <div className="stat-cell">
          <span className="stat-label">NODES</span>
          <span className="stat-value">
            {nodesTotal} / {nodesOnline}
          </span>
        </div>
        <div className="stat-cell">
          <span className="stat-label">VMS</span>
          <span className="stat-value">{vmCount}</span>
        </div>
        <div className="stat-cell">
          <span className="stat-label">CONTAINERS</span>
          <span className="stat-value">{containerCount}</span>
        </div>
        <div className="stat-cell">
          <span className="stat-label">RUNNING</span>
          <span className="stat-value">{runningVms}</span>
        </div>
        <div className="stat-cell">
          <span className="stat-label">AVG CPU</span>
          <span className="stat-value stat-value-with-spark">
            {avgCpu.toFixed(1)}%
            <Sparkline data={metricHistory.cpu} color={metricColor(avgCpu)} />
          </span>
        </div>
        <div className="stat-cell">
          <span className="stat-label">AVG RAM</span>
          <span className="stat-value stat-value-with-spark">
            {avgRam.toFixed(1)}%
            <Sparkline data={metricHistory.ram} color={metricColor(avgRam)} />
          </span>
        </div>
      </div>
    </>
  );
}

export default Header;
