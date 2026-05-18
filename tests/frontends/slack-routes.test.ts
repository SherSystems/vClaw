import { describe, it, expect, vi } from "vitest";
import {
  createSlackRouter,
  parseSubcommand,
  stripLeadingMention,
  buildHelpBlocks,
  buildStatusBlocks,
  buildIncidentsBlocks,
  buildApprovalsBlocks,
  type SlackRoutesContext,
} from "../../src/frontends/dashboard/slack-routes";

// ── Test fixtures ─────────────────────────────────────────────

function makeFormReq(body: Record<string, string>) {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const encoded = new URLSearchParams(body).toString();
  const req = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    on(event: string, cb: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return this;
    },
  } as any;
  // Flush asynchronously so the handler attaches listeners first.
  queueMicrotask(() => {
    for (const cb of listeners.data ?? []) cb(Buffer.from(encoded));
    for (const cb of listeners.end ?? []) cb();
  });
  return req;
}

function makeJsonReq(body: unknown) {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const encoded = JSON.stringify(body);
  const req = {
    method: "POST",
    headers: { "content-type": "application/json" },
    on(event: string, cb: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return this;
    },
  } as any;
  queueMicrotask(() => {
    for (const cb of listeners.data ?? []) cb(Buffer.from(encoded));
    for (const cb of listeners.end ?? []) cb();
  });
  return req;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body: unknown;
  return {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, next?: Record<string, string>) {
      statusCode = code;
      if (next) for (const [k, v] of Object.entries(next)) headers[k.toLowerCase()] = v;
    },
    end(chunk?: unknown) {
      body = chunk;
    },
    getStatusCode() { return statusCode; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    getBody() { return body; },
    getJson() {
      try { return JSON.parse(String(body ?? "")); } catch { return null; }
    },
  };
}

function makeCtx(overrides: Partial<SlackRoutesContext> = {}): SlackRoutesContext {
  return {
    getHealthz: vi.fn(() => ({
      version: "0.4.7",
      uptime_s: 3661,
      dry_run: false,
      open_incidents: 0,
      registered_playbooks: 5,
    })),
    getOpenIncidents: vi.fn(() => []),
    getPendingApprovals: vi.fn(() => []),
    runAgentCommand: vi.fn(async () => ({ ok: true })),
    submitApprovalDecision: vi.fn(() => ({ ok: true })),
    ...overrides,
  };
}

// ── parseSubcommand ───────────────────────────────────────────

describe("parseSubcommand", () => {
  it("treats empty text as help", () => {
    expect(parseSubcommand("")).toEqual({ kind: "help" });
    expect(parseSubcommand("   ")).toEqual({ kind: "help" });
  });

  it("recognizes named subcommands case-insensitively", () => {
    expect(parseSubcommand("status")).toEqual({ kind: "status" });
    expect(parseSubcommand("STATUS")).toEqual({ kind: "status" });
    expect(parseSubcommand("incidents")).toEqual({ kind: "incidents" });
    expect(parseSubcommand("approvals")).toEqual({ kind: "approvals" });
  });

  it("parses investigate with a target", () => {
    expect(parseSubcommand("investigate 200")).toEqual({ kind: "investigate", target: "200" });
    expect(parseSubcommand("investigate web-prod-01")).toEqual({
      kind: "investigate",
      target: "web-prod-01",
    });
  });

  it("falls back to help when investigate has no target", () => {
    expect(parseSubcommand("investigate")).toEqual({ kind: "help" });
    expect(parseSubcommand("investigate   ")).toEqual({ kind: "help" });
  });

  it("treats anything else as freeform", () => {
    expect(parseSubcommand("why is web-01 slow?")).toEqual({
      kind: "freeform",
      text: "why is web-01 slow?",
    });
  });

  // v0.7.2.2 — /rhodes upgrade subcommand
  it("parses upgrade with just a cluster id", () => {
    expect(parseSubcommand("upgrade proxmox:proxmox_cluster:prod")).toEqual({
      kind: "upgrade",
      clusterId: "proxmox:proxmox_cluster:prod",
      targetVersion: undefined,
    });
  });

  it("parses upgrade with `to <version>` clause", () => {
    expect(
      parseSubcommand("upgrade proxmox:proxmox_cluster:prod to 8.0u3"),
    ).toEqual({
      kind: "upgrade",
      clusterId: "proxmox:proxmox_cluster:prod",
      targetVersion: "8.0u3",
    });
  });

  it("accepts multi-token target version after `to`", () => {
    expect(parseSubcommand("upgrade c1 to PVE 8.2")).toEqual({
      kind: "upgrade",
      clusterId: "c1",
      targetVersion: "PVE 8.2",
    });
  });

  it("returns upgrade_help when no cluster id supplied", () => {
    expect(parseSubcommand("upgrade")).toEqual({ kind: "upgrade_help" });
    expect(parseSubcommand("upgrade   ")).toEqual({ kind: "upgrade_help" });
  });

  it("is case-insensitive on the verb but preserves case in cluster id and version", () => {
    expect(parseSubcommand("UPGRADE MyCluster TO 8.0")).toEqual({
      kind: "upgrade",
      clusterId: "MyCluster",
      targetVersion: "8.0",
    });
  });
});

