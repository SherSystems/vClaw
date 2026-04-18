import { useEffect, useState, useRef, useCallback } from "react";
import { fetchMetricHistory } from "../api/client";

interface MetricPoint {
  timestamp: number;
  value: number;
}

interface MetricChartProps {
  node: string;
  metric: string;
  label: string;
}

const RANGES = ["1h", "6h", "24h", "7d"] as const;
type Range = (typeof RANGES)[number];

function formatTime(ts: number, range: Range): string {
  const d = new Date(ts);
  if (range === "7d") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  if (range === "24h") {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function MetricChart({ node, metric, label }: MetricChartProps) {
  const [range, setRange] = useState<Range>("1h");
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    value: number;
    time: string;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchMetricHistory(node, metric, range)
      .then((d) => setPoints(d.points))
      .catch(() => setPoints([]))
      .finally(() => setLoading(false));
  }, [node, metric, range]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Chart dimensions
  const W = 600;
  const H = 200;
  const PAD_L = 40;
  const PAD_R = 10;
  const PAD_T = 10;
  const PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  // Scale helpers
  const minTs = points.length > 0 ? points[0].timestamp : 0;
  const maxTs = points.length > 0 ? points[points.length - 1].timestamp : 1;
  const tsSpan = maxTs - minTs || 1;

  const scaleX = (ts: number) => PAD_L + ((ts - minTs) / tsSpan) * chartW;
  const scaleY = (v: number) => PAD_T + chartH - (Math.min(v, 100) / 100) * chartH;

  // Build path
  const linePath =
    points.length > 1
      ? points
          .map((p, i) => `${i === 0 ? "M" : "L"}${scaleX(p.timestamp).toFixed(1)},${scaleY(p.value).toFixed(1)}`)
          .join(" ")
      : "";

  // Gradient fill path (close at bottom)
  const fillPath =
    points.length > 1
      ? `${linePath} L${scaleX(points[points.length - 1].timestamp).toFixed(1)},${(PAD_T + chartH).toFixed(1)} L${PAD_L},${(PAD_T + chartH).toFixed(1)} Z`
      : "";

  // Y axis labels
  const yLabels = [0, 25, 50, 75, 100];

  // X axis: ~5 labels
  const xLabelCount = 5;
  const xLabels: { ts: number; label: string }[] = [];
  if (points.length > 0) {
    for (let i = 0; i < xLabelCount; i++) {
      const idx = Math.round((i / (xLabelCount - 1)) * (points.length - 1));
      const p = points[idx];
      if (p) {
        xLabels.push({ ts: p.timestamp, label: formatTime(p.timestamp, range) });
      }
    }
  }

  const gradientId = `grad-${metric.replace(/[^a-z0-9]/gi, "")}`;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * W;

    // Find closest point
    const ts = minTs + ((mouseX - PAD_L) / chartW) * tsSpan;
    let closest = points[0];
    let closestDist = Math.abs(points[0].timestamp - ts);
    for (const p of points) {
      const d = Math.abs(p.timestamp - ts);
      if (d < closestDist) {
        closest = p;
        closestDist = d;
      }
    }

    setTooltip({
      x: scaleX(closest.timestamp),
      y: scaleY(closest.value),
      value: Math.round(closest.value * 10) / 10,
      time: new Date(closest.timestamp).toLocaleString(),
    });
  };

  const handleMouseLeave = () => setTooltip(null);

  return (
    <div className="metric-chart">
      <div className="metric-chart-header">
        <span className="metric-chart-label">{label}</span>
        <div className="metric-chart-ranges">
          {RANGES.map((r) => (
            <button
              key={r}
              className={`metric-range-btn${r === range ? " active" : ""}`}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="metric-chart-body">
        {loading && points.length === 0 ? (
          <div className="metric-chart-loading">Loading...</div>
        ) : points.length === 0 ? (
          <div className="metric-chart-loading">No data available</div>
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="metric-chart-svg"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.3" />
                <stop offset="100%" stopColor="var(--teal)" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Grid lines */}
            {yLabels.map((v) => (
              <line
                key={v}
                x1={PAD_L}
                y1={scaleY(v)}
                x2={W - PAD_R}
                y2={scaleY(v)}
                stroke="var(--border)"
                strokeWidth="0.5"
              />
            ))}

            {/* Y axis labels */}
            {yLabels.map((v) => (
              <text
                key={v}
                x={PAD_L - 6}
                y={scaleY(v) + 4}
                textAnchor="end"
                fill="var(--text-tertiary)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                {v}%
              </text>
            ))}

            {/* X axis labels */}
            {xLabels.map((xl, i) => (
              <text
                key={i}
                x={scaleX(xl.ts)}
                y={H - 4}
                textAnchor="middle"
                fill="var(--text-tertiary)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                {xl.label}
              </text>
            ))}

            {/* Fill area */}
            {fillPath && (
              <path d={fillPath} fill={`url(#${gradientId})`} />
            )}

            {/* Line */}
            {linePath && (
              <path
                d={linePath}
                fill="none"
                stroke="var(--teal)"
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}

            {/* Tooltip crosshair + dot */}
            {tooltip && (
              <>
                <line
                  x1={tooltip.x}
                  y1={PAD_T}
                  x2={tooltip.x}
                  y2={PAD_T + chartH}
                  stroke="var(--text-tertiary)"
                  strokeWidth="0.5"
                  strokeDasharray="3,3"
                />
                <circle
                  cx={tooltip.x}
                  cy={tooltip.y}
                  r="4"
                  fill="var(--teal)"
                  stroke="var(--bg-card)"
                  strokeWidth="2"
                />
              </>
            )}
          </svg>
        )}

        {/* Floating tooltip */}
        {tooltip && (
          <div
            className="metric-chart-tooltip"
            style={{
              left: `${(tooltip.x / W) * 100}%`,
              top: `${(tooltip.y / H) * 100 - 14}%`,
            }}
          >
            <span className="metric-tooltip-value">{tooltip.value}%</span>
            <span className="metric-tooltip-time">{tooltip.time}</span>
          </div>
        )}
      </div>
    </div>
  );
}
