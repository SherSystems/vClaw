import { describe, it, expect } from "vitest";
import {
  buildUpgradeApprovalBlocks,
  buildUpgradeApprovedBlocks,
  buildUpgradeProgressText,
  buildUpgradeRejectedBlocks,
  parseUpgradeActionValue,
  UPGRADE_ACTION_IDS,
} from "../../src/frontends/dashboard/upgrade-approval-blocks.js";
import type {
  HostUpgradeProgress,
  UpgradeEvent,
  UpgradePlan,
  UpgradeRun,
} from "../../src/orchestrator/types.js";

// ── Fixtures ─────────────────────────────────────────────────

function makePlan(overrides: Partial<UpgradePlan> = {}): UpgradePlan {
  return {
    id: "plan-01HFXYZ",
    clusterResourceId: "proxmox:proxmox_cluster:prod",
    sourceVersion: "8.0u2",
    targetVersion: "8.0u3",
    hostResourceIds: [
      "proxmox:host:esxi-01",
      "proxmox:host:esxi-02",
      "proxmox:host:esxi-03",
    ],
    evacuationMode: "live_migrate",
    createdAt: "2026-05-19T10:00:00Z",
    createdBy: "pranav@shersystems.com",
    ...overrides,
  };
}

function makeRun(overrides: Partial<UpgradeRun> = {}): UpgradeRun {
  return {
    id: "run-01HFXYZ-a",
    planId: "plan-01HFXYZ",
    phase: "approved",
    currentHostIndex: -1,
    hosts: [],
    startedAt: "2026-05-19T10:01:00Z",
    ...overrides,
  };
}

/**
 * Walk a Block-Kit array and collect every string value at any depth.
 * Used by the tests to assert "this text appears somewhere in the
 * rendered card" without locking the exact block layout.
 */
function collectStrings(blocks: unknown[]): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(blocks);
  return out;
}

function findBlock(blocks: unknown[], type: string): Record<string, unknown> | undefined {
  return blocks.find(
    (b): b is Record<string, unknown> =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === type,
  );
}

// ── Tests ────────────────────────────────────────────────────

describe("UPGRADE_ACTION_IDS", () => {
  it("exposes stable snake_case action_ids", () => {
    expect(UPGRADE_ACTION_IDS.APPROVE).toBe("upgrade_approve");
    expect(UPGRADE_ACTION_IDS.REJECT).toBe("upgrade_reject");
  });
});