// ── stripLeadingMention ───────────────────────────────────────

describe("stripLeadingMention", () => {
  it("strips a Slack-style leading user mention", () => {
    expect(stripLeadingMention("<@UABC123> investigate vmid 200")).toBe(
      "investigate vmid 200",
    );
  });
  it("returns the input untouched when there is no leading mention", () => {
    expect(stripLeadingMention("hello world")).toBe("hello world");
  });
  it("trims whitespace around the mention", () => {
    expect(stripLeadingMention("   <@U12345>    hi  ")).toBe("hi");
  });
});

// ── Slash command handler ─────────────────────────────────────

describe("handleSlackCommand", () => {
  it("returns help Block Kit when text is empty", async () => {
    const ctx = makeCtx();
    const router = createSlackRouter(ctx);
    const req = makeFormReq({ command: "/rhodes", text: "", user_id: "U1", channel_id: "C1" });
    const res = makeRes();
    await router.handleSlackCommand(req, res as any);

    expect(res.getStatusCode()).toBe(200);
    const payload = res.getJson();
    expect(payload.response_type).toBe("ephemeral");
    expect(payload.blocks).toEqual(buildHelpBlocks());
  });

  it("returns status Block Kit with healthz fields", async () => {
    const getHealthz = vi.fn(() => ({
      version: "9.9.9",
      uptime_s: 90061,
      dry_run: true,
      open_incidents: 3,
      registered_playbooks: 7,
    }));
    const ctx = makeCtx({ getHealthz });
    const router = createSlackRouter(ctx);
    const req = makeFormReq({ command: "/rhodes", text: "status", user_id: "U1", channel_id: "C1" });
    const res = makeRes();
    await router.handleSlackCommand(req, res as any);

    expect(res.getStatusCode()).toBe(200);
    expect(getHealthz).toHaveBeenCalledTimes(1);
    const payload = res.getJson();
    expect(payload.blocks).toEqual(buildStatusBlocks(getHealthz.mock.results[0].value as Record<string, unknown>));
    // Sanity: the rendered Block Kit references the version we provided.
    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).toContain("9.9.9");
    expect(serialized).toContain("shadow (dry-run)");
    expect(serialized).toContain("3");
    expect(serialized).toContain("7");
  });

  it("fires agent command and returns Planning placeholder for investigate <vmid>", async () => {
    const runAgentCommand = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx({ runAgentCommand });
    const router = createSlackRouter(ctx);
    const req = makeFormReq({
      command: "/rhodes",
      text: "investigate 200",
      user_id: "U7",
      channel_id: "C42",
    });
    const res = makeRes();
    await router.handleSlackCommand(req, res as any);

    // Microtask: void runAgentSafely() is dispatched but not awaited.
    await new Promise((r) => setTimeout(r, 0));

    expect(runAgentCommand).toHaveBeenCalledTimes(1);
    const [prompt, meta] = runAgentCommand.mock.calls[0];
    expect(prompt).toMatch(/Investigate VM 200/);
    expect(meta).toMatchObject({ source: "slack", slack_user_id: "U7", slack_channel: "C42" });

    expect(res.getStatusCode()).toBe(200);
    const payload = res.getJson();
    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).toContain(":thinking_face:");
    expect(serialized).toContain("Planning");
    expect(serialized).toContain("VM `200`");
  });

  it("fires freeform agent command for unrecognized verbs", async () => {
    const runAgentCommand = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx({ runAgentCommand });
    const router = createSlackRouter(ctx);
    const req = makeFormReq({
      command: "/rhodes",
      text: "why is web-01 throwing 503s?",
      user_id: "U9",
      channel_id: "C9",
    });
    const res = makeRes();
    await router.handleSlackCommand(req, res as any);
    await new Promise((r) => setTimeout(r, 0));

    expect(runAgentCommand).toHaveBeenCalledTimes(1);
    expect(runAgentCommand.mock.calls[0][0]).toBe("why is web-01 throwing 503s?");
    expect(res.getStatusCode()).toBe(200);
  });

  it("returns incidents Block Kit with one item per open incident", async () => {
    const getOpenIncidents = vi.fn(() => [
      { id: "inc-1", severity: "critical", description: "node down", detected_at: "2026-05-15T00:00:00Z" },
    ]);
    const ctx = makeCtx({ getOpenIncidents });
    const router = createSlackRouter(ctx);
    const req = makeFormReq({ command: "/rhodes", text: "incidents", user_id: "U1", channel_id: "C1" });
    const res = makeRes();
    await router.handleSlackCommand(req, res as any);

    expect(res.getStatusCode()).toBe(200);
    const payload = res.getJson();
    expect(payload.blocks).toEqual(buildIncidentsBlocks(getOpenIncidents.mock.results[0].value as Array<{ id: string; severity: string; description: string; detected_at: string }>));
    expect(JSON.stringify(payload.blocks)).toContain("inc-1");
  });

  it("returns approvals Block Kit with approve/reject buttons", async () => {
    const getPendingApprovals = vi.fn(() => [
      {
        plan_id: "plan-abc",
        action: "restart_vm",
        tier: "destructive",
        requested_at: "2026-05-15T00:00:00Z",
        reasoning: "VM is unresponsive",
      },
    ]);
    const ctx = makeCtx({ getPendingApprovals });
    const router = createSlackRouter(ctx);
    const req = makeFormReq({ command: "/rhodes", text: "approvals", user_id: "U1", channel_id: "C1" });
    const res = makeRes();
    await router.handleSlackCommand(req, res as any);

    expect(res.getStatusCode()).toBe(200);
    const payload = res.getJson();
    expect(payload.blocks).toEqual(buildApprovalsBlocks(getPendingApprovals.mock.results[0].value as Array<{
      plan_id: string;
      step_id?: string;
      action: string;
      tier: string;
      requested_at: string;
      reasoning: string;
    }>));
    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).toContain("plan-abc");
    expect(serialized).toContain("rhodes_approve");
    expect(serialized).toContain("rhodes_reject");
  });
});

