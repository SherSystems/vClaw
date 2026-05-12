// ============================================================
// RHODES — Proxmox Storage-Exhaustion Pause Playbook
//
// Diagnoses + remediates the most common "VM mysteriously dead"
// failure on Proxmox: a thin-provisioned `local-lvm` pool fills
// up from snapshot growth, QEMU suspends the guest with
//   `paused (io-error)`
// and the VM looks bricked. It isn't. Prune snapshots, `qm resume`,
// and the guest comes back instantly.
//
// This file is the canonical reference for how RHODES handles
// the STORAGE_EXHAUSTION_PAUSE event class.
// ============================================================

import type { ActionTier } from "../providers/types.js";

// ── Constants & Policy ──────────────────────────────────────

/** Threshold at which we declare the thin pool "full enough that QEMU
 *  may have suspended a VM". Used both proactively (warning) and as
 *  a precondition for the storage-pause diagnostic. */
export const THIN_POOL_PAUSE_RISK_PCT = 95;

/** Target Data% to fall under during EXECUTE — once we drop below this,
 *  stop deleting snapshots. */
export const THIN_POOL_TARGET_PCT = 80;

/** Snapshots older than this many days are flagged as "stale". */
export const DEFAULT_STALE_SNAPSHOT_DAYS = 30;

/** Names that look like crash-recovery / pre-upgrade safety snaps.
 *  These are preferred deletion candidates because they're typically
 *  one-shot artifacts that nobody actually intends to keep. */
const CRASH_RECOVERY_PREFIXES = [
  "autosnap_",
  "pre-reboot",
  "pre-upgrade",
  "pre-update",
  "crash",
  "recovery",
  "before-",
];

/** Action tiers for the qm commands this playbook may issue.
 *
 *  Per spec, this playbook overrides the default proxmox adapter
 *  classification for these commands when invoked as part of a
 *  storage-pause remediation:
 *    - `qm delsnapshot` → risky_write (Tier 3)
 *    - `qm reset`       → destructive (Tier 4)
 *    - `qm destroy`     → never        (Tier 5)  -- always blocked
 *
 *  Note: `qm destroy` deletion of active VM disks (`vm-*-disk-*`) is a
 *  hard rule — the playbook will NEVER propose it. Encoded in
 *  `validateRemediationCandidate()` below.
 */
export const PLAYBOOK_ACTION_TIERS: Record<string, ActionTier> = {
  "qm delsnapshot": "risky_write",
  "qm resume": "safe_write",
  "qm reset": "destructive",
  "qm destroy": "never",
};

// ── Public Types ────────────────────────────────────────────

export type DiagnosticPhase =
  | "vm_state"
  | "monitor_status"
  | "storage_inspection"
  | "snapshot_analysis"
  | "plan"
  | "execute"
  | "resume"
  | "verify";

export interface QmListEntry {
  vmid: number;
  name: string;
  status: string;
}

export interface QmConfig {
  vmid: number;
  /** Raw config lines from `qm config <vmid>`. */
  raw: Record<string, string>;
  /** Parsed disk references, e.g. ["local-lvm:vm-201-disk-0"]. */
  disks: string[];
  /** Storage IDs referenced by disks. */
  storages: string[];
}

export type MonitorStatus =
  | { kind: "running" }
  | { kind: "paused_io_error"; raw: string }
  | { kind: "paused_other"; raw: string }
  | { kind: "unknown"; raw: string };

export interface PvesmStatusEntry {
  storage: string;
  type: string;
  status: string;
  total_bytes: number;
  used_bytes: number;
  avail_bytes: number;
  used_pct: number;
}

export interface LvsEntry {
  lv: string;
  vg: string;
  attr: string;
  size_bytes: number;
  /** Only meaningful for thin-pool data LVs. */
  data_pct?: number;
  meta_pct?: number;
  origin?: string;
  pool?: string;
}

