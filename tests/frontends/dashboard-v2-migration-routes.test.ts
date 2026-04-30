import { describe, expect, it } from "vitest";
import {
  ALL_MIGRATION_ROUTES,
  buildRouteAvailability,
  connectedProvidersFromMultiCluster,
  decorateRouteLabel,
  type MigrationProvider,
} from "../../dashboard-v2/src/lib/migration-routes";
import type { MultiClusterState } from "../../dashboard-v2/src/types";

function makeMultiCluster(types: string[]): MultiClusterState {
  return {
    timestamp: "2026-04-30T00:00:00.000Z",
    providers: types.map((type) => ({
      name: type,
      type,
      state: {
        nodes: [],
        vms: [],
        containers: [],
        storage: [],
        timestamp: "2026-04-30T00:00:00.000Z",
      },
    })),
  };
}

function connectedSet(types: MigrationProvider[]): Set<MigrationProvider> {
  return new Set(types);
}

describe("dashboard-v2 migration routes lib", () => {
  it("declares all 12 cross-provider directions", () => {
    expect(ALL_MIGRATION_ROUTES).toHaveLength(12);

    const ids = ALL_MIGRATION_ROUTES.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        "vmware_to_proxmox",
        "proxmox_to_vmware",
        "vmware_to_aws",
        "aws_to_vmware",
        "proxmox_to_aws",
        "aws_to_proxmox",
        "vmware_to_azure",
        "azure_to_vmware",
        "proxmox_to_azure",
        "azure_to_proxmox",
        "aws_to_azure",
        "azure_to_aws",
      ].sort(),
    );

    // Every Azure route is plan-only; every non-Azure route supports full execution.
    for (const route of ALL_MIGRATION_ROUTES) {
      const touchesAzure = route.from === "azure" || route.to === "azure";
      if (touchesAzure) {
        expect(route.executionSupport).toBe("plan_only");
      } else {
        expect(route.executionSupport).toBe("full");
      }
    }
  });

  describe("connectedProvidersFromMultiCluster", () => {
    it("returns empty set when multiCluster is null", () => {
      expect(connectedProvidersFromMultiCluster(null)).toEqual(new Set());
      expect(connectedProvidersFromMultiCluster(undefined)).toEqual(new Set());
    });

    it("extracts provider types reported as connected", () => {
      const mc = makeMultiCluster(["proxmox", "aws", "azure"]);
      expect(connectedProvidersFromMultiCluster(mc)).toEqual(
        new Set(["proxmox", "aws", "azure"]),
      );
    });

    it("ignores unknown provider types", () => {
      const mc = makeMultiCluster(["proxmox", "k8s", "system"]);
      expect(connectedProvidersFromMultiCluster(mc)).toEqual(new Set(["proxmox"]));
    });
  });

  describe("buildRouteAvailability", () => {
    it("returns ALL routes (every direction in the picker) even when one source provider is offline", () => {
      // VMware host is unreachable in the user's actual environment.
      const connected = connectedSet(["proxmox", "aws", "azure"]);
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connected, {
        hasMultiClusterData: true,
      });

      // Same length as input — nothing is filtered out.
      expect(availability).toHaveLength(ALL_MIGRATION_ROUTES.length);
      expect(availability.map((a) => a.route.id).sort()).toEqual(
        ALL_MIGRATION_ROUTES.map((r) => r.id).sort(),
      );

      // The user-reported missing route is present.
      const vmwareToProxmox = availability.find(
        (a) => a.route.id === "vmware_to_proxmox",
      );
      expect(vmwareToProxmox).toBeDefined();
    });

    it("flags routes whose source provider is disconnected with a clear blockedReason", () => {
      const connected = connectedSet(["proxmox", "aws", "azure"]);
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connected, {
        hasMultiClusterData: true,
      });

      const vmwareToProxmox = availability.find((a) => a.route.id === "vmware_to_proxmox")!;
      expect(vmwareToProxmox.sourceConnected).toBe(false);
      expect(vmwareToProxmox.targetConnected).toBe(true);
      expect(vmwareToProxmox.blockedReason).toContain("VMware");
      expect(vmwareToProxmox.blockedReason).toContain("not connected");
      expect(vmwareToProxmox.blockedReason).toContain("VMWARE_HOST");
    });

    it("does NOT block routes when only the target is disconnected (target check happens server-side at execute)", () => {
      const connected = connectedSet(["vmware", "aws", "azure"]); // proxmox missing
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connected, {
        hasMultiClusterData: true,
      });

      const vmwareToProxmox = availability.find((a) => a.route.id === "vmware_to_proxmox")!;
      expect(vmwareToProxmox.sourceConnected).toBe(true);
      expect(vmwareToProxmox.targetConnected).toBe(false);
      expect(vmwareToProxmox.blockedReason).toBeNull();
    });

    it("does NOT flag anything as disconnected before /api/cluster/all data has loaded", () => {
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, new Set(), {
        hasMultiClusterData: false,
      });

      for (const entry of availability) {
        expect(entry.sourceConnected).toBe(true);
        expect(entry.targetConnected).toBe(true);
        expect(entry.blockedReason).toBeNull();
      }
    });

    it("never hides a route when ALL providers are offline (every direction stays selectable)", () => {
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, new Set(), {
        hasMultiClusterData: true,
      });
      expect(availability).toHaveLength(12);
      // Every route is blocked because no source is connected — but they're still visible.
      for (const entry of availability) {
        expect(entry.blockedReason).not.toBeNull();
      }
    });

    it("emits provider-specific environment hints for each provider", () => {
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, new Set(), {
        hasMultiClusterData: true,
      });

      const byFrom = (from: MigrationProvider) =>
        availability.find((a) => a.route.from === from)!;

      expect(byFrom("vmware").blockedReason).toContain("VMWARE_HOST");
      expect(byFrom("proxmox").blockedReason).toContain("PROXMOX_HOST");
      expect(byFrom("aws").blockedReason).toContain("AWS_ACCESS_KEY_ID");
      expect(byFrom("azure").blockedReason).toContain("AZURE_SUBSCRIPTION_ID");
    });
  });

  describe("decorateRouteLabel", () => {
    it("returns the raw label for a fully-usable, full-execution route", () => {
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connectedSet(["vmware", "proxmox", "aws", "azure"]), {
        hasMultiClusterData: true,
      });
      const entry = availability.find((a) => a.route.id === "vmware_to_proxmox")!;
      expect(decorateRouteLabel(entry)).toBe("VMware → Proxmox");
    });

    it("appends 'plan only' for Azure routes", () => {
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connectedSet(["vmware", "proxmox", "aws", "azure"]), {
        hasMultiClusterData: true,
      });
      const entry = availability.find((a) => a.route.id === "vmware_to_azure")!;
      expect(decorateRouteLabel(entry)).toBe("VMware → Azure (plan only)");
    });

    it("appends 'X offline' when the source provider is disconnected", () => {
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connectedSet(["proxmox", "aws", "azure"]), {
        hasMultiClusterData: true,
      });
      const entry = availability.find((a) => a.route.id === "vmware_to_proxmox")!;
      expect(decorateRouteLabel(entry)).toBe("VMware → Proxmox (VMware offline)");
    });

    it("appends 'X offline' for the target when only the target is disconnected", () => {
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connectedSet(["vmware", "aws", "azure"]), {
        hasMultiClusterData: true,
      });
      const entry = availability.find((a) => a.route.id === "vmware_to_proxmox")!;
      expect(decorateRouteLabel(entry)).toBe("VMware → Proxmox (Proxmox offline)");
    });

    it("combines plan-only and offline suffixes", () => {
      // Azure route, VMware source offline.
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connectedSet(["proxmox", "aws", "azure"]), {
        hasMultiClusterData: true,
      });
      const entry = availability.find((a) => a.route.id === "vmware_to_azure")!;
      expect(decorateRouteLabel(entry)).toBe("VMware → Azure (plan only, VMware offline)");
    });
  });

  describe("user-reported scenario: VMware host unreachable, Proxmox+AWS+Azure connected", () => {
    it("still shows vmware_to_proxmox in the picker, just blocked with a clear reason", () => {
      const mc = makeMultiCluster(["proxmox", "aws", "azure"]);
      const connected = connectedProvidersFromMultiCluster(mc);
      const availability = buildRouteAvailability(ALL_MIGRATION_ROUTES, connected, {
        hasMultiClusterData: true,
      });

      // All 12 routes still selectable.
      expect(availability).toHaveLength(12);

      const vmwareRoutes = availability.filter((a) => a.route.from === "vmware");
      expect(vmwareRoutes).toHaveLength(3); // vmware->proxmox, vmware->aws, vmware->azure
      for (const entry of vmwareRoutes) {
        expect(entry.sourceConnected).toBe(false);
        expect(entry.blockedReason).not.toBeNull();
        // Action button copy must point the user at the right env var.
        expect(entry.blockedReason).toContain("VMWARE_HOST");
      }

      // Routes whose source is connected stay fully usable.
      const proxmoxToAws = availability.find((a) => a.route.id === "proxmox_to_aws")!;
      expect(proxmoxToAws.blockedReason).toBeNull();
      expect(proxmoxToAws.sourceConnected).toBe(true);
    });
  });
});