describe("buildUpgradeApprovalBlocks", () => {
  it("returns a valid Block-Kit array with header + section + divider + actions", () => {
    const blocks = buildUpgradeApprovalBlocks(makePlan());
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(5);

    const header = findBlock(blocks, "header");
    expect(header).toBeDefined();
    expect((header as any).text.type).toBe("plain_text");

    expect(findBlock(blocks, "divider")).toBeDefined();

    const actions = findBlock(blocks, "actions") as any;
    expect(actions).toBeDefined();
    expect(Array.isArray(actions.elements)).toBe(true);
  });

  it("section text contains source→target version, cluster short name, host count", () => {
    const blocks = buildUpgradeApprovalBlocks(makePlan());
    const all = collectStrings(blocks).join("\n");
    expect(all).toContain("8.0u2");
    expect(all).toContain("8.0u3");
    expect(all).toContain("→");
    expect(all).toContain("prod"); // short cluster name
    expect(all).toContain("proxmox:proxmox_cluster:prod"); // full id also present
    // 3 hosts in fixture — appears as the *Hosts* count field
    expect(all).toMatch(/\*Hosts\*\n3/);
  });

  it("header includes the :gear: emoji and the short cluster name", () => {
    const blocks = buildUpgradeApprovalBlocks(makePlan());
    const header = findBlock(blocks, "header") as any;
    expect(header.text.text).toContain(":gear:");
    expect(header.text.text).toContain("prod");
  });

  it("actions block has exactly two buttons with correct action_ids and value=planId", () => {
    const plan = makePlan({ id: "plan-zzz" });
    const blocks = buildUpgradeApprovalBlocks(plan);
    const actions = findBlock(blocks, "actions") as any;

    expect(actions.elements).toHaveLength(2);

    const [approve, reject] = actions.elements;
    expect(approve.type).toBe("button");
    expect(approve.style).toBe("primary");
    expect(approve.action_id).toBe("upgrade_approve");
    expect(approve.value).toBe("plan-zzz");
    expect(approve.text.text).toBe("Approve");

    expect(reject.type).toBe("button");
    expect(reject.style).toBe("danger");
    expect(reject.action_id).toBe("upgrade_reject");
    expect(reject.value).toBe("plan-zzz");
    expect(reject.text.text).toBe("Reject");
  });

  it("approve button confirm.text is plain_text, NOT mrkdwn (Slack drops clicks silently otherwise)", () => {
    // Caught 2026-05-19 during the first end-to-end NUC demo: when
    // confirm.text was sent as `type: "mrkdwn"`, Slack rendered the
    // confirm modal with literal `*` and `\`` chars AND the modal's
    // Approve click never fired the interactivity callback. Slack's
    // docs are explicit: confirm dialog text MUST be plain_text.
    const blocks = buildUpgradeApprovalBlocks(makePlan());
    const actions = findBlock(blocks, "actions") as any;
    const approve = actions.elements[0];
    expect(approve.confirm).toBeDefined();
    expect(approve.confirm.title.type).toBe("plain_text");
    expect(approve.confirm.text.type).toBe("plain_text");
    expect(approve.confirm.confirm.type).toBe("plain_text");
    expect(approve.confirm.deny.type).toBe("plain_text");
    // And the rendered text must not contain mrkdwn markers — plain_text
    // would show the literal chars to the user.
    expect(approve.confirm.text.text).not.toContain("*");
    expect(approve.confirm.text.text).not.toContain("`");
  });

  it("caps long host list at 10 with +N more (total M) suffix", () => {
    const hostIds = Array.from({ length: 15 }, (_, i) => `proxmox:host:esxi-${i + 1}`);
    const blocks = buildUpgradeApprovalBlocks(makePlan({ hostResourceIds: hostIds }));
    const all = collectStrings(blocks).join("\n");

    // First 10 hosts present
    expect(all).toContain("esxi-1`");
    expect(all).toContain("esxi-10`");
    // 11th-15th NOT shown as bullet lines
    expect(all).not.toContain("esxi-11`");
    expect(all).not.toContain("esxi-15`");
    // Overflow line
    expect(all).toContain("+5 more");
    expect(all).toContain("total 15");
  });

  it("short cluster id without colons is rendered as-is", () => {
    const blocks = buildUpgradeApprovalBlocks(
      makePlan({ clusterResourceId: "cluster-a" }),
    );
    const header = findBlock(blocks, "header") as any;
    expect(header.text.text).toContain("cluster-a");
  });

  it("very long cluster name segment is truncated with an ellipsis", () => {
    const longSegment = "x".repeat(80);
    const blocks = buildUpgradeApprovalBlocks(
      makePlan({ clusterResourceId: `aws:eks_cluster:${longSegment}` }),
    );
    const header = findBlock(blocks, "header") as any;
    const headerText: string = header.text.text;
    // Truncated short name ends with the ellipsis char used by truncate()
    expect(headerText).toContain("…");
    // And is bounded by the 150-char header cap
    expect(headerText.length).toBeLessThanOrEqual(150);
  });

  it("omits context block when no dashboardBaseUrl is provided", () => {
    const blocks = buildUpgradeApprovalBlocks(makePlan());
    expect(findBlock(blocks, "context")).toBeUndefined();
  });

  it("includes context block with View plan link when dashboardBaseUrl is provided", () => {
    const blocks = buildUpgradeApprovalBlocks(makePlan({ id: "plan-xyz" }), {
      dashboardBaseUrl: "https://rhodes.example.com/",
    });
    const ctx = findBlock(blocks, "context") as any;
    expect(ctx).toBeDefined();
    const text = JSON.stringify(ctx);
    expect(text).toContain("View plan:");
    expect(text).toContain("https://rhodes.example.com/?plan=plan-xyz");
    expect(text).not.toContain("//?plan="); // trailing slash was stripped
  });

  it("stays well under Slack's 3000 char text limit even with 15 hosts", () => {
    const hostIds = Array.from({ length: 15 }, (_, i) => `proxmox:host:esxi-${i + 1}`);
    const blocks = buildUpgradeApprovalBlocks(makePlan({ hostResourceIds: hostIds }), {
      dashboardBaseUrl: "https://rhodes.example.com",
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized.length).toBeLessThan(3000);
  });
});

describe("buildUpgradeApprovedBlocks", () => {
  it("contains approver, run id, plan id, and the :white_check_mark: emoji", () => {
    const blocks = buildUpgradeApprovedBlocks(
      makePlan({ id: "plan-abc" }),
      makeRun({ id: "run-xyz", planId: "plan-abc" }),
      { approver: "pranav@shersystems.com" },
    );
    const all = collectStrings(blocks).join("\n");
    expect(all).toContain(":white_check_mark:");
    expect(all).toContain("pranav@shersystems.com");
    expect(all).toContain("run-xyz");
    expect(all).toContain("plan-abc");
  });

  it("appends dashboard link when dashboardBaseUrl is provided", () => {
    const blocks = buildUpgradeApprovedBlocks(
      makePlan({ id: "plan-abc" }),
      makeRun(),
      { approver: "op@x.com", dashboardBaseUrl: "https://r.example.com" },
    );
    expect(findBlock(blocks, "context")).toBeDefined();
    expect(JSON.stringify(blocks)).toContain("plan=plan-abc");
  });
});

describe("buildUpgradeRejectedBlocks", () => {
  it("contains the rejector name and the reason when provided", () => {
    const blocks = buildUpgradeRejectedBlocks(makePlan(), {
      rejector: "ops@shersystems.com",
      reason: "Capacity headroom too low — wait for the new NUC",
    });
    const all = collectStrings(blocks).join("\n");
    expect(all).toContain(":no_entry:");
    expect(all).toContain("ops@shersystems.com");
    expect(all).toContain("Capacity headroom too low");
  });

  it("works with no reason — only the rejector + plan id", () => {
    const blocks = buildUpgradeRejectedBlocks(makePlan({ id: "plan-noreason" }), {
      rejector: "ops@shersystems.com",
    });
    const all = collectStrings(blocks).join("\n");
    expect(all).toContain(":no_entry:");
    expect(all).toContain("ops@shersystems.com");
    expect(all).toContain("plan-noreason");
    expect(all).not.toContain("_reason_:");
  });

  it("empty/whitespace reason is treated as 'no reason'", () => {
    const blocks = buildUpgradeRejectedBlocks(makePlan(), {
      rejector: "ops@x.com",
      reason: "   ",
    });
    const all = collectStrings(blocks).join("\n");
    expect(all).not.toContain("_reason_:");
  });
});

describe("parseUpgradeActionValue", () => {
  it("returns { planId } for a simple plan id value (happy path)", () => {
    expect(parseUpgradeActionValue("plan-abc")).toEqual({ planId: "plan-abc" });
  });

  it("trims surrounding whitespace before returning", () => {
    expect(parseUpgradeActionValue("  plan-abc \n")).toEqual({ planId: "plan-abc" });
  });

  it("throws on empty string", () => {
    expect(() => parseUpgradeActionValue("")).toThrow(/empty/);
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseUpgradeActionValue("   ")).toThrow(/empty/);
  });

  it("throws on values longer than 200 chars", () => {
    const tooLong = "x".repeat(201);
    expect(() => parseUpgradeActionValue(tooLong)).toThrow(/too long/);
  });

  it("throws clearly on non-string input", () => {
    // @ts-expect-error — intentional: simulate runtime garbage
    expect(() => parseUpgradeActionValue(null)).toThrow(/string/);
  });
});