// ── Interactivity handler ─────────────────────────────────────

describe("handleSlackInteract", () => {
  it("calls submitApprovalDecision for rhodes_approve action and returns ephemeral confirmation", async () => {
    const submitApprovalDecision = vi.fn(() => ({ ok: true }));
    const ctx = makeCtx({ submitApprovalDecision });
    const router = createSlackRouter(ctx);

    const payload = {
      type: "block_actions",
      user: { id: "USLACK1" },
      team: { id: "T1" },
      actions: [
        {
          action_id: "rhodes_approve",
          value: JSON.stringify({ plan_id: "plan-77", step_id: "step-3" }),
          type: "button",
        },
      ],
    };
    const req = makeFormReq({ payload: JSON.stringify(payload) });
    const res = makeRes();
    await router.handleSlackInteract(req, res as any);

    expect(submitApprovalDecision).toHaveBeenCalledWith(
      "plan-77",
      "approve",
      "slack:USLACK1",
      "step-3",
    );
    expect(res.getStatusCode()).toBe(200);
    const reply = res.getJson();
    expect(JSON.stringify(reply.blocks)).toContain("Approved");
    expect(JSON.stringify(reply.blocks)).toContain("plan-77");
  });

  it("rejects approval payload missing plan_id", async () => {
    const submitApprovalDecision = vi.fn(() => ({ ok: true }));
    const ctx = makeCtx({ submitApprovalDecision });
    const router = createSlackRouter(ctx);

    const payload = {
      user: { id: "USLACK1" },
      actions: [{ action_id: "rhodes_approve", value: JSON.stringify({}), type: "button" }],
    };
    const req = makeFormReq({ payload: JSON.stringify(payload) });
    const res = makeRes();
    await router.handleSlackInteract(req, res as any);

    expect(submitApprovalDecision).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(400);
  });

  it("surfaces a friendly message when the gate returns ok=false", async () => {
    const submitApprovalDecision = vi.fn(() => ({ ok: false }));
    const ctx = makeCtx({ submitApprovalDecision });
    const router = createSlackRouter(ctx);

    const payload = {
      user: { id: "U2" },
      actions: [
        { action_id: "rhodes_reject", value: JSON.stringify({ plan_id: "missing" }), type: "button" },
      ],
    };
    const req = makeFormReq({ payload: JSON.stringify(payload) });
    const res = makeRes();
    await router.handleSlackInteract(req, res as any);

    expect(submitApprovalDecision).toHaveBeenCalledWith("missing", "reject", "slack:U2", undefined);
    expect(res.getStatusCode()).toBe(200);
    expect(JSON.stringify(res.getJson().blocks)).toContain("Couldn't find plan");
  });

  it("returns 200 OK without calling the gate for unrelated action_ids", async () => {
    const submitApprovalDecision = vi.fn(() => ({ ok: true }));
    const ctx = makeCtx({ submitApprovalDecision });
    const router = createSlackRouter(ctx);

    const payload = {
      user: { id: "U2" },
      actions: [{ action_id: "rhodes_dashboard_link", type: "button" }],
    };
    const req = makeFormReq({ payload: JSON.stringify(payload) });
    const res = makeRes();
    await router.handleSlackInteract(req, res as any);

    expect(submitApprovalDecision).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(200);
  });
});