export interface SnapshotEntry {
  vmid: number;
  name: string;
  description?: string;
  /** ISO timestamp from `parent` snapshot tree, when known. */
  created_at?: string;
  /** Approximate bytes reclaimable if this snapshot is deleted. */
  estimated_bytes?: number;
}

export interface SnapshotCandidate extends SnapshotEntry {
  reasons: string[];
  /** Lower = delete sooner. */
  rank: number;
}

export interface StorageDiagnostic {
  /** Storage IDs that are at/over warn threshold. */
  exhausted_storages: PvesmStatusEntry[];
  /** Thin pools with high Data%. */
  hot_pools: LvsEntry[];
  /** VMs sharing each exhausted thin pool. */
  vms_by_storage: Record<string, number[]>;
}

export interface RemediationStep {
  command: string;
  description: string;
  tier: ActionTier;
  projected_bytes_freed: number;
  cumulative_bytes_freed: number;
  vmid: number;
  snapname: string;
}

export interface RemediationPlan {
  affected_vmid: number;
  thin_pool: string;
  current_data_pct: number;
  target_data_pct: number;
  steps: RemediationStep[];
  /** Resume command issued after pruning succeeds. */
  resume_command: string;
  /** Fallback if resume fails — gated separately. */
  reset_command: string;
  /** Hard-rule violations encountered while assembling the plan. */
  blocked_candidates: { item: string; reason: string }[];
}

export interface PlaybookFindings {
  phase: DiagnosticPhase;
  classification:
    | "STORAGE_EXHAUSTION_PAUSE"
    | "PAUSED_OTHER"
    | "RUNNING_UNREACHABLE"
    | "VM_MISSING"
    | "UNDETERMINED";
  vmid: number;
  node: string;
  monitor_status?: MonitorStatus;
  vm_config?: QmConfig;
  storage?: StorageDiagnostic;
  candidates?: SnapshotCandidate[];
  plan?: RemediationPlan;
  notes: string[];
}

// ── Parsers (deterministic, fully testable) ─────────────────

/**
 * Parse `qm list` output, e.g.:
 *
 *   VMID NAME                 STATUS     MEM(MB)   BOOTDISK(GB) PID
 *   201  esxi-02              running    16384     128.00       1234
 */
export function parseQmList(stdout: string): QmListEntry[] {
  const out: QmListEntry[] = [];
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^VMID\s/i.test(line)) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    out.push({ vmid: Number(m[1]), name: m[2], status: m[3] });
  }
  return out;
}

/** Parse `qm config <vmid>` (key: value lines). */
export function parseQmConfig(vmid: number, stdout: string): QmConfig {
  const raw: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.+)$/);
    if (!m) continue;
    raw[m[1]] = m[2].trim();
  }
  const disks: string[] = [];
  const storages = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    if (!/^(scsi|virtio|ide|sata|efidisk|tpmstate|unused)\d*$/.test(key)) continue;
    const volumeId = value.split(",")[0];
    if (!volumeId || volumeId === "none") continue;
    disks.push(volumeId);
    const storageId = volumeId.split(":")[0];
    if (storageId) storages.add(storageId);
  }
  return { vmid, raw, disks, storages: Array.from(storages) };
}

/**
 * Parse the output of `qm monitor <vmid>` followed by `info status`.
 *
 *   (qemu) info status
 *   VM status: paused (io-error)
 *
 * The crucial token is `paused (io-error)` — that's the storage-exhaustion
 * fingerprint.
 */
export function parseMonitorStatus(stdout: string): MonitorStatus {
  const text = stdout.toLowerCase();
  if (/paused\s*\(io-error\)/.test(text)) {
    return { kind: "paused_io_error", raw: stdout };
  }
  if (/vm\s*status:\s*paused/.test(text) || /^status:\s*paused/m.test(text)) {
    return { kind: "paused_other", raw: stdout };
  }
  if (/vm\s*status:\s*running/.test(text) || /status:\s*running/.test(text)) {
    return { kind: "running" };
  }
  return { kind: "unknown", raw: stdout };
}

