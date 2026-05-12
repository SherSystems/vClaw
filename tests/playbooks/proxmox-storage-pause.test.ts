import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseQmList,
  parseQmConfig,
  parseMonitorStatus,
  parsePvesmStatus,
  parseLvs,
  parseQmListSnapshot,
  classifyMonitorOutput,
  inspectStorage,
  rankSnapshotsForDeletion,
  validateRemediationCandidate,
  buildRemediationPlan,
  runProxmoxStoragePausePlaybook,
  PLAYBOOK_ACTION_TIERS,
  THIN_POOL_PAUSE_RISK_PCT,
  type ProxmoxExecutor,
  type SnapshotCandidate,
} from "../../src/playbooks/proxmox-storage-pause.js";

// ── Fixtures ────────────────────────────────────────────────

const QM_LIST_OUT = `
      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       100 esxi-01              running    16384      128.00       1234
       201 esxi-02              paused     16384      128.00       5678
       300 utility              running    4096       32.00        9101
`;

const QM_CONFIG_OUT = `
boot: order=scsi0;net0
cores: 4
memory: 16384
name: esxi-02
net0: virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0
scsi0: local-lvm:vm-201-disk-0,size=128G
scsihw: virtio-scsi-single
parent: autosnap_2026-01-15_03_00_00
`;

const MONITOR_PAUSED_IO = `
(qemu) info status
VM status: paused (io-error)
`;

const MONITOR_RUNNING = `
(qemu) info status
VM status: running
`;

const PVESM_OUT = `
Name             Type     Status           Total            Used       Available        %
local            dir      active        100000000        10000000        90000000   10.00%
local-lvm        lvmthin  active       1000000000       980000000        20000000   98.00%
`;

const LVS_OUT = [
  "data,pve,twi-aotz--,1099511627776,96.40,15.20,,",
  "vm-201-disk-0,pve,Vwi-aotz--,137438953472,,,data,",
  "snap_vm-201-disk-0_autosnap_2026-01-15_03_00_00,pve,Vwi-aotz--,80530636800,,,data,",
  "snap_vm-201-disk-0_pre-reboot,pve,Vwi-aotz--,53687091200,,,data,",
  "snap_vm-100-disk-0_keep,pve,Vwi-aotz--,21474836480,,,data,",
].join("\n");

const QM_LISTSNAPSHOT_OUT = `
\`-> autosnap_2026-01-15_03_00_00         autosnapshot
 \`-> pre-reboot                            before kernel upgrade
 \`-> current                              You are here!
`;

// ── Parser tests ────────────────────────────────────────────

describe("parsers", () => {
  it("parseQmList extracts vmid/name/status", () => {
    const out = parseQmList(QM_LIST_OUT);
    expect(out).toHaveLength(3);
    expect(out.find((v) => v.vmid === 201)?.status).toBe("paused");
  });

  it("parseQmConfig extracts disks and storage refs", () => {
    const cfg = parseQmConfig(201, QM_CONFIG_OUT);
    expect(cfg.disks).toContain("local-lvm:vm-201-disk-0");
    expect(cfg.storages).toContain("local-lvm");
    expect(cfg.raw.memory).toBe("16384");
  });

  it("parseMonitorStatus detects paused (io-error)", () => {
    expect(parseMonitorStatus(MONITOR_PAUSED_IO).kind).toBe(
      "paused_io_error",
    );
  });

  it("parseMonitorStatus detects running", () => {
    expect(parseMonitorStatus(MONITOR_RUNNING).kind).toBe("running");
  });

  it("parseMonitorStatus separates paused_other from paused (io-error)", () => {
    const out = parseMonitorStatus("VM status: paused");
    expect(out.kind).toBe("paused_other");
  });

  it("parsePvesmStatus extracts utilization %", () => {
    const out = parsePvesmStatus(PVESM_OUT);
    const lvm = out.find((s) => s.storage === "local-lvm");
    expect(lvm).toBeDefined();
    expect(lvm!.used_pct).toBeCloseTo(98, 0);
  });

  it("parseLvs extracts thin pool Data%", () => {
    const out = parseLvs(LVS_OUT);
    const data = out.find((l) => l.lv === "data");
    expect(data).toBeDefined();
    expect(data!.attr.startsWith("t")).toBe(true);
    expect(data!.data_pct).toBeCloseTo(96.4, 1);
  });

  it("parseQmListSnapshot extracts snapshot names", () => {
    const snaps = parseQmListSnapshot(201, QM_LISTSNAPSHOT_OUT);
    const names = snaps.map((s) => s.name);
    expect(names).toContain("autosnap_2026-01-15_03_00_00");
    expect(names).toContain("pre-reboot");
    expect(names).not.toContain("current");
  });
});

// ── Classification ─────────────────────────────────────────