// ── Events handler ────────────────────────────────────────────

describe("handleSlackEvents", () => {
  it("echoes the challenge for url_verification", async () => {
    const ctx = makeCtx();
    const router = createSlackRouter(ctx);
    const req = makeJsonReq({ type: "url_verification", challenge: "abc123" });
    const res = makeRes();
    await router.handleSlackEvents(req, res as any);

    expect(res.getStatusCode()).toBe(200);
    expect(res.getJson()).toEqual({ challenge: "abc123" });
  });

  it("strips the leading mention and fires the agent for app_mention", async () => {
    const runAgentCommand = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx({ runAgentCommand });
    const router = createSlackRouter(ctx);

    const req = makeJsonReq({
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "app_mention",
        user: "UHUMAN",
        text: "<@UBOT01> investigate vmid 200",
        channel: "C42",
        ts: "1700000000.000100",
      },
    });
    const res = makeRes();
    await router.handleSlackEvents(req, res as any);
    await new Promise((r) => setTimeout(r, 0));

    expect(runAgentCommand).toHaveBeenCalledTimes(1);
    expect(runAgentCommand.mock.calls[0][0]).toBe("investigate vmid 200");
    expect(runAgentCommand.mock.calls[0][1]).toMatchObject({
      source: "slack",
      slack_user_id: "UHUMAN",
      slack_channel: "C42",
      slack_thread_ts: "1700000000.000100",
    });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getJson()).toEqual({ ok: true });
  });

  it("fires the agent for an IM message from a user", async () => {
    const runAgentCommand = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx({ runAgentCommand });
    const router = createSlackRouter(ctx);

    const req = makeJsonReq({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        user: "UHUMAN",
        text: "what's the cluster status?",
        channel: "D42",
      },
    });
    const res = makeRes();
    await router.handleSlackEvents(req, res as any);
    await new Promise((r) => setTimeout(r, 0));

    expect(runAgentCommand).toHaveBeenCalledTimes(1);
    expect(runAgentCommand.mock.calls[0][0]).toBe("what's the cluster status?");
    expect(res.getStatusCode()).toBe(200);
  });

  it("appends DM thread replies as ticket comments when thread_ts matches a known ticket", async () => {
    // Regression: in v0.5.0-pre, DM thread replies under a ticket-
    // opened bot DM only ran the agent — they never appeared as
    // comments on the ticket. The dashboard's comment timeline was
    // missing the operator's own Slack messages, breaking the
    // bidirectional surface the release was supposed to provide.
    const runAgentCommand = vi.fn(async () => ({ ok: true }));
    const appendTicketThreadComment = vi.fn(() => ({
      id: "c-1",
      ticket_id: "RHODES-2026-099",
      body: "ack — looking at it",
    }));
    const ctx = makeCtx({ runAgentCommand, appendTicketThreadComment });
    const router = createSlackRouter(ctx);

    const req = makeJsonReq({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        user: "UHUMAN",
        text: "ack — looking at it",
        channel: "D42",
        thread_ts: "1778876253.886399",
      },
    });
    const res = makeRes();
    await router.handleSlackEvents(req, res as any);
    await new Promise((r) => setTimeout(r, 0));

    // Both paths fire: ticket-comment append AND agent invocation.
    expect(appendTicketThreadComment).toHaveBeenCalledTimes(1);
    expect(appendTicketThreadComment.mock.calls[0][0]).toBe("1778876253.886399");
    expect(appendTicketThreadComment.mock.calls[0][1]).toBe("ack — looking at it");
    expect(appendTicketThreadComment.mock.calls[0][2]).toBe("UHUMAN");
    expect(runAgentCommand).toHaveBeenCalledTimes(1);
    expect(runAgentCommand.mock.calls[0][1]).toMatchObject({
      slack_thread_ts: "1778876253.886399",
    });
    expect(res.getStatusCode()).toBe(200);
  });

  it("drops IM messages emitted by the bot itself (bot_id set)", async () => {
    const runAgentCommand = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx({ runAgentCommand });
    const router = createSlackRouter(ctx);

    const req = makeJsonReq({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        bot_id: "B0BOTID",
        text: "hi there (this came from me)",
        channel: "D42",
      },
    });
    const res = makeRes();
    await router.handleSlackEvents(req, res as any);
    await new Promise((r) => setTimeout(r, 0));

    expect(runAgentCommand).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(200);
  });

  it("drops events authored by the bot's own user id when configured", async () => {
    const runAgentCommand = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx({
      runAgentCommand,
      getBotUserId: () => "UBOT01",
    });
    const router = createSlackRouter(ctx);

    const req = makeJsonReq({
      type: "event_callback",
      event: {
        type: "app_mention",
        user: "UBOT01", // bot mentioning itself — drop
        text: "<@UBOT01> looping?",
        channel: "C42",
        ts: "1700000000.000200",
      },
    });
    const res = makeRes();
    await router.handleSlackEvents(req, res as any);
    await new Promise((r) => setTimeout(r, 0));

    expect(runAgentCommand).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(200);
  });

  it("returns 200 and drops events of unknown type", async () => {
    const runAgentCommand = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx({ runAgentCommand });
    const router = createSlackRouter(ctx);

    const req = makeJsonReq({
      type: "event_callback",
      event: { type: "reaction_added", user: "U1" },
    });
    const res = makeRes();
    await router.handleSlackEvents(req, res as any);

    expect(runAgentCommand).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(200);
  });
});