/**
 * Parse `pvesm status` (whitespace-separated columns):
 *   Name     Type     Status   Total      Used       Available  %
 *   local    dir      active   100000000  10000000   90000000   10.00%
 */
export function parsePvesmStatus(stdout: string): PvesmStatusEntry[] {
  const out: PvesmStatusEntry[] = [];
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^name\s+type/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;
    const [storage, type, status, totalStr, usedStr, availStr, pctStr] = cols;
    const total = Number(totalStr) * 1024; // pvesm reports KiB
    const used = Number(usedStr) * 1024;
    const avail = Number(availStr) * 1024;
    const used_pct = pctStr
      ? Number(pctStr.replace(/%$/, ""))
      : total > 0 ? (used / total) * 100 : 0;
    if (!Number.isFinite(total) || !Number.isFinite(used_pct)) continue;
    out.push({
      storage,
      type,
      status,
      total_bytes: total,
      used_bytes: used,
      avail_bytes: avail,
      used_pct,
    });
  }
  return out;
}

/**
 * Parse `lvs --separator , --noheadings -o lv_name,vg_name,lv_attr,lv_size,data_percent,metadata_percent,origin,pool_lv`.
 *
 *   data,pve,twi-aotz--,1099511627776,92.45,15.20,,
 *   vm-201-disk-0,pve,Vwi-aotz--,107374182400,,,data,
 */
export function parseLvs(stdout: string): LvsEntry[] {
  const out: LvsEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(",");
    if (cols.length < 4) continue;
    const [lv, vg, attr, sizeStr, dataPctStr, metaPctStr, origin, pool] = cols;
    const sizeNum = Number(sizeStr);
    if (!Number.isFinite(sizeNum)) continue;
    const entry: LvsEntry = {
      lv: lv.trim(),
      vg: vg.trim(),
      attr: attr.trim(),
      size_bytes: sizeNum,
    };
    if (dataPctStr && dataPctStr.trim() !== "") {
      const d = Number(dataPctStr);
      if (Number.isFinite(d)) entry.data_pct = d;
    }
    if (metaPctStr && metaPctStr.trim() !== "") {
      const m = Number(metaPctStr);
      if (Number.isFinite(m)) entry.meta_pct = m;
    }
    if (origin && origin.trim()) entry.origin = origin.trim();
    if (pool && pool.trim()) entry.pool = pool.trim();
    out.push(entry);
  }
  return out;
}

/**
 * Parse `qm listsnapshot <vmid>`:
 *
 *   `-> autosnap_2026-01-01_00:00:00         autosnapshot
 *    `-> pre-reboot                          before kernel
 *    `-> current                             You are here!
 */
