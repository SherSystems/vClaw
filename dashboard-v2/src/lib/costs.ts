import type { CostTimeseriesPoint, CostTopResource } from "../types";

export type CostSortDirection = "asc" | "desc";

export interface StackedLayerPoint {
  date: string;
  y0: number;
  y1: number;
  value: number;
}

export interface StackedCostSeries {
  dates: string[];
  providers: string[];
  layers: Record<string, StackedLayerPoint[]>;
  totals: number[];
}

export function normalizeProviderName(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "amazon web services") return "aws";
  if (normalized === "microsoft azure") return "azure";
  if (normalized === "onprem" || normalized === "on premise") return "on-prem";
  return normalized;
}

export function isOnPremProvider(provider: string): boolean {
  const normalized = normalizeProviderName(provider);
  return (
    normalized.includes("proxmox")
    || normalized.includes("vmware")
    || normalized.includes("on-prem")
    || normalized.includes("onprem")
    || normalized.includes("homelab")
    || normalized.includes("local")
  );
}

export function getProviderColor(provider: string): string {
  const normalized = normalizeProviderName(provider);
  if (normalized.includes("aws")) return "#ff9900";
  if (normalized.includes("azure")) return "#3b82f6";
  if (normalized.includes("proxmox")) return "#f97316";
  if (normalized.includes("vmware")) return "#22c55e";
  if (normalized.includes("on-prem") || normalized.includes("homelab")) return "#14b8a6";
  return "#a78bfa";
}

export function titleCaseProvider(provider: string): string {
  const normalized = normalizeProviderName(provider);
  if (normalized === "aws") return "AWS";
  if (normalized === "azure") return "Azure";
  if (normalized === "vmware") return "VMware";
  if (normalized === "proxmox") return "Proxmox";
  if (normalized === "on-prem") return "On-Prem";
  return provider;
}

export function sortCostResourcesByMonthlyCost(
  resources: CostTopResource[],
  direction: CostSortDirection,
): CostTopResource[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...resources].sort((a, b) => {
    if (a.monthlyCostUsd === b.monthlyCostUsd) {
      return a.name.localeCompare(b.name);
    }
    return (a.monthlyCostUsd - b.monthlyCostUsd) * factor;
  });
}

export function buildStackedCostSeries(
  points: CostTimeseriesPoint[],
  limitDays = 30,
): StackedCostSeries {
  if (points.length === 0) {
    return { dates: [], providers: [], layers: {}, totals: [] };
  }

  const byDate = new Map<string, Map<string, number>>();
  const providerSet = new Set<string>();

  for (const point of points) {
    if (!point.date || !point.provider) continue;
    providerSet.add(point.provider);
    const dateMap = byDate.get(point.date) ?? new Map<string, number>();
    dateMap.set(point.provider, (dateMap.get(point.provider) ?? 0) + Math.max(0, point.costUsd));
    byDate.set(point.date, dateMap);
  }

  const dates = [...byDate.keys()].sort();
  const trimmedDates = dates.slice(Math.max(0, dates.length - limitDays));
  const providers = [...providerSet].sort((a, b) => titleCaseProvider(a).localeCompare(titleCaseProvider(b)));

  const layers: Record<string, StackedLayerPoint[]> = {};
  const totals: number[] = [];
  let maxDailyTotal = 0;

  for (const provider of providers) {
    layers[provider] = [];
  }

  for (const date of trimmedDates) {
    const dateMap = byDate.get(date) ?? new Map<string, number>();
    let running = 0;
    for (const provider of providers) {
      const value = dateMap.get(provider) ?? 0;
      const y0 = running;
      running += value;
      const y1 = running;
      layers[provider].push({ date, y0, y1, value });
    }
    totals.push(running);
    maxDailyTotal = Math.max(maxDailyTotal, running);
  }

  if (maxDailyTotal <= 0) {
    return { dates: trimmedDates, providers, layers, totals };
  }

  return { dates: trimmedDates, providers, layers, totals };
}
