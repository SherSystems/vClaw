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
  filterDeletableCandidates,
  findPreviousSafetySnapshot,
  validateRemediationCandidate,
  buildRemediationPlan,
  runProxmoxStoragePausePlaybook,
  PLAYBOOK_ACTION_TIERS,
  THIN_POOL_PAUSE_RISK_PCT,
  RHODES_SAFETY_SNAPSHOT_PREFIX,
  SNAPSHOT_RETENTION_FLOOR,
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

  it("emits qm delsnapshot commands at risky_write tier (with safety snap prepended)", () => {
    const plan = buildRemediationPlan({
      vmid: 201,
      thin_pool: "data",
      current_data_pct: 90,
      candidates,
      pool_size_bytes: 1000 * 1024 ** 3,
    });
    // 1 safety-snap (prepended) + 2 delsnapshot steps = 3 total.
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].kind).toBe("take_safety_snapshot");
    expect(plan.steps[0].tier).toBe("safe_write");
    expect(plan.steps[0].command).toMatch(
      new RegExp(`^qm snapshot 201 ${RHODES_SAFETY_SNAPSHOT_PREFIX}`),
    );
    expect(plan.steps[1].command).toBe(
      "qm delsnapshot 201 autosnap_2026-01-15_03_00_00",
    );
    expect(plan.steps[1].tier).toBe("risky_write");
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
    qmTakeSnapshot: vi.fn().mockResolvedValue({ ok: true }),
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
    // 1 safety-snap (always first) + 1 delete (then lvs reports 78% <
    // target 80% so loop exits) = 2 executed steps.
    expect(result.executed_steps).toHaveLength(2);
    expect(result.executed_steps[0].kind).toBe("take_safety_snapshot");
    expect(result.executed_steps[1].kind ?? "delete_snapshot").toBe(
      "delete_snapshot",
    );
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

// ── Retention Floor ───────────────────────────────────────

describe("filterDeletableCandidates (retention floor)", () => {
  it("exposes a retention floor constant of 1", () => {
    expect(SNAPSHOT_RETENTION_FLOOR).toBe(1);
  });

  it("excludes the newest non-current snapshot from candidates", () => {
    const notes: string[] = [];
    const ranked: SnapshotCandidate[] = [
      {
        vmid: 201,
        name: "old_snap",
        created_at: "2026-01-01T00:00:00Z",
        reasons: [],
        rank: -1,
      },
      {
        vmid: 201,
        name: "new_snap",
        created_at: "2026-05-01T00:00:00Z",
        reasons: [],
        rank: 0,
      },
    ];
    const filtered = filterDeletableCandidates(ranked, notes);
    expect(filtered.map((c) => c.name)).toEqual(["old_snap"]);
    expect(notes.join("\n")).toMatch(
      /Excluded new_snap.*retention floor=1/,
    );
  });

  it("returns empty when only one snapshot exists (never prunes to zero)", () => {
    const notes: string[] = [];
    const filtered = filterDeletableCandidates(
      [
        {
          vmid: 201,
          name: "lonely",
          created_at: "2026-04-01T00:00:00Z",
          reasons: [],
          rank: 0,
        },
      ],
      notes,
    );
    expect(filtered).toHaveLength(0);
    expect(notes[0]).toMatch(/Excluded lonely.*retention floor=1/);
  });

  it("treats entries without created_at as oldest", () => {
    const ranked: SnapshotCandidate[] = [
      { vmid: 201, name: "no_ts_a", reasons: [], rank: 0 },
      {
        vmid: 201,
        name: "with_ts",
        created_at: "2026-04-01T00:00:00Z",
        reasons: [],
        rank: -1,
      },
      { vmid: 201, name: "no_ts_b", reasons: [], rank: 0 },
    ];
    const filtered = filterDeletableCandidates(ranked);
    // with_ts is the newest by created_at → excluded.
    expect(filtered.map((c) => c.name)).toEqual(["no_ts_a", "no_ts_b"]);
  });

  it("rankSnapshotsForDeletion only applies the floor when opted-in", () => {
    const notes: string[] = [];
    const snaps = [
      {
        vmid: 201,
        name: "first",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        vmid: 201,
        name: "second",
        created_at: "2026-04-01T00:00:00Z",
      },
    ];
    // Default: observer mode — both snapshots remain.
    expect(
      rankSnapshotsForDeletion(snaps).map((c) => c.name).sort(),
    ).toEqual(["first", "second"]);

    // Opt-in: floor applied, second excluded.
    const withFloor = rankSnapshotsForDeletion(snaps, {
      apply_retention_floor: true,
      notes,
    });
    expect(withFloor.map((c) => c.name)).toEqual(["first"]);
    expect(notes.join("\n")).toMatch(/Excluded second.*retention floor=1/);
  });
});

