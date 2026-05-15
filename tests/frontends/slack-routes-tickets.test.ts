import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseSubcommand,
  handleSlackCommand,
  handleSlackEvents,
  type SlackRoutesContext,
  type TicketRow,
} from "../../src/frontends/dashboard/slack-routes.js";

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.emit("finish");
  }
  json(): unknown {
    return JSON.parse(this.body);
  }
}

function makeFormReq(form: Record<string, string>): IncomingMessage {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) params.append(k, v);
  const body = params.toString();
  const stream = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = "POST";
  (stream as unknown as { url: string }).url = "/api/integrations/slack/command";
  return stream;
}

function makeJsonReq(payload: unknown): IncomingMessage {
  const body = JSON.stringify(payload);
  const stream = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = "POST";
  (stream as unknown as { url: string }).url = "/api/integrations/slack/events";
  return stream;
}

function fixtureTicketRow(id: string, status = "open"): TicketRow {
  return {
    ticket: {
      ticket_id: id,
      title: "esxi-01 on pranavlab: paused_io_error",
      status,
      opened_at: "2026-04-18T02:11:00.000Z",
      resolved_at: status === "resolved" ? "2026-04-18T02:13:00.000Z" : undefined,
      postmortem: "Pruned a snapshot, dropped pool from 92% to 76%, qm resume returned in 1.3s.",
      comments: [
        {
          author: "agent",
          body: "Auto-generated postmortem.",
          timestamp: "2026-04-18T02:13:05.000Z",
          source: "agent",
        },
      ],
      plan_ids: ["plan-storage-pause-001"],
    },
    incident: { severity: "critical" },
  };
}

// ── parseSubcommand additions ──────────────────────────────

describe("parseSubcommand — ticket subcommands", () => {
  it("parses `tickets` with no args", () => {
    expect(parseSubcommand("tickets")).toEqual({ kind: "tickets" });
  });
  it("parses `tickets <status>`", () => {
    expect(parseSubcommand("tickets open")).toEqual({
      kind: "tickets",
      status: "open",
    });
    expect(parseSubcommand("tickets resolved")).toEqual({
      kind: "tickets",
      status: "resolved",
    });
  });
  it("treats `tickets <RHODES-id>` as a ticket-detail shortcut", () => {
    expect(parseSubcommand("tickets RHODES-2026-001")).toEqual({
      kind: "ticket",
      ticket_id: "RHODES-2026-001",
    });
  });
  it("parses `ticket <id>`", () => {
    expect(parseSubcommand("ticket RHODES-2026-001")).toEqual({
      kind: "ticket",
      ticket_id: "RHODES-2026-001",
    });
  });
  it("falls back to help for `ticket` with no id", () => {
    expect(parseSubcommand("ticket")).toEqual({ kind: "help" });
  });
});

// ── /rhodes tickets ────────────────────────────────────────

