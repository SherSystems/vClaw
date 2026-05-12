// ============================================================
// RHODES — Proxmox VM Runtime Status Unit Tests
// ============================================================
//
// Locks in the truth-table for runtime_status derivation. The
// Jellyfin incident (2026-05-12) exposed that the basic
// /nodes/<node>/qemu list endpoint reports `status: "running"`
// for VMs that QEMU itself has suspended due to a storage I/O
// failure — these tests pin down the cases that adapter must
// surface so the storage-pause playbook trigger matches.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deriveRuntimeStatus,
  VmRuntimeStatusCache,
} from "../../src/providers/proxmox/vm-runtime-status.js";

describe("deriveRuntimeStatus", () => {
  it("returns running for a plain running VM", () => {
    expect(deriveRuntimeStatus({ status: "running" })).toBe("running");
    expect(deriveRuntimeStatus({ status: "running", qmpstatus: "running" })).toBe(
      "running",
    );
  });

  it("returns paused_io_error when qmpstatus is io-error even if basic status says running", () => {
    // The Jellyfin case — basic list endpoint says running, QEMU monitor
    // says paused (io-error).
    expect(deriveRuntimeStatus({ status: "running", qmpstatus: "io-error" })).toBe(
      "paused_io_error",
    );
  });

  it("returns paused_io_error for the canonical 'paused (io-error)' qmpstatus string", () => {
    expect(
      deriveRuntimeStatus({ status: "running", qmpstatus: "paused (io-error)" }),
    ).toBe("paused_io_error");
  });

  it("returns error for internal-error and guest-panicked", () => {
    expect(
      deriveRuntimeStatus({ status: "running", qmpstatus: "internal-error" }),
    ).toBe("error");
    expect(
      deriveRuntimeStatus({ status: "running", qmpstatus: "guest-panicked" }),
    ).toBe("error");
  });

  it("returns stopped when basic status is stopped", () => {
    expect(deriveRuntimeStatus({ status: "stopped" })).toBe("stopped");
  });

  it("returns locked when a non-suspended lock is present", () => {
    expect(deriveRuntimeStatus({ status: "running", lock: "backup" })).toBe(
      "locked",
    );
    expect(deriveRuntimeStatus({ status: "running", lock: "migrate" })).toBe(
      "locked",
    );
    expect(deriveRuntimeStatus({ status: "running", lock: "snapshot" })).toBe(
      "locked",
    );
  });

  it("returns paused_other for the suspended lock (operator pause-via-lock)", () => {
    expect(deriveRuntimeStatus({ status: "running", lock: "suspended" })).toBe(
      "paused_other",
    );
  });

  it("returns paused_other when basic status is paused with no lock and no qmp", () => {
    expect(deriveRuntimeStatus({ status: "paused" })).toBe("paused_other");
  });

  it("io-error overrides a lock — lock cannot mask the alarm", () => {
    // A snapshot lock combined with an io-error means snapshot got us into
    // io-error. The remediation path still needs to know it's io-error,
    // not just "locked".
    expect(
      deriveRuntimeStatus({
        status: "running",
        lock: "snapshot",
        qmpstatus: "io-error",
      }),
    ).toBe("paused_io_error");
  });

  it("returns error for unknown / empty status when nothing else is set", () => {
    expect(deriveRuntimeStatus({ status: "" })).toBe("error");
    expect(deriveRuntimeStatus({ status: "unknown" })).toBe("error");
  });
});

describe("VmRuntimeStatusCache", () => {
  let cache: VmRuntimeStatusCache;

  beforeEach(() => {
    cache = new VmRuntimeStatusCache(60_000);
  });

  it("probes the first time it sees a running VM", () => {
    expect(cache.shouldProbe("pve1", 101, { status: "running" })).toBe(true);
  });

  it("does not probe a stopped VM", () => {
    expect(cache.shouldProbe("pve1", 101, { status: "stopped" })).toBe(false);
  });

  it("does not probe a locked VM — locked is already the answer", () => {
    expect(
      cache.shouldProbe("pve1", 101, { status: "running", lock: "backup" }),
    ).toBe(false);
  });

  it("skips probe while cached, probes again after TTL elapses", () => {
    const t0 = 1_000_000;
    cache.record("pve1", 101, "running", t0);

    expect(
      cache.shouldProbe("pve1", 101, { status: "running" }, t0 + 30_000),
    ).toBe(false);
    expect(cache.getCached("pve1", 101, t0 + 30_000)).toBe("running");

    expect(
      cache.shouldProbe("pve1", 101, { status: "running" }, t0 + 60_001),
    ).toBe(true);
    expect(cache.getCached("pve1", 101, t0 + 60_001)).toBeUndefined();
  });

  it("bypasses cache when thin-pool pressure is signaled", () => {
    const t0 = 1_000_000;
    cache.record("pve1", 101, "running", t0);

    // Cache is fresh — normally we'd skip. Pressure flips it back to probing.
    expect(
      cache.shouldProbe(
        "pve1",
        101,
        { status: "running", thinPoolPressure: true },
        t0 + 30_000,
      ),
    ).toBe(true);
  });

  it("invalidates cleanly", () => {
    cache.record("pve1", 101, "running");
    expect(cache.getCached("pve1", 101)).toBe("running");
    cache.invalidate("pve1", 101);
    expect(cache.getCached("pve1", 101)).toBeUndefined();
  });
});
