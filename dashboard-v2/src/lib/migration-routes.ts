import type { MigrationDirection, MultiClusterState } from "../types";

export type MigrationProvider = "vmware" | "proxmox" | "aws" | "azure";
export type RouteExecutionSupport = "full" | "plan_only";

export interface MigrationRoute {
  id: string;
  label: string;
  from: MigrationProvider;
  to: MigrationProvider;
  direction: MigrationDirection;
  executionSupport: RouteExecutionSupport;
  executionNote?: string;
}

export interface RouteAvailability {
  route: MigrationRoute;
  sourceConnected: boolean;
  targetConnected: boolean;
  /**
   * Human-readable reason this route's actions (List VMs / Plan / Execute) are
   * blocked, or null when the route is fully usable. Execution-support gating
   * (e.g. plan-only Azure) is intentionally NOT folded into this field — that
   * remains a separate concern handled by the execute-button disable logic.
   */
  blockedReason: string | null;
}

export const AZURE_PLAN_ONLY_NOTE =
  "Execution is not supported yet for this route. Use planning for sizing and preflight checks.";

/**
 * Canonical, hardcoded list of every cross-provider migration route the
 * dashboard advertises. All 12 directions render in the picker regardless of
 * which providers happen to be connected at runtime.
 */
export const ALL_MIGRATION_ROUTES: MigrationRoute[] = [
  { id: "vmware_to_proxmox", label: "VMware → Proxmox", from: "vmware", to: "proxmox", direction: "vmware_to_proxmox", executionSupport: "full" },
  { id: "proxmox_to_vmware", label: "Proxmox → VMware", from: "proxmox", to: "vmware", direction: "proxmox_to_vmware", executionSupport: "full" },
  { id: "vmware_to_aws", label: "VMware → AWS", from: "vmware", to: "aws", direction: "vmware_to_aws", executionSupport: "full" },
  { id: "aws_to_vmware", label: "AWS → VMware", from: "aws", to: "vmware", direction: "aws_to_vmware", executionSupport: "full" },
  { id: "proxmox_to_aws", label: "Proxmox → AWS", from: "proxmox", to: "aws", direction: "proxmox_to_aws", executionSupport: "full" },
  { id: "aws_to_proxmox", label: "AWS → Proxmox", from: "aws", to: "proxmox", direction: "aws_to_proxmox", executionSupport: "full" },
  { id: "vmware_to_azure", label: "VMware → Azure", from: "vmware", to: "azure", direction: "vmware_to_azure", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "azure_to_vmware", label: "Azure → VMware", from: "azure", to: "vmware", direction: "azure_to_vmware", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "proxmox_to_azure", label: "Proxmox → Azure", from: "proxmox", to: "azure", direction: "proxmox_to_azure", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "azure_to_proxmox", label: "Azure → Proxmox", from: "azure", to: "proxmox", direction: "azure_to_proxmox", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "aws_to_azure", label: "AWS → Azure", from: "aws", to: "azure", direction: "aws_to_azure", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
  { id: "azure_to_aws", label: "Azure → AWS", from: "azure", to: "aws", direction: "azure_to_aws", executionSupport: "plan_only", executionNote: AZURE_PLAN_ONLY_NOTE },
];

const PROVIDER_ENV_HINT: Record<MigrationProvider, string> = {
  vmware: "check VMWARE_HOST or your provider config",
  proxmox: "check PROXMOX_HOST or your provider config",
  aws: "check AWS credentials (AWS_ACCESS_KEY_ID / AWS_PROFILE)",
  azure: "check Azure credentials (AZURE_SUBSCRIPTION_ID / AZURE_TENANT_ID)",
};

const PROVIDER_DISPLAY: Record<MigrationProvider, string> = {
  vmware: "VMware",
  proxmox: "Proxmox",
  aws: "AWS",
  azure: "Azure",
};

export function isMigrationProvider(value: string): value is MigrationProvider {
  return value === "vmware" || value === "proxmox" || value === "aws" || value === "azure";
}

/**
 * Returns the set of providers reported as connected by `/api/cluster/all`.
 * `multiCluster.providers` is only populated for adapters where
 * `isConnected()` returned true, so the keys here directly model live state.
 */
export function connectedProvidersFromMultiCluster(
  multiCluster: MultiClusterState | null | undefined,
): Set<MigrationProvider> {
  const connected = new Set<MigrationProvider>();
  for (const provider of multiCluster?.providers ?? []) {
    if (isMigrationProvider(provider.type)) {
      connected.add(provider.type);
    }
  }
  return connected;
}

/**
 * Build a "soft-gated" route list: every supported direction is returned, but
 * each entry is annotated with whether its source/target providers are
 * actually connected and a human-readable blocked reason when the SOURCE side
 * is offline (the source is what blocks "List VMs" / "Plan" / "Execute").
 *
 * This intentionally never hides routes — earlier behavior of filtering them
 * out caused VMware-to-Proxmox to silently disappear when the VMware host was
 * unreachable, leaving the user with no way to even see the option.
 */
export function buildRouteAvailability(
  routes: MigrationRoute[],
  connected: Set<MigrationProvider>,
  options: { hasMultiClusterData: boolean },
): RouteAvailability[] {
  return routes.map((route) => {
    // Before any /api/cluster/all data has arrived, treat everything as
    // tentatively available so we don't flash spurious "disconnected"
    // warnings on the very first render.
    if (!options.hasMultiClusterData) {
      return {
        route,
        sourceConnected: true,
        targetConnected: true,
        blockedReason: null,
      };
    }

    const sourceConnected = connected.has(route.from);
    const targetConnected = connected.has(route.to);

    let blockedReason: string | null = null;
    if (!sourceConnected) {
      blockedReason =
        `Source provider ${PROVIDER_DISPLAY[route.from]} is not connected — ` +
        PROVIDER_ENV_HINT[route.from] +
        ".";
    }

    return { route, sourceConnected, targetConnected, blockedReason };
  });
}

/**
 * Decorate a route label for the dropdown so users can tell at a glance which
 * options are usable, plan-only, or blocked by a disconnected provider.
 */
export function decorateRouteLabel(entry: RouteAvailability): string {
  const { route, sourceConnected, targetConnected } = entry;
  const suffixes: string[] = [];
  if (route.executionSupport === "plan_only") suffixes.push("plan only");
  if (!sourceConnected) suffixes.push(`${PROVIDER_DISPLAY[route.from]} offline`);
  else if (!targetConnected) suffixes.push(`${PROVIDER_DISPLAY[route.to]} offline`);
  if (suffixes.length === 0) return route.label;
  return `${route.label} (${suffixes.join(", ")})`;
}
