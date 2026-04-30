import { useEffect, useMemo, useState } from "react";
import {
  fetchCostSummary,
  fetchCostTimeseries,
  fetchCostTopResources,
} from "../../api/client";
import {
  buildStackedCostSeries,
  getProviderColor,
  sortCostResourcesByMonthlyCost,
  titleCaseProvider,
} from "../../lib/costs";
import type {
  CostComparisonMode,
  CostTimeseriesPoint,
  CostTopResource,
  ProviderCostSummary,
} from "../../types";

const USD_WHOLE = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const USD_PRECISE = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface LoadState<T> {
  loading: boolean;
  error: string | null;
  data: T;
}

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1000) return USD_WHOLE.format(value);
  return USD_PRECISE.format(value);
}

function formatDateLabel(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Failed to load cost data.";
}

function CostsTrendChart({
  state,
}: {
  state: LoadState<CostTimeseriesPoint[]>;
}) {
  const stacked = useMemo(() => buildStackedCostSeries(state.data, 30), [state.data]);
  const [tooltipIdx, setTooltipIdx] = useState<number | null>(null);

  if (state.loading) {
    return <div className="costs-chart-state">Loading 30-day cost trend...</div>;
  }

  if (state.error) {
    return <div className="costs-chart-state error">Unable to load trend data: {state.error}</div>;
  }

  if (stacked.dates.length === 0 || stacked.providers.length === 0) {
    return <div className="costs-chart-state">No cost trend data available yet.</div>;
  }

  const W = 880;
  const H = 260;
  const PAD_L = 54;
  const PAD_R = 16;
  const PAD_T = 14;
  const PAD_B = 40;

  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const maxY = Math.max(1, ...stacked.totals);
  const xDivisor = Math.max(stacked.dates.length - 1, 1);

  const xFor = (idx: number) => PAD_L + (idx / xDivisor) * chartW;
  const yFor = (value: number) => PAD_T + chartH - (value / maxY) * chartH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((p) => p * maxY);

  const buildLayerPath = (provider: string): string => {
    const points = stacked.layers[provider] ?? [];
    if (points.length === 0) return "";

    let path = `M${xFor(0).toFixed(2)},${yFor(points[0].y1).toFixed(2)}`;
    for (let i = 1; i < points.length; i += 1) {
      path += ` L${xFor(i).toFixed(2)},${yFor(points[i].y1).toFixed(2)}`;
    }
    for (let i = points.length - 1; i >= 0; i -= 1) {
      path += ` L${xFor(i).toFixed(2)},${yFor(points[i].y0).toFixed(2)}`;
    }
    path += " Z";
    return path;
  };

  const activeIdx = tooltipIdx;

  return (
    <div className="costs-chart-wrap">
      <div className="costs-legend">
        {stacked.providers.map((provider) => (
          <div key={provider} className="costs-legend-item">
            <span
              className="costs-legend-dot"
              style={{ background: getProviderColor(provider) }}
            />
            <span>{titleCaseProvider(provider)}</span>
          </div>
        ))}
      </div>

      <div className="costs-chart-surface">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="costs-chart-svg"
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const localX = ((event.clientX - rect.left) / rect.width) * W;
            const normalized = (localX - PAD_L) / chartW;
            const idx = Math.round(Math.max(0, Math.min(1, normalized)) * xDivisor);
            setTooltipIdx(idx);
          }}
          onMouseLeave={() => setTooltipIdx(null)}
        >
          {yTicks.map((tick, idx) => (
            <line
              key={`grid-${idx}`}
              x1={PAD_L}
              y1={yFor(tick)}
              x2={W - PAD_R}
              y2={yFor(tick)}
              stroke="var(--border)"
              strokeWidth="0.75"
            />
          ))}

          {yTicks.map((tick, idx) => (
            <text
              key={`ylabel-${idx}`}
              x={PAD_L - 8}
              y={yFor(tick) + 4}
              textAnchor="end"
              fill="var(--text-tertiary)"
              fontSize="10"
              fontFamily="var(--font-mono)"
            >
              {formatUsd(tick)}
            </text>
          ))}

          {stacked.providers.map((provider) => (
            <path
              key={provider}
              d={buildLayerPath(provider)}
              fill={getProviderColor(provider)}
              fillOpacity="0.28"
              stroke={getProviderColor(provider)}
              strokeWidth="1.2"
            />
          ))}

          {stacked.dates.map((date, idx) => {
            if (idx % Math.ceil(stacked.dates.length / 6) !== 0 && idx !== stacked.dates.length - 1) {
              return null;
            }
            return (
              <text
                key={`xlabel-${date}`}
                x={xFor(idx)}
                y={H - 8}
                textAnchor="middle"
                fill="var(--text-tertiary)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                {formatDateLabel(date)}
              </text>
            );
          })}

          {activeIdx !== null && (
            <line
              x1={xFor(activeIdx)}
              y1={PAD_T}
              x2={xFor(activeIdx)}
              y2={PAD_T + chartH}
              stroke="var(--text-secondary)"
              strokeWidth="0.8"
              strokeDasharray="3 3"
            />
          )}
        </svg>

        {activeIdx !== null && (
          <div
            className="costs-tooltip"
            style={{
              left: `${(xFor(activeIdx) / W) * 100}%`,
            }}
          >
            <div className="costs-tooltip-date">{formatDateLabel(stacked.dates[activeIdx])}</div>
            <div className="costs-tooltip-total">
              Total {formatUsd(stacked.totals[activeIdx] ?? 0)}
            </div>
            {stacked.providers
              .map((provider) => {
                const point = stacked.layers[provider]?.[activeIdx];
                return {
                  provider,
                  value: point?.value ?? 0,
                };
              })
              .filter((entry) => entry.value > 0)
              .sort((a, b) => b.value - a.value)
              .map((entry) => (
                <div key={entry.provider} className="costs-tooltip-row">
                  <span>{titleCaseProvider(entry.provider)}</span>
                  <strong>{formatUsd(entry.value)}</strong>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Costs() {
  const [mode, setMode] = useState<CostComparisonMode>("cloud");
  const [reloadToken, setReloadToken] = useState(0);

  const [summaryState, setSummaryState] = useState<LoadState<ProviderCostSummary[]>>({
    loading: true,
    error: null,
    data: [],
  });
  const [timeseriesState, setTimeseriesState] = useState<LoadState<CostTimeseriesPoint[]>>({
    loading: true,
    error: null,
    data: [],
  });
  const [topResourcesState, setTopResourcesState] = useState<LoadState<CostTopResource[]>>({
    loading: true,
    error: null,
    data: [],
  });

  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");

  useEffect(() => {
    let cancelled = false;
    setSummaryState((prev) => ({ ...prev, loading: true, error: null }));
    setTimeseriesState((prev) => ({ ...prev, loading: true, error: null }));
    setTopResourcesState((prev) => ({ ...prev, loading: true, error: null }));

    Promise.allSettled([
      fetchCostSummary(mode),
      fetchCostTimeseries(mode),
      fetchCostTopResources(mode, 10),
    ]).then(([summaryResult, timeseriesResult, topResourcesResult]) => {
      if (cancelled) return;

      if (summaryResult.status === "fulfilled") {
        setSummaryState({
          loading: false,
          error: null,
          data: summaryResult.value,
        });
      } else {
        setSummaryState({
          loading: false,
          error: toErrorMessage(summaryResult.reason),
          data: [],
        });
      }

      if (timeseriesResult.status === "fulfilled") {
        setTimeseriesState({
          loading: false,
          error: null,
          data: timeseriesResult.value,
        });
      } else {
        setTimeseriesState({
          loading: false,
          error: toErrorMessage(timeseriesResult.reason),
          data: [],
        });
      }

      if (topResourcesResult.status === "fulfilled") {
        setTopResourcesState({
          loading: false,
          error: null,
          data: topResourcesResult.value,
        });
      } else {
        setTopResourcesState({
          loading: false,
          error: toErrorMessage(topResourcesResult.reason),
          data: [],
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [mode, reloadToken]);

  const totalMonthlySpend = useMemo(
    () => summaryState.data.reduce((sum, row) => sum + row.monthlyCostUsd, 0),
    [summaryState.data],
  );

  const projectedMonthSpend = useMemo(() => {
    if (timeseriesState.data.length === 0) return null;

    const byDate = new Map<string, number>();
    for (const point of timeseriesState.data) {
      byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.costUsd);
    }
    const dates = [...byDate.keys()].sort();
    if (dates.length === 0) return null;

    const latest = new Date(dates[dates.length - 1]);
    if (Number.isNaN(latest.getTime())) return null;

    const elapsedDays = Math.max(1, latest.getUTCDate());
    const daysInMonth = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() + 1, 0)).getUTCDate();
    const spendSoFar = [...byDate.values()].reduce((sum, value) => sum + value, 0);
    return (spendSoFar / elapsedDays) * daysInMonth;
  }, [timeseriesState.data]);

  const sortedTopResources = useMemo(
    () => sortCostResourcesByMonthlyCost(topResourcesState.data, sortDirection),
    [topResourcesState.data, sortDirection],
  );

  return (
    <div className="page costs-page">
      <div className="page-header">
        <h2>Costs</h2>
        <div className="costs-toggle" role="tablist" aria-label="Cost comparison mode">
          <button
            className={`costs-toggle-btn${mode === "cloud" ? " active" : ""}`}
            role="tab"
            aria-selected={mode === "cloud"}
            onClick={() => setMode("cloud")}
          >
            Cloud Only
          </button>
          <button
            className={`costs-toggle-btn${mode === "hybrid" ? " active" : ""}`}
            role="tab"
            aria-selected={mode === "hybrid"}
            onClick={() => setMode("hybrid")}
          >
            Cloud + On-Prem
          </button>
        </div>
      </div>

      <section className="costs-section">
        <div className="costs-section-head">
          <h3>Monthly Spend by Provider</h3>
          <div className="costs-section-meta">
            {!summaryState.loading && !summaryState.error && summaryState.data.length > 0 && (
              <span>Total {formatUsd(totalMonthlySpend)}</span>
            )}
            {projectedMonthSpend !== null && !timeseriesState.loading && !timeseriesState.error && (
              <span className="costs-projection">Projected EOM {formatUsd(projectedMonthSpend)}</span>
            )}
          </div>
        </div>

        {summaryState.loading && (
          <div className="costs-cards">
            {[0, 1, 2, 3].map((idx) => (
              <div key={idx} className="costs-card skeleton" />
            ))}
          </div>
        )}

        {!summaryState.loading && summaryState.error && (
          <div className="costs-state error">
            <span>Unable to load monthly provider totals: {summaryState.error}</span>
            <button
              className="costs-inline-action"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        )}

        {!summaryState.loading && !summaryState.error && summaryState.data.length === 0 && (
          <div className="costs-state">No provider spend records available for this mode.</div>
        )}

        {!summaryState.loading && !summaryState.error && summaryState.data.length > 0 && (
          <div className="costs-cards">
            {[...summaryState.data]
              .sort((a, b) => b.monthlyCostUsd - a.monthlyCostUsd)
              .map((row) => (
                <article key={row.provider} className="costs-card">
                  <div className="costs-card-head">
                    <span
                      className="costs-provider-dot"
                      style={{ background: getProviderColor(row.provider) }}
                    />
                    <span>{titleCaseProvider(row.provider)}</span>
                  </div>
                  <div className="costs-card-value">{formatUsd(row.monthlyCostUsd)}</div>
                  <div className="costs-card-label">Current month spend</div>
                </article>
              ))}
          </div>
        )}
      </section>

      <section className="costs-section">
        <div className="costs-section-head">
          <h3>30-Day Spend Trend</h3>
        </div>
        <CostsTrendChart state={timeseriesState} />
      </section>

      <section className="costs-section">
        <div className="costs-section-head">
          <h3>Top 10 Costliest Resources</h3>
        </div>

        {topResourcesState.loading && (
          <div className="costs-state">Loading resource costs...</div>
        )}

        {!topResourcesState.loading && topResourcesState.error && (
          <div className="costs-state error">
            <span>Unable to load top resources: {topResourcesState.error}</span>
            <button
              className="costs-inline-action"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        )}

        {!topResourcesState.loading && !topResourcesState.error && topResourcesState.data.length === 0 && (
          <div className="costs-state">No resources available for this timeframe.</div>
        )}

        {!topResourcesState.loading && !topResourcesState.error && topResourcesState.data.length > 0 && (
          <div className="costs-table-wrap">
            <table className="costs-table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Provider</th>
                  <th>Type</th>
                  <th aria-sort={sortDirection === "asc" ? "ascending" : "descending"}>
                    <button
                      className="costs-sort-btn"
                      onClick={() => setSortDirection((prev) => (prev === "desc" ? "asc" : "desc"))}
                    >
                      Monthly Cost {sortDirection === "desc" ? "▼" : "▲"}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedTopResources.map((resource) => (
                  <tr key={resource.id}>
                    <td>
                      <div className="costs-resource-cell">
                        <span className="costs-resource-name">{resource.name}</span>
                        <span className="costs-resource-id">{resource.id}</span>
                      </div>
                    </td>
                    <td>{titleCaseProvider(resource.provider)}</td>
                    <td>{resource.resourceType}</td>
                    <td className="costs-resource-cost">{formatUsd(resource.monthlyCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