describe("classifyMonitorOutput", () => {
  it("paused (io-error) → STORAGE_EXHAUSTION_PAUSE", () => {
    expect(
      classifyMonitorOutput({ kind: "paused_io_error", raw: "" }),
    ).toBe("STORAGE_EXHAUSTION_PAUSE");
  });

  it("paused (other) → PAUSED_OTHER", () => {
    expect(classifyMonitorOutput({ kind: "paused_other", raw: "" })).toBe(
      "PAUSED_OTHER",
    );
  });

  it("running → RUNNING_UNREACHABLE (fall through path)", () => {
    expect(classifyMonitorOutput({ kind: "running" })).toBe(
      "RUNNING_UNREACHABLE",
    );
  });
});

// ── Storage Inspection ─────────────────────────────────────

describe("inspectStorage", () => {
  it("flags storages above warn threshold and groups VMs", () => {
    const cfg = parseQmConfig(201, QM_CONFIG_OUT);
    const out = inspectStorage({
      pvesm: parsePvesmStatus(PVESM_OUT),
      lvs: parseLvs(LVS_OUT),
      configs: [cfg],
      warn_pct: 85,
    });
    expect(out.exhausted_storages.map((s) => s.storage)).toContain(
      "local-lvm",
    );
    expect(out.hot_pools.map((p) => p.lv)).toContain("data");
    expect(out.vms_by_storage["local-lvm"]).toContain(201);
  });

  it("uses default warn pct (95) when not provided", () => {
    expect(THIN_POOL_PAUSE_RISK_PCT).toBe(95);
  });
});

// ── Snapshot Ranking ───────────────────────────────────────

describe("rankSnapshotsForDeletion", () => {
  it("ranks crash-recovery + stale older snaps first", () => {
    const now = new Date("2026-05-12T12:00:00Z");
    const ranked = rankSnapshotsForDeletion(
      [
        {
          vmid: 201,
          name: "keep_me",
          created_at: "2026-05-10T00:00:00Z",
          estimated_bytes: 100,
        },
        {
          vmid: 201,
          name: "autosnap_2026-01-15_03_00_00",
          created_at: "2026-01-15T03:00:00Z",
          estimated_bytes: 800,
        },
        {
          vmid: 201,
          name: "pre-reboot",
          estimated_bytes: 500,
        },
      ],
      { stale_after_days: 30, now },
    );
    // autosnap is both >30d AND crash-recovery prefix → should be first
    expect(ranked[0].name).toBe("autosnap_2026-01-15_03_00_00");
    // keep_me has no flags → ranked last
    expect(ranked[ranked.length - 1].name).toBe("keep_me");
  });
});

// ── Safety Rails ───────────────────────────────────────────

describe("validateRemediationCandidate (hard rules)", () => {
  it("blocks deletion of vm-*-disk-* active disks", () => {
    expect(
      validateRemediationCandidate({ command: "lvremove pve/vm-201-disk-0" }),
    ).toMatch(/never delete active VM disks/);
  });

  it("blocks qm destroy unconditionally", () => {
    expect(
      validateRemediationCandidate({ command: "qm destroy 201" }),
    ).toMatch(/Tier 5/);
  });

  it("blocks rm -rf", () => {
    expect(
      validateRemediationCandidate({ command: "rm -rf /var/lib/vz" }),
    ).toMatch(/rm -rf/);
  });

  it("allows qm delsnapshot of a non-active-disk snapshot", () => {
    expect(
      validateRemediationCandidate({
        command: "qm delsnapshot 201 autosnap_2026",
        target: "autosnap_2026",
      }),
    ).toBeNull();
  });
});

// ── Plan Builder ───────────────────────────────────────────

describe("buildRemediationPlan", () => {
  const candidates: SnapshotCandidate[] = [
    {
      vmid: 201,
      name: "autosnap_2026-01-15_03_00_00",
      reasons: ["older than 30d", "crash-recovery snapshot"],
      rank: -1,
      estimated_bytes: 80 * 1024 ** 3,
    },
    {
      vmid: 201,
      name: "pre-reboot",
      reasons: ["crash-recovery snapshot"],
      rank: -0.5,
      estimated_bytes: 50 * 1024 ** 3,
    },
  ];

  it("emits qm delsnapshot commands at risky_write tier", () => {
    const plan = buildRemediationPlan({
      vmid: 201,
      thin_pool: "data",
      current_data_pct: 90,
      candidates,
      pool_size_bytes: 1000 * 1024 ** 3,
    });
    // need to free ~10% of 1000 GiB = 100 GiB. First candidate frees 80 GiB
    // (insufficient), second snapshot adds 50 GiB → cumulative 130 GiB ≥ 100 GiB → stop.
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].command).toBe(
      "qm delsnapshot 201 autosnap_2026-01-15_03_00_00",
    );
    expect(plan.steps[0].tier).toBe("risky_write");
    expect(plan.resume_command).toBe("qm resume 201");
    expect(plan.reset_command).toBe("qm reset 201");
  });

  it("never proposes deleting vm-*-disk-* disks (hard rule)", () => {
    // Inject a candidate that names a VM disk; plan must move it to blocked.
    const plan = buildRemediationPlan({
      vmid: 201,
      thin_pool: "data",
      current_data_pct: 96,
      candidates: [
        {
          vmid: 201,
          name: "vm-201-disk-0",
          reasons: ["malicious entry"],
          rank: 0,
        },
        ...candidates,
      ],
    });
    expect(
      plan.steps.find((s) => s.snapname === "vm-201-disk-0"),
    ).toBeUndefined();
    expect(plan.blocked_candidates.map((b) => b.item)).toContain(
      "vm-201-disk-0",
    );
  });

  it("encodes tier mapping: delsnapshot=risky, reset=destructive, destroy=never", () => {
    expect(PLAYBOOK_ACTION_TIERS["qm delsnapshot"]).toBe("risky_write");
    expect(PLAYBOOK_ACTION_TIERS["qm reset"]).toBe("destructive");
    expect(PLAYBOOK_ACTION_TIERS["qm destroy"]).toBe("never");
  });
});