// ── Safety-Snap Discovery ─────────────────────────────────

describe("findPreviousSafetySnapshot", () => {
  it("returns the newest rhodes-safety-* snapshot", () => {
    const prior = findPreviousSafetySnapshot([
      {
        vmid: 201,
        name: "rhodes-safety-2026-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        vmid: 201,
        name: "rhodes-safety-2026-04-01T00:00:00.000Z",
        created_at: "2026-04-01T00:00:00Z",
      },
      { vmid: 201, name: "autosnap_x" },
    ]);
    expect(prior?.name).toBe("rhodes-safety-2026-04-01T00:00:00.000Z");
  });

  it("returns undefined when none present", () => {
    expect(
      findPreviousSafetySnapshot([
        { vmid: 201, name: "autosnap_x" },
        { vmid: 201, name: "pre-reboot" },
      ]),
    ).toBeUndefined();
  });
});

// ── Plan builder: retention floor + safety-snap lifecycle ─

describe("buildRemediationPlan — retention floor + safety snapshots", () => {
  it("retention floor: with 1 input candidate the plan has 0 delete steps + notes mention retention", () => {
    const notes: string[] = [];
    const candidates = rankSnapshotsForDeletion(
      [
        {
          vmid: 201,
          name: "lone-snap",
          created_at: "2026-04-01T00:00:00Z",
          estimated_bytes: 10 * 1024 ** 3,
        },
      ],
      { apply_retention_floor: true, notes },
    );
    expect(candidates).toHaveLength(0);
    const plan = buildRemediationPlan({
      vmid: 201,
      thin_pool: "data",
      current_data_pct: 96,
      candidates,
      pool_size_bytes: 1000 * 1024 ** 3,
    });
    expect(
      plan.steps.filter((s) => s.kind === "delete_snapshot"),
    ).toHaveLength(0);
    // No deletes → no safety-snap prepended either.
    expect(plan.steps).toHaveLength(0);
    expect(notes.join("\n")).toMatch(/retention floor=1/);
    expect(notes.join("\n")).toMatch(/lone-snap/);
  });

  it("retention floor: with 3 input candidates plan keeps newest, deletes 2, with safety-snap prepended", () => {
    const notes: string[] = [];
    const candidates = rankSnapshotsForDeletion(
      [
        {
          vmid: 201,
          name: "oldest",
          created_at: "2026-01-01T00:00:00Z",
          estimated_bytes: 80 * 1024 ** 3,
        },
        {
          vmid: 201,
          name: "middle",
          created_at: "2026-03-01T00:00:00Z",
          estimated_bytes: 80 * 1024 ** 3,
        },
        {
          vmid: 201,
          name: "newest",
          created_at: "2026-05-01T00:00:00Z",
          estimated_bytes: 80 * 1024 ** 3,
        },
      ],
      { apply_retention_floor: true, notes },
    );
    // Newest excluded by retention floor → 2 candidates.
    expect(candidates.map((c) => c.name).sort()).toEqual(["middle", "oldest"]);
    expect(notes.join("\n")).toMatch(/Excluded newest.*retention floor=1/);

    const plan = buildRemediationPlan({
      vmid: 201,
      thin_pool: "data",
      current_data_pct: 96,
      candidates,
      pool_size_bytes: 1000 * 1024 ** 3,
    });
    const deletes = plan.steps.filter((s) => s.kind === "delete_snapshot");
    expect(deletes).toHaveLength(2);
    // Safety snap is the FIRST step.
    expect(plan.steps[0].kind).toBe("take_safety_snapshot");
    expect(plan.steps[0].command).toMatch(
      new RegExp(`^qm snapshot 201 ${RHODES_SAFETY_SNAPSHOT_PREFIX}`),
    );
    // Newest must not appear among delete candidates.
    expect(deletes.find((s) => s.snapname === "newest")).toBeUndefined();
  });

  it("appends a cleanup step for the previous safety snapshot when one exists", () => {
    const prior = {
      vmid: 201,
      name: "rhodes-safety-2026-05-01T00:00:00.000Z",
      created_at: "2026-05-01T00:00:00Z",
    };
    const plan = buildRemediationPlan({
      vmid: 201,
      thin_pool: "data",
      current_data_pct: 96,
      candidates: [
        {
          vmid: 201,
          name: "autosnap_old",
          reasons: ["crash-recovery snapshot"],
          rank: -1,
          estimated_bytes: 50 * 1024 ** 3,
        },
      ],
      pool_size_bytes: 1000 * 1024 ** 3,
      previous_safety_snapshot: prior,
    });
    const last = plan.steps[plan.steps.length - 1];
    expect(last.kind).toBe("cleanup_prior_safety_snapshot");
    expect(last.snapname).toBe(prior.name);
    expect(last.command).toBe(`qm delsnapshot 201 ${prior.name}`);
  });

  it("does NOT append a cleanup step when no previous safety snapshot exists", () => {
    const plan = buildRemediationPlan({
      vmid: 201,
      thin_pool: "data",
      current_data_pct: 96,
      candidates: [
        {
          vmid: 201,
          name: "autosnap_old",
          reasons: [],
          rank: -1,
          estimated_bytes: 50 * 1024 ** 3,
        },
      ],
      pool_size_bytes: 1000 * 1024 ** 3,
    });
    expect(
      plan.steps.find((s) => s.kind === "cleanup_prior_safety_snapshot"),
    ).toBeUndefined();
  });
});

