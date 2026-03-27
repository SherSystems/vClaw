interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}

export function Sparkline({
  data,
  color = "var(--teal)",
  width = 80,
  height = 24,
}: SparklineProps) {
  if (!data || data.length < 2) return null;

  const padding = 2;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * innerW;
    const y = padding + innerH - ((v - min) / range) * innerH;
    return `${x},${y}`;
  });

  const polyline = points.join(" ");

  // Build closed polygon for gradient fill (line + bottom edge)
  const fillPoints = [
    `${padding},${height - padding}`,
    ...points,
    `${width - padding},${height - padding}`,
  ].join(" ");

  const gradientId = `spark-grad-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="sparkline"
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={fillPoints}
        fill={`url(#${gradientId})`}
      />
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Return a color based on percentage thresholds. */
export function metricColor(pct: number): string {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--amber)";
  return "var(--teal)";
}

export default Sparkline;
