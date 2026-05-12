// ============================================================
// RHODES — Proxmox VM Runtime Status Derivation
//
// The basic `/nodes/<node>/qemu` list endpoint reports `status:
// "running"` for VMs that QEMU itself has suspended due to a storage
// I/O failure. That's why the Jellyfin incident (2026-05-12) flew
// under the radar — RHODES saw vm-101 as "running" while QEMU had
// it parked in `paused (io-error)` for hours.
//
// `runtime_status` is the truthful state class. Computing it
// sometimes requires a per-VM probe (`qm monitor info status` or
// the Proxmox API's `/status/current` which surfaces `qmpstatus`),
// so this module also owns the per-VM cache that keeps that probe
// off the hot path.
//
// Strategy (kept conservative on purpose):
//   - `stopped` / `paused` / `unknown` basic statuses → no probe needed.
//   - `running` basic status + `lock` present → no probe; `runtime_status`
//     is `locked` regardless of QMP state. Backup/migrate/snapshot are
//     legitimate "running but not freely runnable" reasons.
//   - `running` basic status + recent thin-pool pressure → probe AND
//     cache the result for 60s. The pressure signal comes from the
//     thin-pool monitor — passing in via `thinPoolPressure: true`
//     overrides any cache miss.
//   - Otherwise, the probe is OPTIONAL; the adapter calls it on a
//     timer-aware basis and falls back to the cached value.
//
// The cost we're optimizing: `qm monitor info status` is per-VM and
// not free (~50-200ms each over the REST API). For a 50-VM cluster
// on a 30s poll cadence that's a ~5s tax we don't want every tick.
// ============================================================

/**
 * The truthful state class for a Proxmox VM. The orchestrator emits
 * this as the `reason` label on `vm_status` events so playbook
 * triggers can match exactly (e.g. the storage-pause playbook keys
 * on `reason: "paused_io_error"`).
 */
export type RuntimeStatus =
  | "running"
  | "paused_io_error"
  | "paused_other"
  | "locked"
  | "stopped"
  | "error";

/** Inputs the derivation needs. Mirrors the subset of `ProxmoxVM` plus
 *  the QMP probe result so the function is unit-testable without a
 *  network. */
export interface RuntimeStatusInputs {
  /** Basic status from `/nodes/<node>/qemu` — "running" | "stopped" | "paused" | other. */
  status: string;
  /** Proxmox lock field (backup, migrate, snapshot, suspended, ...). */
  lock?: string;
  /** QMP-level status when available — "running" | "paused" | "io-error" | "internal-error" | ... */
  qmpstatus?: string;
}

/**
 * Compute the truthful state class from whatever signals we have.
 * Order matters: a locked VM whose QMP says paused-io-error is still
 * `paused_io_error` because the io-error is the operative fact for
 * remediation. Conversely a `qmpstatus: "running"` doesn't override
 * a lock — the lock makes the VM untouchable.
 */
export function deriveRuntimeStatus(inputs: RuntimeStatusInputs): RuntimeStatus {
  const basic = inputs.status?.toLowerCase() ?? "";
  const qmp = inputs.qmpstatus?.toLowerCase();
  const lock = inputs.lock?.toLowerCase();

  // QMP io-error is the alarm bell we never want to drop, even if the
  // basic API claims "running" and a lock is present.
  if (qmp === "io-error" || qmp === "paused (io-error)") return "paused_io_error";
  if (qmp === "internal-error" || qmp === "guest-panicked") return "error";

  if (basic === "stopped") return "stopped";

  if (lock) {
    // `suspended` is operator-driven pause-via-lock; treat as paused_other
    // since there is no I/O fault driving it.
    if (lock === "suspended") return "paused_other";
    return "locked";
  }

  if (basic === "paused") {
    // No lock, no qmp signal — manual pause or migration without lock.
    return "paused_other";
  }

  if (qmp === "paused") return "paused_other";
  if (qmp === "running") return "running";

  if (basic === "running") return "running";

  // Unknown / "unknown" / empty → treat as error so it's visible.
  return "error";
}

// ── Cache ───────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  qmpstatus: string;
  recordedAt: number;
}

export interface QmpProbeFn {
  (node: string, vmid: number): Promise<string | undefined>;
}

/**
 * Per-VM cache around the QMP probe. Keeps `qm monitor info status`
 * off the hot path while still keeping the truth fresh enough that a
 * VM going io-error is surfaced within ~1 poll cycle on a 30s cadence
 * (since at >70% thin-pool utilization we bypass the cache).
 */
export class VmRuntimeStatusCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Decide whether the adapter should call `qm monitor info status`
   * for this VM right now. The contract is:
   *   - basic status not "running"          → no probe
   *   - lock present                         → no probe (locked is the answer)
   *   - thin-pool pressure on this VM's pool → probe (bypass cache)
   *   - cache hit within TTL                 → no probe
   *   - otherwise                            → probe
   */
  shouldProbe(
    node: string,
    vmid: number,
    inputs: { status: string; lock?: string; thinPoolPressure?: boolean },
    now: number = Date.now(),
  ): boolean {
    const basic = inputs.status?.toLowerCase() ?? "";
    if (basic !== "running") return false;
    if (inputs.lock) return false;
    if (inputs.thinPoolPressure) return true;
    const entry = this.entries.get(this.key(node, vmid));
    if (!entry) return true;
    return now - entry.recordedAt >= this.ttlMs;
  }

  /** Return a cached qmpstatus if one is still fresh. */
  getCached(node: string, vmid: number, now: number = Date.now()): string | undefined {
    const entry = this.entries.get(this.key(node, vmid));
    if (!entry) return undefined;
    if (now - entry.recordedAt >= this.ttlMs) return undefined;
    return entry.qmpstatus;
  }

  /** Record a fresh QMP probe result. */
  record(node: string, vmid: number, qmpstatus: string, now: number = Date.now()): void {
    this.entries.set(this.key(node, vmid), { qmpstatus, recordedAt: now });
  }

  /** Drop a cached entry — e.g. after a VM is stopped. */
  invalidate(node: string, vmid: number): void {
    this.entries.delete(this.key(node, vmid));
  }

  private key(node: string, vmid: number): string {
    return `${node}:${vmid}`;
  }
}
