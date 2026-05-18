// ============================================================
// Proxmox Primitives — enterMaintenance + exitMaintenance bodies,
// nodeNameFromHostId helper, capability stability,
// PrimitiveNotImplemented for the verbs that haven't shipped yet.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configureProxmoxPrimitives,
  createProxmoxPrimitives,
  nodeNameFromHostId,
} from "../../src/primitives/proxmox.js";
import {
  FileMaintenanceTracker,
  InMemoryMaintenanceTracker,
} from "../../src/primitives/proxmox-maintenance.js";
import {
  getPrimitives,
  PrimitiveNotImplemented,
} from "../../src/primitives/index.js";

describe("nodeNameFromHostId", () => {
  it("extracts the node name from a well-formed hostId", () => {
    expect(nodeNameFromHostId("proxmox:proxmox_node:pranavlab")).toBe(
      "pranavlab",
    );
    expect(nodeNameFromHostId("proxmox:proxmox_node:pve-1")).toBe("pve-1");
  });

  it("throws on wrong prefix", () => {
    expect(() => nodeNameFromHostId("vsphere:vsphere_host:host-1")).toThrow(
      /proxmox:proxmox_node:/,
    );
    expect(() => nodeNameFromHostId("proxmox:proxmox_vm:200")).toThrow();
  });

  it("throws on empty node name", () => {
    expect(() => nodeNameFromHostId("proxmox:proxmox_node:")).toThrow();
  });
});

describe("Proxmox primitives — enterMaintenance + exitMaintenance", () => {
  it("enterMaintenance marks the node in the tracker and returns enteredAt", async () => {
    const tracker = new InMemoryMaintenanceTracker();
    const prims = createProxmoxPrimitives({ tracker });
    const result = await prims.enterMaintenance({
      hostId: "proxmox:proxmox_node:pranavlab",
      provider: "proxmox",
      evacuate: false,
    });
    expect(result.success).toBe(true);
    expect(tracker.isIn("pranavlab")).toBe(true);
    const data = result.data as { node: string; enteredAt: string };
    expect(data.node).toBe("pranavlab");
    expect(data.enteredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("enterMaintenance with evacuate=true throws (separation of concerns)", async () => {
    const tracker = new InMemoryMaintenanceTracker();
    const prims = createProxmoxPrimitives({ tracker });
    await expect(
      prims.enterMaintenance({
        hostId: "proxmox:proxmox_node:pranavlab",
        provider: "proxmox",
        evacuate: true,
      }),
    ).rejects.toThrow(/evacuateWorkload/);
    // Tracker stays unmodified on rejection
    expect(tracker.isIn("pranavlab")).toBe(false);
  });

  it("exitMaintenance unmarks the node and reports prior state", async () => {
    const tracker = new InMemoryMaintenanceTracker();
    const prims = createProxmoxPrimitives({ tracker });
    await prims.enterMaintenance({
      hostId: "proxmox:proxmox_node:pranavlab",
      provider: "proxmox",
      evacuate: false,
    });
    const result = await prims.exitMaintenance({
      hostId: "proxmox:proxmox_node:pranavlab",
      provider: "proxmox",
    });
    expect(result.success).toBe(true);
    const data = result.data as { node: string; wasInMaintenance: boolean };
    expect(data.wasInMaintenance).toBe(true);
    expect(tracker.isIn("pranavlab")).toBe(false);
  });

  it("exitMaintenance on a node that wasn't in maintenance is a no-op success", async () => {
    const tracker = new InMemoryMaintenanceTracker();
    const prims = createProxmoxPrimitives({ tracker });
    const result = await prims.exitMaintenance({
      hostId: "proxmox:proxmox_node:never-was",
      provider: "proxmox",
    });
    expect(result.success).toBe(true);
    const data = result.data as { node: string; wasInMaintenance: boolean };
    expect(data.wasInMaintenance).toBe(false);
  });

  it("enter/exit round-trip persists via FileMaintenanceTracker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rhodes-prox-prim-"));
    try {
      const path = join(dir, "maint.json");
      const tracker1 = new FileMaintenanceTracker(path);
      const prims1 = createProxmoxPrimitives({ tracker: tracker1 });
      await prims1.enterMaintenance({
        hostId: "proxmox:proxmox_node:pranavlab",
        provider: "proxmox",
        evacuate: false,
      });
      // Fresh tracker reads from disk
      const tracker2 = new FileMaintenanceTracker(path);
      expect(tracker2.isIn("pranavlab")).toBe(true);
      const prims2 = createProxmoxPrimitives({ tracker: tracker2 });
      await prims2.exitMaintenance({
        hostId: "proxmox:proxmox_node:pranavlab",
        provider: "proxmox",
      });
      const tracker3 = new FileMaintenanceTracker(path);
      expect(tracker3.isIn("pranavlab")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Proxmox primitives — capability discovery + unshipped verbs", () => {
  it("capabilities() returns the locked matrix even before configuration", () => {
    const caps = getPrimitives("proxmox").capabilities();
    expect(caps.provider).toBe("proxmox");
    expect(caps.evacuateModes).toContain("live_migrate");
    expect(caps.evacuateModes).toContain("evict");
    expect(caps.maintenanceModeSupported).toBe(true);
    expect(caps.hostRemediationSupported).toBe(true);
    expect(caps.rollbackStrategies).toContain("snapshot_restore");
    expect(caps.notes).toContain("Live migration only works for QEMU VMs");
  });

  it("evacuateWorkload still throws PrimitiveNotImplemented (v0.7.1.2)", async () => {
    const prims = createProxmoxPrimitives();
    await expect(
      prims.evacuateWorkload({
        targetId: "proxmox:proxmox_node:pranavlab",
        provider: "proxmox",
        mode: "live_migrate",
      }),
    ).rejects.toThrow(PrimitiveNotImplemented);
  });

  it("remediateHost still throws PrimitiveNotImplemented (v0.7.1.3)", async () => {
    const prims = createProxmoxPrimitives();
    await expect(
      prims.remediateHost({
        hostId: "proxmox:proxmox_node:pranavlab",
        provider: "proxmox",
      }),
    ).rejects.toThrow(PrimitiveNotImplemented);
  });

  it("rollback still throws PrimitiveNotImplemented (v0.7.1.4)", async () => {
    const prims = createProxmoxPrimitives();
    await expect(
      prims.rollback({
        planId: "plan-1",
        stepId: "step-1",
        provider: "proxmox",
        strategy: "snapshot_restore",
      }),
    ).rejects.toThrow(PrimitiveNotImplemented);
  });
});

describe("configureProxmoxPrimitives", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rhodes-prox-conf-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("REPLACES the registry entry so getPrimitives returns the wired impl", async () => {
    const tracker = new FileMaintenanceTracker(join(dir, "maint.json"));
    configureProxmoxPrimitives({ tracker });
    const prims = getPrimitives("proxmox");
    await prims.enterMaintenance({
      hostId: "proxmox:proxmox_node:via-registry",
      provider: "proxmox",
      evacuate: false,
    });
    expect(tracker.isIn("via-registry")).toBe(true);
  });
});
