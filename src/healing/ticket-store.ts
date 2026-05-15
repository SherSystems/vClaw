// ============================================================
// RHODES — Ticket Store
//
// A Ticket is a long-lived engineering record that wraps an
// Incident. The Incident keeps its UUID and stays the source
// of truth for "what RHODES saw and did"; the Ticket layer
// adds the operator-facing fields:
//
//   - human-readable id (RHODES-2026-001 from the allocator)
//   - title / summary derived from labels
//   - opened_at / resolved_at / closed_at lifecycle
//   - postmortem text (LLM-generated, operator-editable)
//   - Slack thread binding (channel + thread_ts)
//   - comments[] (operator + slack + agent)
//   - plan_ids[] (every plan that ran against this ticket)
//
// Persistence: SQLite, two tables (`tickets`, `ticket_comments`).
// Schema migrations follow the same pattern as `governance/
// audit.ts` — `CREATE TABLE IF NOT EXISTS` + idempotent
// indexes inside `createTables()`. No external migration
// runner: the constructor runs the DDL on every boot.
//
// Backward compatibility: the canonical Incident object is
// untouched. The Ticket is a view-on-top, joined on
// `incident_id`. Existing consumers of `IncidentManager` keep
// working; the `TicketStore` only adds ticket-specific
// fields.
// ============================================================

import { randomUUID } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type { Incident } from "./incidents.js";
import {
  TicketIdAllocator,
  parseTicketId,
  type TicketIdDb,
} from "./ticket-ids.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Ticket lifecycle. Strictly orthogonal to the underlying
 *  Incident.status — a ticket can be "closed" by the operator while
 *  the Incident itself was "failed", and an "open" ticket can have a
 *  "resolved" Incident under it that's awaiting a postmortem signoff. */
export type TicketStatus =
  | "open"
  | "investigating"
  | "healing"
  | "resolved"
  | "closed"
  | "failed";

export interface TicketComment {
  id: string;
  ticket_id: string;
  author: string;
  body: string;
  source: "dashboard" | "slack" | "agent";
  timestamp: string;
}

export interface TicketRecord {
  /** Human-readable id, e.g. RHODES-2026-001 — also the primary key. */
  ticket_id: string;
  /** Underlying Incident.id (UUID). One Incident ↔ one Ticket. */
  incident_id: string;
  title: string;
  summary?: string;
  status: TicketStatus;
  opened_at: string;
  resolved_at?: string;
  closed_at?: string;
  postmortem?: string;
  slack_thread_ts?: string;
  slack_channel?: string;
  plan_ids: string[];
  comments: TicketComment[];
}

/** Ticket joined with the underlying Incident — the canonical
 *  shape served by the /api/tickets routes. */
export interface Ticket extends TicketRecord {
  incident: Incident;
}

/** Filters for list queries. Mirrors the URL parameters supported
 *  by `GET /api/tickets`. */
export interface TicketListFilters {
  status?: TicketStatus;
  since?: string;
  /** Label filters as a flat key→value map. Each entry becomes a
   *  substring check against the incident's labels JSON. */
  labels?: Record<string, string>;
  limit?: number;
}

interface RawTicketRow {
  ticket_id: string;
  incident_id: string;
  title: string;
  summary: string | null;
  status: string;
  opened_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  postmortem: string | null;
  slack_thread_ts: string | null;
  slack_channel: string | null;
  plan_ids: string;
}

interface RawCommentRow {
  id: string;
  ticket_id: string;
  author: string;
  body: string;
  source: string;
  timestamp: string;
}

/** Resolve default DB path: `<project_root>/data/healing/tickets.db`. */
function defaultDbPath(): string {
  const dataDir = resolve(__dirname, "..", "..", "data", "healing");
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "tickets.db");
}

/**
 * Derive a short human title for a ticket from an Incident. Goal: a
 * one-liner an operator can grok at a glance in `/rhodes tickets`,
 * e.g. "esxi-01 paused (io-error)" rather than the raw description.
 */
export function deriveTicketTitle(incident: Incident): string {
  const name = incident.labels.name || incident.labels.vmid;
  const node = incident.labels.node;
  const reason =
    incident.labels.reason ||
    incident.labels.runtime_status ||
    incident.anomaly_type;

  if (name && reason) {
    if (node && node !== name) {
      return `${name} on ${node}: ${reason}`;
    }
    return `${name}: ${reason}`;
  }

  // Fallback: trim the description to one line.
  const firstLine = (incident.description ?? "").split(/[\r\n]/)[0].trim();
  if (firstLine) return firstLine.length > 120 ? firstLine.slice(0, 117) + "…" : firstLine;
  return `${incident.metric} anomaly`;
}

/** Translate an Incident.status into the corresponding Ticket.status
 *  while preserving the operator-side "closed" terminal state. */