describe("/rhodes tickets", () => {
  it("renders a header + section per ticket", async () => {
    const listTickets = vi.fn().mockReturnValue([
      fixtureTicketRow("RHODES-2026-001"),
      fixtureTicketRow("RHODES-2026-002"),
    ]);
    const ctx: SlackRoutesContext = {
      getHealthz: () => ({}),
      getOpenIncidents: () => [],
      getPendingApprovals: () => [],
      runAgentCommand: async () => undefined,
      submitApprovalDecision: () => ({ ok: false }),
      listTickets,
    };

    const res = new MockResponse();
    await handleSlackCommand(
      makeFormReq({ text: "tickets" }),
      res as unknown as ServerResponse,
      ctx,
    );
    const payload = res.json() as { blocks: Array<{ type: string }> };
    expect(res.statusCode).toBe(200);
    expect(payload.blocks[0].type).toBe("header");
    expect(payload.blocks.length).toBeGreaterThanOrEqual(3);
    expect(listTickets).toHaveBeenCalledWith(undefined);
  });

  it("filters by status when supplied", async () => {
    const listTickets = vi
      .fn()
      .mockReturnValue([fixtureTicketRow("RHODES-2026-001", "resolved")]);
    const ctx: SlackRoutesContext = {
      getHealthz: () => ({}),
      getOpenIncidents: () => [],
      getPendingApprovals: () => [],
      runAgentCommand: async () => undefined,
      submitApprovalDecision: () => ({ ok: false }),
      listTickets,
    };
    const res = new MockResponse();
    await handleSlackCommand(
      makeFormReq({ text: "tickets resolved" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(listTickets).toHaveBeenCalledWith("resolved");
    expect(res.statusCode).toBe(200);
  });

  it("returns an info block when listTickets is not wired", async () => {
    const ctx: SlackRoutesContext = {
      getHealthz: () => ({}),
      getOpenIncidents: () => [],
      getPendingApprovals: () => [],
      runAgentCommand: async () => undefined,
      submitApprovalDecision: () => ({ ok: false }),
    };
    const res = new MockResponse();
    await handleSlackCommand(
      makeFormReq({ text: "tickets" }),
      res as unknown as ServerResponse,
      ctx,
    );
    const payload = res.json() as { blocks: Array<{ text: { text: string } }> };
    expect(payload.blocks[0].text.text).toContain("Ticket system not attached");
  });
});

// ── /rhodes ticket <id> ────────────────────────────────────

describe("/rhodes ticket <id>", () => {
  it("renders ticket detail blocks", async () => {
    const getTicket = vi
      .fn()
      .mockReturnValue(fixtureTicketRow("RHODES-2026-001", "resolved"));
    const ctx: SlackRoutesContext = {
      getHealthz: () => ({}),
      getOpenIncidents: () => [],
      getPendingApprovals: () => [],
      runAgentCommand: async () => undefined,
      submitApprovalDecision: () => ({ ok: false }),
      getTicket,
    };
    const res = new MockResponse();
    await handleSlackCommand(
      makeFormReq({ text: "ticket RHODES-2026-001" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(getTicket).toHaveBeenCalledWith("RHODES-2026-001");
    const payload = res.json() as { blocks: Array<{ type: string }> };
    expect(payload.blocks[0].type).toBe("header");
    expect(payload.blocks.some((b) => b.type === "section")).toBe(true);
  });

  it("returns a warning when the ticket id is unknown", async () => {
    const getTicket = vi.fn().mockReturnValue(undefined);
    const ctx: SlackRoutesContext = {
      getHealthz: () => ({}),
      getOpenIncidents: () => [],
      getPendingApprovals: () => [],
      runAgentCommand: async () => undefined,
      submitApprovalDecision: () => ({ ok: false }),
      getTicket,
    };
    const res = new MockResponse();
    await handleSlackCommand(
      makeFormReq({ text: "ticket RHODES-2099-999" }),
      res as unknown as ServerResponse,
      ctx,
    );
    const payload = res.json() as { blocks: Array<{ text: { text: string } }> };
    expect(payload.blocks[0].text.text).toContain("No ticket");
  });
});

// ── Thread reply → ticket comment ──────────────────────────

describe("thread-reply binding", () => {
  it("calls appendTicketThreadComment for messages inside a thread", async () => {
    const append = vi.fn();
    const ctx: SlackRoutesContext = {
      getHealthz: () => ({}),
      getOpenIncidents: () => [],
      getPendingApprovals: () => [],
      runAgentCommand: async () => undefined,
      submitApprovalDecision: () => ({ ok: false }),
      appendTicketThreadComment: append,
    };

    const res = new MockResponse();
    await handleSlackEvents(
      makeJsonReq({
        type: "event_callback",
        event: {
          type: "message",
          text: "investigating",
          user: "U123",
          channel: "C123",
          ts: "9999.0001",
          thread_ts: "1234.5678",
        },
      }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(append).toHaveBeenCalledWith("1234.5678", "investigating", "U123");
    expect(res.statusCode).toBe(200);
  });

  it("calls appendTicketThreadComment for app_mentions inside a thread", async () => {
    const append = vi.fn();
    const ctx: SlackRoutesContext = {
      getHealthz: () => ({}),
      getOpenIncidents: () => [],
      getPendingApprovals: () => [],
      runAgentCommand: async () => undefined,
      submitApprovalDecision: () => ({ ok: false }),
      appendTicketThreadComment: append,
    };

    const res = new MockResponse();
    await handleSlackEvents(
      makeJsonReq({
        type: "event_callback",
        event: {
          type: "app_mention",
          text: "<@U999> what happened?",
          user: "U123",
          channel: "C123",
          ts: "9999.0001",
          thread_ts: "1234.5678",
        },
      }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(append).toHaveBeenCalledWith("1234.5678", "what happened?", "U123");
  });

  it("does not call appendTicketThreadComment for top-level messages", async () => {
    const append = vi.fn();
    const ctx: SlackRoutesContext = {
      getHealthz: () => ({}),
      getOpenIncidents: () => [],
      getPendingApprovals: () => [],
      runAgentCommand: async () => undefined,
      submitApprovalDecision: () => ({ ok: false }),
      appendTicketThreadComment: append,
    };

    const res = new MockResponse();
    await handleSlackEvents(
      makeJsonReq({
        type: "event_callback",
        event: {
          type: "message",
          text: "hello channel",
          user: "U123",
          channel: "C123",
          ts: "9999.0001",
        },
      }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(append).not.toHaveBeenCalled();
  });
});