export function parseQmListSnapshot(
  vmid: number,
  stdout: string,
): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/you are here/i.test(trimmed)) continue;
    // Strip the tree prefix `-> or |-> or +->
    const m = trimmed.match(/^[`|+\\-]*->?\s*(\S+)\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    if (name === "current" || name === "now") continue;
    const description = m[2]?.trim() || undefined;
    const created_at = extractSnapshotTimestamp(name);
    const entry: SnapshotEntry = { vmid, name };
    if (description) entry.description = description;
    if (created_at) entry.created_at = created_at;
    out.push(entry);
  }
  return out;
}

function extractSnapshotTimestamp(name: string): string | undefined {
  // autosnap_2026-01-01_03:00:00, snapshot_20260101_030000, etc.
  const iso = name.match(/(\d{4})-(\d{2})-(\d{2})[_T](\d{2})[:_-]?(\d{2})[:_-]?(\d{2})/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}Z`;
  }
  const compact = name.match(/(\d{4})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})?/);
  if (compact) {
    const ss = compact[6] ?? "00";
    return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${ss}Z`;
  }
  return undefined;
}

// ── Classification ──────────────────────────────────────────

export function classifyMonitorOutput(
  monitor: MonitorStatus,
): PlaybookFindings["classification"] {
  if (monitor.kind === "paused_io_error") return "STORAGE_EXHAUSTION_PAUSE";
  if (monitor.kind === "paused_other") return "PAUSED_OTHER";
  if (monitor.kind === "running") return "RUNNING_UNREACHABLE";
  return "UNDETERMINED";
}

// ── Storage Inspection ──────────────────────────────────────

export interface StorageInspectionInput {
  pvesm: PvesmStatusEntry[];
  lvs: LvsEntry[];
  configs: QmConfig[];
  /** Threshold above which a storage is considered "exhausted". */
  warn_pct?: number;
}

export function inspectStorage(
  input: StorageInspectionInput,
): StorageDiagnostic {
  const warn = input.warn_pct ?? THIN_POOL_PAUSE_RISK_PCT;

  const exhausted_storages = input.pvesm.filter((s) => s.used_pct >= warn);

  const hot_pools = input.lvs.filter(
    (l) => l.data_pct !== undefined && l.data_pct >= warn && isThinPool(l),
  );

  const vms_by_storage: Record<string, number[]> = {};
  for (const s of exhausted_storages) {
    vms_by_storage[s.storage] = [];
  }
  for (const cfg of input.configs) {
    for (const storage of cfg.storages) {
      if (vms_by_storage[storage]) {
        vms_by_storage[storage].push(cfg.vmid);
      }
    }
  }

  return { exhausted_storages, hot_pools, vms_by_storage };
}

function isThinPool(lv: LvsEntry): boolean {
  // lvs lv_attr first char 't' = thin pool
  return lv.attr.startsWith("t");
}

// ── Snapshot Ranking ────────────────────────────────────────

export interface RankingOptions {
  stale_after_days?: number;
  now?: Date;
}

export function rankSnapshotsForDeletion(
  snapshots: SnapshotEntry[],
  options: RankingOptions = {},
): SnapshotCandidate[] {
  const staleDays = options.stale_after_days ?? DEFAULT_STALE_SNAPSHOT_DAYS;
  const now = options.now ?? new Date();
  const staleMs = staleDays * 24 * 3600 * 1000;

  const enriched: SnapshotCandidate[] = snapshots.map((s) => {
    const reasons: string[] = [];
    let ageMs: number | undefined;
    if (s.created_at) {
      ageMs = now.getTime() - new Date(s.created_at).getTime();
      if (ageMs >= staleMs) {
        reasons.push(`older than ${staleDays}d`);
      }
    }
    const lowered = s.name.toLowerCase();
    const isCrashRecovery = CRASH_RECOVERY_PREFIXES.some((p) =>
      lowered.startsWith(p),
    );
    if (isCrashRecovery) reasons.push("crash-recovery snapshot");

    // Lower rank = delete sooner.
    // Order: oldest first, then largest, then crash-recovery.
    let rank = 0;
    if (ageMs !== undefined) rank = -ageMs; // older → more negative → sorts first
    if (isCrashRecovery) rank -= 1e15;
    // Size as a secondary signal (larger frees more, prefer it).
    if (s.estimated_bytes !== undefined) rank -= s.estimated_bytes;

    return { ...s, reasons, rank };
  });

  enriched.sort((a, b) => a.rank - b.rank);
  return enriched;
}

// ── Hard-Rule Validation ────────────────────────────────────

/**
 * The hard rule: NEVER propose deleting an active VM disk (`vm-*-disk-*`).
 * Only snapshot deletion is allowed in remediation. This guards against
 * an LLM-generated plan that confuses an `lvs` row for a snapshot.
 *
 * Returns null if the candidate is safe, otherwise an error string.
 */
export function validateRemediationCandidate(item: {
  command?: string;
  target?: string;
}): string | null {
  const text = `${item.command ?? ""} ${item.target ?? ""}`.toLowerCase();

  // Block any reference to the active-disk LV naming pattern.
  if (/vm-\d+-disk-\d+/.test(text)) {
    return "Hard rule: never delete active VM disks (vm-*-disk-*).";
  }
  // Block destructive operations that aren't snapshot deletion.
  if (/\bqm\s+destroy\b/.test(text)) {
    return "Hard rule: qm destroy is Tier 5 (NEVER), permanently blocked.";
  }
  if (/\blvremove\b/.test(text) && !/snap/.test(text)) {
    return "Hard rule: lvremove on a non-snapshot LV is blocked.";
  }
  if (/\brm\s+-rf\b/.test(text)) {
    return "Hard rule: rm -rf is blocked in remediation plans.";
  }
  return null;
}

// ── Plan Builder ────────────────────────────────────────────

export interface PlanInput {
  vmid: number;
  thin_pool: string;
  current_data_pct: number;
  target_data_pct?: number;
  candidates: SnapshotCandidate[];
  /** Total bytes in the thin pool (for projecting % impact). */
  pool_size_bytes?: number;
}

export function buildRemediationPlan(input: PlanInput): RemediationPlan {
  const target = input.target_data_pct ?? THIN_POOL_TARGET_PCT;
  const poolSize = input.pool_size_bytes ?? 0;
  const targetBytesUsed = (target / 100) * poolSize;
  const currentBytesUsed = (input.current_data_pct / 100) * poolSize;
  const needBytesFreed = Math.max(0, currentBytesUsed - targetBytesUsed);

  const steps: RemediationStep[] = [];
  const blocked: RemediationPlan["blocked_candidates"] = [];
  let cumulative = 0;

  for (const c of input.candidates) {
    const cmd = `qm delsnapshot ${input.vmid} ${c.name}`;
    const violation = validateRemediationCandidate({
      command: cmd,
      target: c.name,
    });
    if (violation) {
      blocked.push({ item: c.name, reason: violation });
      continue;
    }

    const freed = c.estimated_bytes ?? 0;
    cumulative += freed;
    steps.push({
      command: cmd,
      description:
        `Delete snapshot "${c.name}" on vmid ${input.vmid}` +
        (c.reasons.length ? ` (${c.reasons.join(", ")})` : "") +
        (freed > 0 ? ` — frees ~${formatBytes(freed)}` : ""),
      tier: PLAYBOOK_ACTION_TIERS["qm delsnapshot"],
      projected_bytes_freed: freed,
      cumulative_bytes_freed: cumulative,
      vmid: input.vmid,
      snapname: c.name,
    });

    // Stop once we've satisfied the bytes goal — but always include at
    // least the top-ranked candidate so the operator sees something.
    if (
      needBytesFreed > 0 &&
      cumulative >= needBytesFreed &&
      steps.length > 0
    ) {
      break;
    }
  }

  return {
    affected_vmid: input.vmid,
    thin_pool: input.thin_pool,
    current_data_pct: input.current_data_pct,
    target_data_pct: target,
    steps,
    resume_command: `qm resume ${input.vmid}`,
    reset_command: `qm reset ${input.vmid}`,
    blocked_candidates: blocked,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(2)} ${units[i]}`;
}