export function ticketStatusFromIncident(
  incidentStatus: Incident["status"],
  current?: TicketStatus,
): TicketStatus {
  // Once an operator closes a ticket, the underlying incident can
  // technically stay resolved/failed — preserve "closed".
  if (current === "closed") return "closed";
  switch (incidentStatus) {
    case "open":
      return "open";
    case "healing":
      return "healing";
    case "resolved":
      return "resolved";
    case "failed":
      return "failed";
    default:
      return current ?? "open";
  }
}

export class TicketStore {
  private readonly db: Database.Database;
  readonly allocator: TicketIdAllocator;

  constructor(dbPath?: string) {
    const path = dbPath ?? defaultDbPath();
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.createTables();
    this.allocator = new TicketIdAllocator(this.db as unknown as TicketIdDb);
  }

  /** Lookup-or-create a TicketRecord for an Incident. If the
   *  Incident has no ticket row yet, allocate a new id (year-stamped
   *  to `incident.detected_at` for backfill correctness) and insert.
   *
   *  Idempotent — concurrent callers for the same incident_id will
   *  end up with the same ticket id because the lookup precedes the
   *  insert and we serialize on the unique `incident_id` index. */
  ensureForIncident(incident: Incident): TicketRecord {
    const existing = this.findByIncidentId(incident.id);
    if (existing) return existing;

    const detected = parseDateOrNow(incident.detected_at);
    const ticketId = this.allocator.allocate(detected);
    const record: TicketRecord = {
      ticket_id: ticketId,
      incident_id: incident.id,
      title: deriveTicketTitle(incident),
      summary: undefined,
      status: ticketStatusFromIncident(incident.status),
      opened_at: incident.detected_at,
      resolved_at: incident.resolved_at,
      closed_at: undefined,
      postmortem: undefined,
      slack_thread_ts: undefined,
      slack_channel: undefined,
      plan_ids: [],
      comments: [],
    };
    this.insertRecord(record);
    return record;
  }

