// ============================================================
// Proxmox rollback — strategy gating + honest PrimitiveNotImplemented
// for the supported strategies (real bodies need orchestrator-recorded
// context that lands in v0.8).
// ============================================================

import { describe, expect, it } from "vitest";
import { createProxmoxPrimitives } from "../../src/primitives/proxmox.js";
import {
  CapabilityUnsupported,
  PrimitiveNotImplemented,
} from "../../src/primitives/index.js";

describe("rollback — strategy gating", () => {
  it("rejects blue_green with CapabilityUnsupported (Proxmox doesn't publish it)", async () => {
    const prims = createProxmoxPrimitives();
    await expect(
      prims.rollback({
        planId: "plan-1",
        stepId: "step-1",
        provider: "proxmox",
        strategy: "blue_green",
      }),
    ).rejects.toBeInstanceOf(CapabilityUnsupported);
  });

  it("rejects surge_teardown with CapabilityUnsupported", async () => {
    const prims = createProxmoxPrimitives();
    await expect(
      prims.rollback({
        planId: "plan-1",
        stepId: "step-1",
        provider: "proxmox",
        strategy: "surge_teardown",
      }),
    ).rejects.toBeInstanceOf(CapabilityUnsupported);
  });

  it("snapshot_restore throws PrimitiveNotImplemented (v0.8 context wiring pending)", async () => {
    const prims = createProxmoxPrimitives();
    await expect(
      prims.rollback({
        planId: "plan-1",
        stepId: "step-1",
        provider: "proxmox",
        strategy: "snapshot_restore",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);
  });

  it("inverse_mutation throws PrimitiveNotImplemented (v0.8 context wiring pending)", async () => {
    const prims = createProxmoxPrimitives();
    await expect(
      prims.rollback({
        planId: "plan-1",
        stepId: "step-1",
        provider: "proxmox",
        strategy: "inverse_mutation",
      }),
    ).rejects.toBeInstanceOf(PrimitiveNotImplemented);
  });

  it("error matches the strategy gate's claims about the capability matrix", () => {
    // Every strategy NOT in capabilities() must fail with
    // CapabilityUnsupported; every strategy IN capabilities() must
    // fail with PrimitiveNotImplemented (until v0.8 wires context).
    const prims = createProxmoxPrimitives();
    const caps = prims.capabilities();
    expect(caps.rollbackStrategies).toEqual(["snapshot_restore", "inverse_mutation"]);
    // (Behavior verified per-strategy in the other tests.)
  });
});