describe("buildUpgradeProgressText (v0.7.3.1)", () => {
  function host(
    id: string,
    state: HostUpgradeProgress["state"],
    extra: Partial<HostUpgradeProgress> = {},
  ): HostUpgradeProgress {
    return { hostResourceId: id, state, ...extra };
  }

  const AT = "2026-05-19T10:05:00Z";

  it("preflight → executing emits 'preflight passed' + first host start", () => {
    const plan = makePlan();
    const prev = makeRun({ phase: "preflight", currentHostIndex: -1, hosts: [] });
    const next = makeRun({
      phase: "executing",
      currentHostIndex: 0,
      hosts: [
        host("proxmox:host:esxi-01", "entering_maintenance"),
        host("proxmox:host:esxi-02", "pending"),
        host("proxmox:host:esxi-03", "pending"),
      ],
    });
    const event: UpgradeEvent = { kind: "preflight_succeeded", at: AT };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).not.toBeNull();
    expect(msg).toContain("Preflight passed");
    expect(msg).toContain("esxi-01");
    expect(msg).toContain("1/3");
  });

  it("same host advances sub-state — emits one wrench line with new sub-state", () => {
    const plan = makePlan();
    const prev = makeRun({
      phase: "executing",
      currentHostIndex: 0,
      hosts: [
        host("proxmox:host:esxi-01", "entering_maintenance"),
        host("proxmox:host:esxi-02", "pending"),
        host("proxmox:host:esxi-03", "pending"),
      ],
    });
    const next = makeRun({
      ...prev,
      hosts: [
        host("proxmox:host:esxi-01", "evacuating"),
        host("proxmox:host:esxi-02", "pending"),
        host("proxmox:host:esxi-03", "pending"),
      ],
    });
    const event: UpgradeEvent = { kind: "host_step_succeeded", at: AT };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).toContain(":wrench:");
    expect(msg).toContain("esxi-01");
    expect(msg).toContain("evacuating");
    expect(msg).toContain("1/3");
  });

  it("host advances to next host — emits both 'done' for prior + 'starting' for next", () => {
    const plan = makePlan();
    const prev = makeRun({
      phase: "executing",
      currentHostIndex: 0,
      hosts: [
        host("proxmox:host:esxi-01", "exiting_maintenance"),
        host("proxmox:host:esxi-02", "pending"),
        host("proxmox:host:esxi-03", "pending"),
      ],
    });
    const next = makeRun({
      ...prev,
      currentHostIndex: 1,
      hosts: [
        host("proxmox:host:esxi-01", "completed"),
        host("proxmox:host:esxi-02", "entering_maintenance"),
        host("proxmox:host:esxi-03", "pending"),
      ],
    });
    const event: UpgradeEvent = { kind: "host_step_succeeded", at: AT };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).not.toBeNull();
    expect(msg).toContain("esxi-01"); // prior done
    expect(msg).toContain("esxi-02"); // next starting
    expect(msg).toContain("1/3 complete");
    expect(msg).toContain("2/3 starting");
    expect(msg).toContain("entering maintenance");
  });

  it("host_step_failed emits red-X with host + reason", () => {
    const plan = makePlan();
    const prev = makeRun({
      phase: "executing",
      currentHostIndex: 1,
      hosts: [
        host("proxmox:host:esxi-01", "completed"),
        host("proxmox:host:esxi-02", "remediating"),
        host("proxmox:host:esxi-03", "pending"),
      ],
    });
    const next = makeRun({
      ...prev,
      hosts: [
        host("proxmox:host:esxi-01", "completed"),
        host("proxmox:host:esxi-02", "failed", { errorMessage: "image not found" }),
        host("proxmox:host:esxi-03", "pending"),
      ],
    });
    const event: UpgradeEvent = {
      kind: "host_step_failed",
      reason: "image not found",
      at: AT,
    };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).toContain(":x:");
    expect(msg).toContain("esxi-02");
    expect(msg).toContain("image not found");
    expect(msg).toContain("2/3");
  });

  it("executing → rolling_back emits hook emoji + reason", () => {
    const plan = makePlan();
    const prev = makeRun({ phase: "executing", currentHostIndex: 1, hosts: [] });
    const next = makeRun({
      phase: "rolling_back",
      currentHostIndex: 1,
      hosts: [],
      errorMessage: "host[1]: image not found",
    });
    const event: UpgradeEvent = {
      kind: "host_step_failed",
      reason: "image not found",
      at: AT,
    };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).toContain(":leftwards_arrow_with_hook:");
    expect(msg).toContain("Rolling back");
    expect(msg).toContain("image not found");
  });

  it("→ completed emits :tada: with target version + host count", () => {
    const plan = makePlan();
    const prev = makeRun({ phase: "executing", currentHostIndex: 2 });
    const next = makeRun({
      phase: "completed",
      currentHostIndex: 3,
      hosts: [],
      completedAt: AT,
    });
    const event: UpgradeEvent = { kind: "host_step_succeeded", at: AT };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).toContain(":tada:");
    expect(msg).toContain("8.0u3");
    expect(msg).toContain("3/3");
    expect(msg).toContain("prod");
  });

  it("→ failed (from rolling_back) emits :x: with errorMessage", () => {
    const plan = makePlan();
    const prev = makeRun({ phase: "rolling_back", currentHostIndex: 1 });
    const next = makeRun({
      phase: "failed",
      currentHostIndex: 1,
      hosts: [],
      errorMessage: "host[1]: image not found; rollback also failed: snapshot revert failed",
    });
    const event: UpgradeEvent = { kind: "rollback_failed", reason: "snapshot revert failed", at: AT };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).toContain(":x:");
    expect(msg).toContain("Upgrade failed");
    expect(msg).toContain("snapshot revert failed");
  });

  it("preflight_failed → failed (no host loop entered) emits :x:", () => {
    const plan = makePlan();
    const prev = makeRun({ phase: "preflight", currentHostIndex: -1 });
    const next = makeRun({
      phase: "failed",
      currentHostIndex: -1,
      hosts: [],
      errorMessage: "preflight: cluster lacks N-1 capacity",
    });
    const event: UpgradeEvent = {
      kind: "preflight_failed",
      reason: "cluster lacks N-1 capacity",
      at: AT,
    };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).toContain(":x:");
    expect(msg).toContain("cluster lacks N-1 capacity");
  });

  it("returns null when phase unchanged and event isn't a host step", () => {
    const plan = makePlan();
    const prev = makeRun({ phase: "executing", currentHostIndex: 0 });
    const next = makeRun({ ...prev });
    // Synthetic event that won't trigger any branch
    const event: UpgradeEvent = { kind: "approve", actor: "x", at: AT };
    const msg = buildUpgradeProgressText(prev, next, event, plan);
    expect(msg).toBeNull();
  });

  it("escapes mrkdwn-special chars in error messages", () => {
    const plan = makePlan();
    const prev = makeRun({ phase: "executing", currentHostIndex: 0 });
    const next = makeRun({
      phase: "failed",
      currentHostIndex: 0,
      errorMessage: "exit code <127> from /usr/bin/foo & bar",
    });
    const event: UpgradeEvent = { kind: "host_step_failed", reason: "x", at: AT };
    const msg = buildUpgradeProgressText(prev, next, event, plan)!;
    expect(msg).not.toContain("<127>");
    expect(msg).toContain("&lt;127&gt;");
    expect(msg).toContain("&amp;");
  });
});