// ── Hard rule: rhodes-safety-* snapshots ──────────────────

describe("validateRemediationCandidate — rhodes-safety-* hard rule", () => {
  it("rejects qm delsnapshot of a rhodes-safety-* snapshot without cleanup flag", () => {
    const name = "rhodes-safety-2026-05-13T03:00:00Z";
    const result = validateRemediationCandidate({
      command: `qm delsnapshot 201 ${name}`,
      target: name,
    });
    expect(result).toMatch(/rhodes-safety-\* snapshots can only be deleted/);
  });

  it("rejects when allow_safety_cleanup is the WRONG name", () => {
    const name = "rhodes-safety-2026-05-13T03:00:00Z";
    expect(
      validateRemediationCandidate({
        command: `qm delsnapshot 201 ${name}`,
        target: name,
        allow_safety_cleanup: "rhodes-safety-2099-01-01T00:00:00Z",
      }),
    ).toMatch(/rhodes-safety-\*/);
  });

  it("ALLOWS delete when allow_safety_cleanup matches exactly", () => {
    const name = "rhodes-safety-2026-05-13T03:00:00Z";
    expect(
      validateRemediationCandidate({
        command: `qm delsnapshot 201 ${name}`,
        target: name,
        allow_safety_cleanup: name,
      }),
    ).toBeNull();
  });

  it("ALLOWS qm snapshot to CREATE a rhodes-safety-* (never the create path)", () => {
    const name = "rhodes-safety-2026-05-13T03:00:00Z";
    expect(
      validateRemediationCandidate({
        command: `qm snapshot 201 ${name}`,
        target: name,
      }),
    ).toBeNull();
  });
});

// ── End-to-end: safety-snapshot lifecycle ────────────────

const LVS_WITH_PRIOR_SAFETY_OUT = [
  "data,pve,twi-aotz--,1099511627776,96.40,15.20,,",
  "vm-201-disk-0,pve,Vwi-aotz--,137438953472,,,data,",
  "snap_vm-201-disk-0_autosnap_2026-01-15_03_00_00,pve,Vwi-aotz--,80530636800,,,data,",
  "snap_vm-201-disk-0_pre-reboot,pve,Vwi-aotz--,53687091200,,,data,",
  // Prior safety snapshot left over from a previous remediation run.
  "snap_vm-201-disk-0_rhodes-safety-2026-04-01T00_00_00.000Z,pve,Vwi-aotz--,21474836480,,,data,",
].join("\n");

const LVS_AFTER_DROP_OUT = [
  "data,pve,twi-aotz--,1099511627776,78.10,12.00,,",
  "vm-201-disk-0,pve,Vwi-aotz--,137438953472,,,data,",
].join("\n");

const QM_LISTSNAPSHOT_WITH_PRIOR_SAFETY = `
\`-> autosnap_2026-01-15_03_00_00         autosnapshot
 \`-> pre-reboot                            before kernel upgrade
 \`-> rhodes-safety-2026-04-01T00_00_00.000Z  RHODES pre-remediation safety snapshot
 \`-> current                              You are here!
`;