  findByIncidentId(incidentId: string): TicketRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tickets WHERE incident_id = ?`)
      .get(incidentId) as RawTicketRow | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  findByTicketId(ticketId: string): TicketRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tickets WHERE ticket_id = ?`)
      .get(ticketId) as RawTicketRow | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  /** List ticket records filtered by status/since/labels. The labels
   *  filter is applied client-side after a coarse query, since the
   *  Incident labels live in a separate store. The store-side caller
   *  joins those after. */
  list(filters: TicketListFilters = {}): TicketRecord[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.status) {
      conditions.push("status = @status");
      params.status = filters.status;
    }
    if (filters.since) {
      conditions.push("opened_at >= @since");
      params.since = filters.since;
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 200;
    const rows = this.db
      .prepare(
        `SELECT * FROM tickets ${where} ORDER BY opened_at DESC LIMIT @limit`,
      )
      .all({ ...params, limit }) as RawTicketRow[];

    return rows.map((r) => this.hydrate(r));
  }

  /** Apply incident-driven status / resolved_at updates to the ticket
   *  row. Called from the IncidentCoordinator on resolve/fail. */
  syncFromIncident(incident: Incident): TicketRecord {
    const existing = this.ensureForIncident(incident);
    const nextStatus = ticketStatusFromIncident(incident.status, existing.status);
    const resolved_at = incident.resolved_at ?? existing.resolved_at;
    this.db
      .prepare(
        `UPDATE tickets SET status = @status, resolved_at = @resolved_at WHERE ticket_id = @id`,
      )
      .run({
        status: nextStatus,
        resolved_at: resolved_at ?? null,
        id: existing.ticket_id,
      });
    return { ...existing, status: nextStatus, resolved_at };
  }

  updatePostmortem(ticketId: string, postmortem: string | null): void {
    this.db
      .prepare(`UPDATE tickets SET postmortem = @pm WHERE ticket_id = @id`)
      .run({ pm: postmortem, id: ticketId });
  }

  /** Bind a Slack thread to the ticket. Called from the alert dispatch
   *  path once `chat.postMessage` returns `{channel, ts}`. */
  bindSlackThread(ticketId: string, channel: string, threadTs: string): void {
    this.db
      .prepare(
        `UPDATE tickets SET slack_channel = @channel, slack_thread_ts = @ts WHERE ticket_id = @id`,
      )
      .run({ channel, ts: threadTs, id: ticketId });
  }

  /** Look up the ticket matching a slack `thread_ts`. Used by the
   *  events handler to thread Slack replies back as ticket comments. */
  findByThreadTs(threadTs: string): TicketRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tickets WHERE slack_thread_ts = ?`)
      .get(threadTs) as RawTicketRow | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  addPlanId(ticketId: string, planId: string): void {
    const existing = this.findByTicketId(ticketId);
    if (!existing) return;
    if (existing.plan_ids.includes(planId)) return;
    const next = [...existing.plan_ids, planId];
    this.db
      .prepare(`UPDATE tickets SET plan_ids = @pids WHERE ticket_id = @id`)
      .run({ pids: JSON.stringify(next), id: ticketId });
  }

  addComment(
    ticketId: string,
    input: Omit<TicketComment, "id" | "ticket_id" | "timestamp"> & {
      timestamp?: string;
    },
  ): TicketComment {
    const comment: TicketComment = {
      id: randomUUID(),
      ticket_id: ticketId,
      author: input.author,
      body: input.body,
      source: input.source,
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO ticket_comments (id, ticket_id, author, body, source, timestamp)
         VALUES (@id, @ticket_id, @author, @body, @source, @timestamp)`,
      )
      .run(comment);
    return comment;
  }

  /** Set status = "closed" and stamp closed_at = now. Caller is
   *  responsible for verifying that `postmortem` is non-empty (the
   *  route enforces this — we don't here so internal callers can
   *  rebuild state without re-running the check). */
  close(ticketId: string, when: Date = new Date()): void {
    this.db
      .prepare(
        `UPDATE tickets SET status = 'closed', closed_at = @closed_at WHERE ticket_id = @id`,
      )
      .run({ closed_at: when.toISOString(), id: ticketId });
  }

  /** Manually set status (used by tests + the route layer). Doesn't
   *  touch any other field. */
  setStatus(ticketId: string, status: TicketStatus): void {
    this.db
      .prepare(`UPDATE tickets SET status = @status WHERE ticket_id = @id`)
      .run({ status, id: ticketId });
  }

  close_(): void {
    this.db.close();
  }

  // ── Internal ───────────────────────────────────────────────

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_id        TEXT PRIMARY KEY,
        incident_id      TEXT NOT NULL UNIQUE,
        title            TEXT NOT NULL,
        summary          TEXT,
        status           TEXT NOT NULL,
        opened_at        TEXT NOT NULL,
        resolved_at      TEXT,
        closed_at        TEXT,
        postmortem       TEXT,
        slack_thread_ts  TEXT,
        slack_channel    TEXT,
        plan_ids         TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_opened_at ON tickets(opened_at);
      CREATE INDEX IF NOT EXISTS idx_tickets_thread_ts ON tickets(slack_thread_ts);

      CREATE TABLE IF NOT EXISTS ticket_comments (
        id          TEXT PRIMARY KEY,
        ticket_id   TEXT NOT NULL,
        author      TEXT NOT NULL,
        body        TEXT NOT NULL,
        source      TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
      );

      CREATE INDEX IF NOT EXISTS idx_comments_ticket_id ON ticket_comments(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_comments_timestamp ON ticket_comments(timestamp);
    `);
  }

  private insertRecord(record: TicketRecord): void {
    this.db
      .prepare(
        `INSERT INTO tickets (
          ticket_id, incident_id, title, summary, status,
          opened_at, resolved_at, closed_at, postmortem,
          slack_thread_ts, slack_channel, plan_ids
        ) VALUES (
          @ticket_id, @incident_id, @title, @summary, @status,
          @opened_at, @resolved_at, @closed_at, @postmortem,
          @slack_thread_ts, @slack_channel, @plan_ids
        )`,
      )
      .run({
        ticket_id: record.ticket_id,
        incident_id: record.incident_id,
        title: record.title,
        summary: record.summary ?? null,
        status: record.status,
        opened_at: record.opened_at,
        resolved_at: record.resolved_at ?? null,
        closed_at: record.closed_at ?? null,
        postmortem: record.postmortem ?? null,
        slack_thread_ts: record.slack_thread_ts ?? null,
        slack_channel: record.slack_channel ?? null,
        plan_ids: JSON.stringify(record.plan_ids ?? []),
      });
  }

  private hydrate(row: RawTicketRow): TicketRecord {
    const comments = this.loadComments(row.ticket_id);
    let planIds: string[] = [];
    try {
      const parsed = JSON.parse(row.plan_ids);
      if (Array.isArray(parsed)) planIds = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      planIds = [];
    }
    return {
      ticket_id: row.ticket_id,
      incident_id: row.incident_id,
      title: row.title,
      summary: row.summary ?? undefined,
      status: row.status as TicketStatus,
      opened_at: row.opened_at,
      resolved_at: row.resolved_at ?? undefined,
      closed_at: row.closed_at ?? undefined,
      postmortem: row.postmortem ?? undefined,
      slack_thread_ts: row.slack_thread_ts ?? undefined,
      slack_channel: row.slack_channel ?? undefined,
      plan_ids: planIds,
      comments,
    };
  }

  private loadComments(ticketId: string): TicketComment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY timestamp ASC`,
      )
      .all(ticketId) as RawCommentRow[];
    return rows.map((r) => ({
      id: r.id,
      ticket_id: r.ticket_id,
      author: r.author,
      body: r.body,
      source: r.source as TicketComment["source"],
      timestamp: r.timestamp,
    }));
  }
}

/** Helper used by `parseTicketId`-driven routes — exported here so
 *  callers don't need to know which module owns it. */
export { parseTicketId };

function parseDateOrNow(s: string | undefined): Date {
  if (!s) return new Date();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}