// ── End-to-End Happy Path ──────────────────────────────────

function makeExecutor(overrides: Partial<ProxmoxExecutor> = {}): ProxmoxExecutor {
  return {
    qmList: vi.fn().mockResolvedValue(QM_LIST_OUT),
    qmConfig: vi.fn().mockResolvedValue(QM_CONFIG_OUT),
    qmMonitorInfoStatus: vi.fn().mockResolvedValue(MONITOR_PAUSED_IO),
    qmStatus: vi.fn().mockResolvedValue("status: running"),
    pvesmStatus: vi.fn().mockResolvedValue(PVESM_OUT),
    lvs: vi
      .fn()
      .mockResolvedValueOnce(LVS_OUT) // initial inspection
      .mockResolvedValue(
        // after delsnapshot: data_pct drops to 78%
        [
          "data,pve,twi-aotz--,1099511627776,78.10,12.00,,",
          "vm-201-disk-0,pve,Vwi-aotz--,137438953472,,,data,",
        ].join("\n"),
      ),
    qmListSnapshot: vi.fn().mockResolvedValue(QM_LISTSNAPSHOT_OUT),
    qmDelSnapshot: vi
      .fn()
      .mockResolvedValue({ ok: true, bytes_freed: 80 * 1024 ** 3 }),
    qmResume: vi.fn().mockResolvedValue({ ok: true }),
    qmReset: vi.fn().mockResolvedValue({ ok: true }),
    sshProbe: vi.fn().mockResolvedValue(true),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runProxmoxStoragePausePlaybook — happy path", () => {
  it("classifies as STORAGE_EXHAUSTION_PAUSE, prunes, resumes, verifies", async () => {
    const executor = makeExecutor();
    const approve = vi.fn().mockResolvedValue(true);

    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
      host: "10.0.0.201",
      approve_plan: approve,
    });

    expect(result.findings.classification).toBe(
      "STORAGE_EXHAUSTION_PAUSE",
    );
    expect(approve).toHaveBeenCalledOnce();
    expect(result.executed_steps.length).toBeGreaterThan(0);
    expect(executor.qmResume).toHaveBeenCalledWith("pve1", 201);
    expect(result.resumed).toBe(true);
    expect(result.reachable_after).toBe(true);
  });

  it("stops pruning once thin pool drops below target Data%", async () => {
    const executor = makeExecutor();
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
      approve_plan: async () => true,
    });
    // After first delsnapshot, lvs reports 78% < target 80% → loop exits.
    expect(result.executed_steps).toHaveLength(1);
  });

  it("falls out cleanly when monitor reports running (not a storage pause)", async () => {
    const executor = makeExecutor({
      qmMonitorInfoStatus: vi.fn().mockResolvedValue(MONITOR_RUNNING),
    });
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
    });
    expect(result.findings.classification).toBe("RUNNING_UNREACHABLE");
    expect(result.executed_steps).toHaveLength(0);
    expect(executor.qmDelSnapshot).not.toHaveBeenCalled();
  });

  it("requests Tier 4 reset approval when resume fails", async () => {
    const executor = makeExecutor({
      qmResume: vi.fn().mockResolvedValue({ ok: false, error: "still paused" }),
      qmStatus: vi.fn().mockResolvedValue("status: paused"),
    });
    const approveReset = vi.fn().mockResolvedValue(true);
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
      approve_plan: async () => true,
      approve_reset: approveReset,
    });
    expect(result.reset_required).toBe(true);
    expect(approveReset).toHaveBeenCalledOnce();
    expect(executor.qmReset).toHaveBeenCalledOnce();
  });

  it("aborts when operator rejects the remediation plan", async () => {
    const executor = makeExecutor();
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
      approve_plan: async () => false,
    });
    expect(result.executed_steps).toHaveLength(0);
    expect(executor.qmDelSnapshot).not.toHaveBeenCalled();
    expect(executor.qmResume).not.toHaveBeenCalled();
  });

  it("marks vmid as missing if not in qm list", async () => {
    const executor = makeExecutor({
      qmList: vi.fn().mockResolvedValue("VMID NAME STATUS\n"),
    });
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 999,
    });
    expect(result.findings.classification).toBe("VM_MISSING");
  });
});
