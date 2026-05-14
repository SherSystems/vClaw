// ============================================================
// RHODES — API-driven approval flow tests (v0.4.2)
// Validates that an approval gate blocked under daemon mode
// (no TTY, no CLI handler) can be resolved via the HTTP API:
//   GET  /api/agent/pending-approvals
//   POST /api/agent/approve { plan_id, decision, operator }
// ============================================================

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { ApprovalGate } from "../../src/governance/approval.js";
import { DashboardServer } from "../../src/frontends/dashboard/server.js";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";
import type { ApprovalRequest } from "../../src/types.js";

// Tests in this file pre-date the dashboard auth layer (security D-3).
// They exercise approval HTTP endpoints without session cookies — opt
// out of the auth gate for this suite. End-to-end auth is verified by
// tests/auth/* and tests/auth/csrf.test.ts.
beforeAll(() => {
  process.env.RHODES_AUTH_DISABLED = "true";
});
afterAll(() => {
  delete process.env.RHODES_AUTH_DISABLED;
});

// ── HTTP test helpers (same shape as dashboard-server-static.test.ts) ──

function makeServer(eventBus: EventBus) {
  const toolRegistry = {
    getClusterState: vi.fn(),
    getMultiClusterState: vi.fn(),
  } as any;

  const audit = {
    queryEntries: vi.fn(() => []),
    getStats: vi.fn(() => ({})),
    exportEntries: vi.fn(() => "[]"),
  } as any;

  return new DashboardServer(0, {} as any, toolRegistry, eventBus, audit) as any;
}

function makeGetReq(path: string) {
  return { url: path, method: "GET" } as any;
}

function makeJsonReq(path: string, body: Record<string, unknown>) {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const req: any = {
    url: path,
    method: "POST",
    on(event: string, cb: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return req;
    },
    flush() {
      const payload = Buffer.from(JSON.stringify(body));
      for (const cb of listeners.data ?? []) cb(payload);
      for (const cb of listeners.end ?? []) cb();
    },
  };
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
    getStatusCode() {
      return statusCode;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    getJsonBody() {
      return typeof body === "string" ? JSON.parse(body) : body;
    },
  };
}

/** Drive the request lifecycle end-to-end for routes that read req body. */
async function runPost(server: any, path: string, body: Record<string, unknown>) {
  const req = makeJsonReq(path, body);
  const res = makeRes();
  server.handleRequest(req, res);
  req.flush();
  // Let the parseBody promise resolve before assertions.
  await new Promise((r) => setImmediate(r));
  return res;
}

function runGet(server: any, path: string) {
  const req = makeGetReq(path);
  const res = makeRes();
  server.handleRequest(req, res);
  return res;
}

// ── Tests ──────────────────────────────────────────────────

describe("ApprovalGate — API decision plumbing", () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    gate = new ApprovalGate();
  });

  it("registers a pending plan-level entry once a listener subscribes", async () => {
    const seen: string[] = [];
    gate.onAwaitingApproval((e) => seen.push(e.plan_id));

    const promise = gate.requestPlanApproval(
      "plan-A",
      "Goal A",
      [{ id: "s1", action: "stop_vm", description: "stop", tier: "destructive" }],
      "reason",
    );

    // Pending entry must appear in the queue.
    await new Promise((r) => setImmediate(r));
    expect(gate.getPendingApprovals().map((p) => p.plan_id)).toEqual(["plan-A"]);
    expect(seen).toEqual(["plan-A"]);

    // Resolve via API: approve.
    const result = gate.submitApiDecision("plan-A", "approve", "pranav");
    expect(result.ok).toBe(true);

    await expect(promise).resolves.toBe(true);
    expect(gate.isPlanApproved("plan-A")).toBe(true);
    expect(gate.getPendingApprovals()).toHaveLength(0);
  });

  it("a reject decision rejects the awaiting promise and does not approve the plan", async () => {
    gate.onAwaitingApproval(() => undefined);
    const promise = gate.requestPlanApproval("plan-B", "Goal B", [], "reason");

    await new Promise((r) => setImmediate(r));
    gate.submitApiDecision("plan-B", "reject", "pranav");

    await expect(promise).resolves.toBe(false);
    expect(gate.isPlanApproved("plan-B")).toBe(false);
  });

  it("double-approve is idempotent", async () => {
    gate.onAwaitingApproval(() => undefined);
    const promise = gate.requestPlanApproval("plan-C", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const first = gate.submitApiDecision("plan-C", "approve", "pranav");
    const second = gate.submitApiDecision("plan-C", "approve", "pranav");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.resolved).toBe(true);
      expect(second.resolved).toBe(false);
      expect(first.record.timestamp).toBe(second.record.timestamp);
    }
    await expect(promise).resolves.toBe(true);
  });

  it("unknown plan_id returns ok=false with reason=unknown_plan", () => {
    const result = gate.submitApiDecision("does-not-exist", "approve", "pranav");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_plan");
  });

  it("step-level requestApproval also resolves via API when plan_id is set", async () => {
    gate.onAwaitingApproval(() => undefined);

    const request: ApprovalRequest = {
      id: "req-1",
      action: "delete_vm",
      tier: "destructive",
      params: { vmid: 999 },
      reasoning: "needs deletion",
      plan_id: "plan-D",
      timestamp: new Date().toISOString(),
    };

    const promise = gate.requestApproval(request);
    await new Promise((r) => setImmediate(r));

    expect(gate.getPendingApprovals().map((p) => p.plan_id)).toEqual(["plan-D"]);

    gate.submitApiDecision("plan-D", "approve", "pranav");
    const response = await promise;

    expect(response.approved).toBe(true);
    expect(response.method).toBe("dashboard");
    expect(response.approved_by).toBe("pranav");
  });
});