// ── Executor Contract ──────────────────────────────────────
//
// The playbook does NOT call Proxmox directly. It expects an executor
// implementing this interface — that lets tests mock everything and
// keeps the playbook a pure decision module.

export interface ProxmoxExecutor {
  qmList(node: string): Promise<string>;
  qmConfig(node: string, vmid: number): Promise<string>;
  qmMonitorInfoStatus(node: string, vmid: number): Promise<string>;
  qmStatus(node: string, vmid: number): Promise<string>;
  pvesmStatus(node: string): Promise<string>;
  lvs(node: string): Promise<string>;
  qmListSnapshot(node: string, vmid: number): Promise<string>;
  /** Returns approximate bytes freed if known. */
  qmDelSnapshot(
    node: string,
    vmid: number,
    snapname: string,
  ): Promise<{ ok: boolean; bytes_freed?: number; error?: string }>;
  qmResume(
    node: string,
    vmid: number,
  ): Promise<{ ok: boolean; error?: string }>;
  qmReset(
    node: string,
    vmid: number,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Optional connectivity probe; resolve true if reachable. */
  sshProbe?(host: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

// ── End-to-End Runner ──────────────────────────────────────

export interface RunOptions {
  node: string;
  vmid: number;
  host?: string;
  warn_pct?: number;
  target_pct?: number;
  stale_after_days?: number;
  /** When true, also pulls snapshots from sibling VMs sharing the same pool. */
  include_siblings?: boolean;
  /** Approval callback. Called once with the assembled plan; if it
   *  returns false, EXECUTE is skipped. */
  approve_plan?: (plan: RemediationPlan) => Promise<boolean>;
  /** Separate approval for the Tier 4 reset fallback. */
  approve_reset?: (reason: string) => Promise<boolean>;
}

export interface RunResult {
  findings: PlaybookFindings;
  executed_steps: RemediationStep[];
  resumed: boolean;
  reset_required: boolean;
  reset_executed: boolean;
  reachable_after: boolean | null;
}

/**
 * Drive the playbook end-to-end against a (mocked or live) executor.
 *
 * This is the recovery path. The shape mirrors the spec section by section.
 */
export async function runProxmoxStoragePausePlaybook(
  executor: ProxmoxExecutor,
  options: RunOptions,
): Promise<RunResult> {
  const findings: PlaybookFindings = {
    phase: "vm_state",
    classification: "UNDETERMINED",
    vmid: options.vmid,
    node: options.node,
    notes: [],
  };

  // 1. VM state inspection
  const qmListOut = await executor.qmList(options.node);
  const vms = parseQmList(qmListOut);
  const present = vms.find((v) => v.vmid === options.vmid);
  if (!present) {
    findings.classification = "VM_MISSING";
    findings.notes.push(`vmid ${options.vmid} not present in qm list`);
    return emptyResult(findings);
  }

  const cfgOut = await executor.qmConfig(options.node, options.vmid);
  findings.vm_config = parseQmConfig(options.vmid, cfgOut);

  // 2. Branch on monitor output
  findings.phase = "monitor_status";
  const monOut = await executor.qmMonitorInfoStatus(options.node, options.vmid);
  findings.monitor_status = parseMonitorStatus(monOut);
  findings.classification = classifyMonitorOutput(findings.monitor_status);

  if (findings.classification !== "STORAGE_EXHAUSTION_PAUSE") {
    findings.notes.push(
      "Not a storage-exhaustion pause — falling out of playbook.",
    );
    return emptyResult(findings);
  }

  // 3. Storage inspection
  findings.phase = "storage_inspection";
  const pvesmOut = await executor.pvesmStatus(options.node);
  const lvsOut = await executor.lvs(options.node);
  const configs: QmConfig[] = [findings.vm_config!];
  if (options.include_siblings) {
    for (const v of vms) {
      if (v.vmid === options.vmid) continue;
      try {
        const c = await executor.qmConfig(options.node, v.vmid);
        configs.push(parseQmConfig(v.vmid, c));
      } catch {
        // Tolerated — siblings may be transient.
      }
    }
  }
  const storage = inspectStorage({
    pvesm: parsePvesmStatus(pvesmOut),
    lvs: parseLvs(lvsOut),
    configs,
    warn_pct: options.warn_pct,
  });
  findings.storage = storage;

  // 4. Snapshot bloat detection
  findings.phase = "snapshot_analysis";
  const snapshotsRaw: SnapshotEntry[] = [];
  for (const cfg of configs) {
    try {
      const snapsOut = await executor.qmListSnapshot(options.node, cfg.vmid);
      const parsed = parseQmListSnapshot(cfg.vmid, snapsOut);
      // Attribute approximate size from lvs entries when present.
      for (const s of parsed) {
        s.estimated_bytes = estimateSnapshotBytes(s, parseLvs(lvsOut));
      }
      snapshotsRaw.push(...parsed);
    } catch {
      // Skip
    }
  }
  const candidates = rankSnapshotsForDeletion(snapshotsRaw, {
    stale_after_days: options.stale_after_days,
  });
  findings.candidates = candidates;

  // 5. PLAN
  findings.phase = "plan";
  const hotPool = storage.hot_pools[0];
  const dataPct =
    hotPool?.data_pct ??
    storage.exhausted_storages[0]?.used_pct ??
    0;
  const plan = buildRemediationPlan({
    vmid: options.vmid,
    thin_pool: hotPool?.lv ?? "data",
    current_data_pct: dataPct,
    target_data_pct: options.target_pct,
    candidates,
    pool_size_bytes: hotPool?.size_bytes,
  });
  findings.plan = plan;

  if (plan.steps.length === 0) {
    findings.notes.push(
      "No deletable snapshot candidates — escalate to operator.",
    );
    return emptyResult(findings);
  }

  // Operator approval gate
  if (options.approve_plan) {
    const ok = await options.approve_plan(plan);
    if (!ok) {
      findings.notes.push("Operator rejected remediation plan.");
      return emptyResult(findings);
    }
  }

  // 6. EXECUTE
  findings.phase = "execute";
  const executed: RemediationStep[] = [];
  for (const step of plan.steps) {
    const r = await executor.qmDelSnapshot(
      options.node,
      step.vmid,
      step.snapname,
    );
    if (!r.ok) {
      findings.notes.push(
        `Failed to delete ${step.snapname}: ${r.error ?? "unknown error"}`,
      );
      continue;
    }
    executed.push(step);

    // Recheck after each delete; stop if we've crossed the target.
    const after = parseLvs(await executor.lvs(options.node));
    const refreshed = after.find((l) => l.lv === plan.thin_pool);
    if (
      refreshed?.data_pct !== undefined &&
      refreshed.data_pct < plan.target_data_pct
    ) {
      findings.notes.push(
        `Thin pool Data% below target (${refreshed.data_pct}%), stopping pruning.`,
      );
      break;
    }
  }

  // 7. Resume + verify
  findings.phase = "resume";
  const resume = await executor.qmResume(options.node, options.vmid);
  let resumed = resume.ok;
  let reset_required = false;
  let reset_executed = false;

  if (resumed) {
    await executor.sleep(5_000);
    const statusOut = await executor.qmStatus(options.node, options.vmid);
    if (!/status:\s*running/i.test(statusOut)) {
      resumed = false;
    }
  }

  if (!resumed) {
    reset_required = true;
    findings.notes.push("Resume did not bring VM back; reset gate engaged.");
    if (options.approve_reset) {
      const ok = await options.approve_reset(
        `qm resume failed for vmid ${options.vmid}; qm reset is Tier 4.`,
      );
      if (ok) {
        const r = await executor.qmReset(options.node, options.vmid);
        reset_executed = r.ok;
      }
    }
  }

  findings.phase = "verify";
  let reachable_after: boolean | null = null;
  if (options.host && executor.sshProbe) {
    try {
      reachable_after = await executor.sshProbe(options.host);
    } catch {
      reachable_after = false;
    }
  }

  return {
    findings,
    executed_steps: executed,
    resumed,
    reset_required,
    reset_executed,
    reachable_after,
  };
}

function emptyResult(findings: PlaybookFindings): RunResult {
  return {
    findings,
    executed_steps: [],
    resumed: false,
    reset_required: false,
    reset_executed: false,
    reachable_after: null,
  };
}

function estimateSnapshotBytes(
  snap: SnapshotEntry,
  lvs: LvsEntry[],
): number | undefined {
  // Proxmox thin-pool snapshots show up as LVs named `snap_vm-<vmid>-disk-<n>_<snapname>`
  // We sum any matching rows.
  const re = new RegExp(`snap_vm-${snap.vmid}-disk-\\d+_${escapeRegExp(snap.name)}$`);
  const matches = lvs.filter((l) => re.test(l.lv));
  if (matches.length === 0) return undefined;
  return matches.reduce((sum, l) => sum + l.size_bytes, 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