describe("runProxmoxStoragePausePlaybook — safety snapshot lifecycle", () => {
  it("safety-snap prepended: first executed step is `qm snapshot` with rhodes-safety- prefix", async () => {
    const executor = makeExecutor();
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
      approve_plan: async () => true,
    });
    expect(result.executed_steps.length).toBeGreaterThan(0);
    const first = result.executed_steps[0];
    expect(first.kind).toBe("take_safety_snapshot");
    expect(first.command).toMatch(
      new RegExp(`^qm snapshot 201 ${RHODES_SAFETY_SNAPSHOT_PREFIX}`),
    );
    expect(executor.qmTakeSnapshot).toHaveBeenCalledOnce();
  });

  it("previous safety snap cleanup runs ONLY after successful resume", async () => {
    const executor = makeExecutor({
      lvs: vi
        .fn()
        .mockResolvedValueOnce(LVS_WITH_PRIOR_SAFETY_OUT)
        .mockResolvedValue(LVS_AFTER_DROP_OUT),
      qmListSnapshot: vi
        .fn()
        .mockResolvedValue(QM_LISTSNAPSHOT_WITH_PRIOR_SAFETY),
    });
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
      approve_plan: async () => true,
    });
    expect(result.resumed).toBe(true);
    // Cleanup must appear in executed steps.
    const cleanup = result.executed_steps.find(
      (s) => s.kind === "cleanup_prior_safety_snapshot",
    );
    expect(cleanup).toBeDefined();
    expect(cleanup!.snapname).toBe(
      "rhodes-safety-2026-04-01T00_00_00.000Z",
    );
    // The LAST qmDelSnapshot call targets the prior safety snapshot.
    const calls = (executor.qmDelSnapshot as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls[calls.length - 1]).toEqual([
      "pve1",
      201,
      "rhodes-safety-2026-04-01T00_00_00.000Z",
    ]);
    // qmResume was called before the cleanup.
    expect(
      (executor.qmResume as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });

  it("failed resume → previous safety snap is PRESERVED (no cleanup delete)", async () => {
    const qmDelSnapshot = vi
      .fn()
      .mockResolvedValue({ ok: true, bytes_freed: 80 * 1024 ** 3 });
    const executor = makeExecutor({
      lvs: vi
        .fn()
        .mockResolvedValueOnce(LVS_WITH_PRIOR_SAFETY_OUT)
        .mockResolvedValue(LVS_AFTER_DROP_OUT),
      qmListSnapshot: vi
        .fn()
        .mockResolvedValue(QM_LISTSNAPSHOT_WITH_PRIOR_SAFETY),
      qmResume: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "still paused" }),
      qmStatus: vi.fn().mockResolvedValue("status: paused"),
      qmDelSnapshot,
    });
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
      approve_plan: async () => true,
    });
    expect(result.resumed).toBe(false);
    // No cleanup step should have been executed.
    expect(
      result.executed_steps.find(
        (s) => s.kind === "cleanup_prior_safety_snapshot",
      ),
    ).toBeUndefined();
    // No qmDelSnapshot call should have targeted the prior safety snap.
    const targetedPrior = qmDelSnapshot.mock.calls.some(
      (c) => c[2] === "rhodes-safety-2026-04-01T00_00_00.000Z",
    );
    expect(targetedPrior).toBe(false);
    // The note explicitly mentions preservation.
    expect(result.findings.notes.join("\n")).toMatch(
      /preserving previous safety snapshot/,
    );
  });

  it("aborts before any delete if taking the safety snapshot fails", async () => {
    const qmDelSnapshot = vi
      .fn()
      .mockResolvedValue({ ok: true, bytes_freed: 80 * 1024 ** 3 });
    const executor = makeExecutor({
      qmTakeSnapshot: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "disk full" }),
      qmDelSnapshot,
    });
    const result = await runProxmoxStoragePausePlaybook(executor, {
      node: "pve1",
      vmid: 201,
      approve_plan: async () => true,
    });
    expect(qmDelSnapshot).not.toHaveBeenCalled();
    expect(executor.qmResume).not.toHaveBeenCalled();
    expect(result.findings.notes.join("\n")).toMatch(
      /Failed to take safety snapshot/,
    );
  });
});