describe("Dashboard /api/agent/approve + /api/agent/pending-approvals", () => {
  let gate: ApprovalGate;
  let bus: EventBus;
  let server: any;

  beforeEach(() => {
    gate = new ApprovalGate();
    bus = new EventBus();
    server = makeServer(bus);
    server.attachApprovalGate(gate);
  });

  it("emits an AwaitingApproval event when a gate registers", async () => {
    const events: string[] = [];
    bus.on("*", (e) => events.push(e.type));

    const promise = gate.requestPlanApproval(
      "plan-E",
      "Restart paused VM",
      [{ id: "s1", action: "resume_vm", description: "resume", tier: "destructive" }],
      "reason",
    );

    await new Promise((r) => setImmediate(r));
    expect(events).toContain(AgentEventType.AwaitingApproval);

    // Clean up the dangling promise.
    gate.submitApiDecision("plan-E", "approve", "pranav");
    await promise;
  });

  it("GET /api/agent/pending-approvals returns the queue", async () => {
    const promise = gate.requestPlanApproval(
      "plan-F",
      "Goal F",
      [{ id: "s1", action: "stop_vm", description: "stop", tier: "destructive" }],
      "needs approval",
    );
    await new Promise((r) => setImmediate(r));

    const res = runGet(server, "/api/agent/pending-approvals");
    expect(res.getStatusCode()).toBe(200);
    const body = res.getJsonBody();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].plan_id).toBe("plan-F");
    expect(body[0].action).toBe("plan_approval");
    expect(body[0].tier).toBe("destructive");
    expect(body[0].scope).toBe("plan");

    gate.submitApiDecision("plan-F", "approve", "pranav");
    await promise;
  });

  it("POST /api/agent/approve approves and resolves the plan promise", async () => {
    const promise = gate.requestPlanApproval("plan-G", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const res = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-G",
      decision: "approve",
      operator: "pranav",
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getJsonBody();
    expect(body.plan_id).toBe("plan-G");
    expect(body.status).toBe("approved");
    expect(body.operator).toBe("pranav");
    expect(body.idempotent).toBe(false);

    await expect(promise).resolves.toBe(true);
  });

  it("POST /api/agent/approve aborts a plan when decision=reject", async () => {
    const promise = gate.requestPlanApproval("plan-H", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const res = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-H",
      decision: "reject",
      operator: "pranav",
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getJsonBody().status).toBe("rejected");
    await expect(promise).resolves.toBe(false);
  });

  it("POST /api/agent/approve is idempotent on repeat", async () => {
    const promise = gate.requestPlanApproval("plan-I", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const first = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-I",
      decision: "approve",
      operator: "pranav",
    });
    const second = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-I",
      decision: "approve",
      operator: "pranav",
    });

    expect(first.getStatusCode()).toBe(200);
    expect(second.getStatusCode()).toBe(200);
    expect(first.getJsonBody().idempotent).toBe(false);
    expect(second.getJsonBody().idempotent).toBe(true);

    await expect(promise).resolves.toBe(true);
  });

  it("POST /api/agent/approve returns 404 for unknown plan_id", async () => {
    const res = await runPost(server, "/api/agent/approve", {
      plan_id: "nope",
      decision: "approve",
      operator: "pranav",
    });
    expect(res.getStatusCode()).toBe(404);
  });

  it("POST /api/agent/approve validates body fields", async () => {
    const noPlan = await runPost(server, "/api/agent/approve", {
      decision: "approve",
      operator: "pranav",
    });
    expect(noPlan.getStatusCode()).toBe(400);

    // Need a pending entry so the decision-validator runs before the
    // unknown-plan check (otherwise 404 would mask the 400).
    const promise = gate.requestPlanApproval("plan-V", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    const badDecision = await runPost(server, "/api/agent/approve", {
      plan_id: "plan-V",
      decision: "maybe",
      operator: "pranav",
    });
    expect(badDecision.getStatusCode()).toBe(400);

    gate.submitApiDecision("plan-V", "approve", "pranav");
    await promise;
  });

  it("POST /api/agent/approve broadcasts PlanApproved / PlanRejected on the SSE stream", async () => {
    const types: string[] = [];
    bus.on("*", (e) => types.push(e.type));

    const promise = gate.requestPlanApproval("plan-J", "Goal", [], "reason");
    await new Promise((r) => setImmediate(r));

    await runPost(server, "/api/agent/approve", {
      plan_id: "plan-J",
      decision: "approve",
      operator: "pranav",
    });
    await promise;

    expect(types).toContain(AgentEventType.PlanApproved);
  });
});
