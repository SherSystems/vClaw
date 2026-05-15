import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../store";
import {
  closeTicket,
  fetchTicket,
  fetchTickets,
  patchTicketPostmortem,
  postTicketComment,
  regenerateTicketPostmortem,
} from "../../api/client";
import type { Ticket, TicketStatus } from "../../types";

const STATUS_OPTIONS: Array<{ id: TicketStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "healing", label: "Healing" },
  { id: "resolved", label: "Resolved" },
  { id: "closed", label: "Closed" },
];

export default function Tickets() {
  const tickets = useStore((s) => s.tickets);
  const setTickets = useStore((s) => s.setTickets);
  const statusFilter = useStore((s) => s.ticketStatusFilter);
  const setStatusFilter = useStore((s) => s.setTicketStatusFilter);
  const viewingTicketId = useStore((s) => s.viewingTicketId);
  const setViewingTicketId = useStore((s) => s.setViewingTicketId);
  const isAdmin = useStore((s) => s.authUser?.role === "admin");

  useEffect(() => {
    let cancelled = false;
    const status = statusFilter === "all" ? undefined : statusFilter;
    fetchTickets(status)
      .then((data) => {
        if (cancelled) return;
        setTickets(data.tickets);
      })
      .catch((err) => {
        // Surfaces nicely via the toast system later if needed — for
        // now just log and leave the list empty.
        // eslint-disable-next-line no-console
        console.warn("[tickets] fetchTickets failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, setTickets]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return tickets;
    return tickets.filter((row) => row.ticket.status === statusFilter);
  }, [tickets, statusFilter]);

  const viewing = viewingTicketId
    ? tickets.find((row) => row.ticket.ticket_id === viewingTicketId)
    : null;

  return (
    <div className="tickets-page">
      <div className="tickets-toolbar">
        <h2 className="tickets-title">Engineering tickets</h2>
        <div className="tickets-status-filter">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`tickets-status-btn ${statusFilter === opt.id ? "active" : ""}`}
              onClick={() => setStatusFilter(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state empty-state--card">
          <div className="empty-state-text">No tickets — RHODES is watching.</div>
        </div>
      ) : (
        <div className="tickets-grid">
          {filtered.map(({ ticket, incident }) => (
            <button
              key={ticket.ticket_id}
              type="button"
              className={`ticket-card ${ticket.status}`}
              onClick={() => setViewingTicketId(ticket.ticket_id)}
            >
              <div className="ticket-card-header">
                <span className="ticket-id">{ticket.ticket_id}</span>
                <span className={`ticket-status-pill ${ticket.status}`}>
                  {ticket.status.toUpperCase()}
                </span>
              </div>
              <div className="ticket-title">{ticket.title}</div>
              <div className="ticket-meta">
                {incident?.severity ? <span className={`ticket-sev ${incident.severity}`}>{incident.severity}</span> : null}
                <span className="ticket-opened">{ticket.opened_at}</span>
                <span className="ticket-comments">
                  {ticket.comments.length} comment{ticket.comments.length === 1 ? "" : "s"}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {viewing ? (
        <TicketDetailPanel
          ticketId={viewing.ticket.ticket_id}
          ticket={viewing.ticket}
          incidentDescription={viewing.incident?.description}
          incidentSeverity={viewing.incident?.severity}
          onClose={() => setViewingTicketId(null)}
          isAdmin={Boolean(isAdmin)}
        />
      ) : null}
    </div>
  );
}

interface TicketDetailPanelProps {
  ticketId: string;
  ticket: Ticket;
  incidentDescription?: string;
  incidentSeverity?: string;
  onClose: () => void;
  isAdmin: boolean;
}

function TicketDetailPanel(props: TicketDetailPanelProps) {
  const { ticketId, ticket, incidentDescription, incidentSeverity, onClose, isAdmin } = props;
  const upsertTicket = useStore((s) => s.upsertTicket);
  const patchTicket = useStore((s) => s.patchTicket);
  const appendTicketComment = useStore((s) => s.appendTicketComment);
  const addToast = useStore((s) => s.addToast);

  const [commentInput, setCommentInput] = useState("");
  const [posting, setPosting] = useState(false);
  const [postmortemDraft, setPostmortemDraft] = useState(ticket.postmortem ?? "");
  const [savingPm, setSavingPm] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [closing, setClosing] = useState(false);

  // Refresh draft when ticket changes via SSE.
  useEffect(() => {
    setPostmortemDraft(ticket.postmortem ?? "");
  }, [ticket.postmortem]);

  const onSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = commentInput.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const { comment } = await postTicketComment(ticketId, body);
      appendTicketComment(ticketId, comment);
      setCommentInput("");
    } catch (err) {
      addToast({
        type: "error",
        title: "Comment failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPosting(false);
    }
  };

  const onSavePostmortem = async () => {
    if (savingPm) return;
    setSavingPm(true);
    try {
      const { ticket: updated } = await patchTicketPostmortem(ticketId, postmortemDraft);
      patchTicket(ticketId, updated);
    } catch (err) {
      addToast({
        type: "error",
        title: "Save failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSavingPm(false);
    }
  };

  const onRegenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    try {
      await regenerateTicketPostmortem(ticketId);
      addToast({
        type: "info",
        title: "Regenerating postmortem",
        message: "RHODES is rewriting the postmortem — refresh in a few seconds.",
      });
      // Best-effort re-fetch after a short delay; SSE will also push
      // the updated text once the LLM call returns.
      setTimeout(async () => {
        try {
          const fresh = await fetchTicket(ticketId);
          upsertTicket(fresh);
        } catch {
          /* SSE will catch up */
        }
      }, 4000);
    } catch (err) {
      addToast({
        type: "error",
        title: "Regenerate failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRegenerating(false);
    }
  };

  const onClose_ = async () => {
    if (closing) return;
    if (!ticket.postmortem || ticket.postmortem.trim().length === 0) {
      addToast({
        type: "error",
        title: "Close blocked",
        message: "Can't close without a postmortem — write one first.",
      });
      return;
    }
    setClosing(true);
    try {
      const { ticket: updated } = await closeTicket(ticketId);
      patchTicket(ticketId, updated);
    } catch (err) {
      addToast({
        type: "error",
        title: "Close failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setClosing(false);
    }
  };

  const canRegenerate =
    isAdmin &&
    ticket.status !== "closed" &&
    (!ticket.postmortem || ticket.postmortem.trim().length === 0) &&
    (ticket.status === "resolved" || ticket.status === "failed");

  const canClose =
    isAdmin && ticket.status !== "closed" && (ticket.postmortem ?? "").trim().length > 0;

  return (
    <div className="ticket-detail-overlay" role="dialog" aria-modal="true">
      <div className="ticket-detail-panel">
        <button type="button" className="ticket-detail-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="ticket-detail-header">
          <span className="ticket-id-large">{ticket.ticket_id}</span>
          <span className={`ticket-status-pill ${ticket.status}`}>{ticket.status.toUpperCase()}</span>
        </div>
        <h3 className="ticket-detail-title">{ticket.title}</h3>
        {incidentSeverity ? (
          <div className={`ticket-detail-severity ${incidentSeverity}`}>{incidentSeverity}</div>
        ) : null}
        {incidentDescription ? (
          <div className="ticket-detail-description">{incidentDescription}</div>
        ) : null}

        <div className="ticket-detail-meta">
          <div>
            <strong>Opened</strong>
            <div>{ticket.opened_at}</div>
          </div>
          {ticket.resolved_at ? (
            <div>
              <strong>Resolved</strong>
              <div>{ticket.resolved_at}</div>
            </div>
          ) : null}
          {ticket.closed_at ? (
            <div>
              <strong>Closed</strong>
              <div>{ticket.closed_at}</div>
            </div>
          ) : null}
        </div>

        <section className="ticket-postmortem-section">
          <div className="ticket-section-header">
            <h4>Postmortem</h4>
            {canRegenerate ? (
              <button type="button" disabled={regenerating} onClick={onRegenerate}>
                {regenerating ? "Regenerating…" : "Generate postmortem"}
              </button>
            ) : null}
          </div>
          {isAdmin ? (
            <>
              <textarea
                className="ticket-postmortem-editor"
                value={postmortemDraft}
                onChange={(e) => setPostmortemDraft(e.target.value)}
                rows={6}
                placeholder="RHODES will fill this in automatically when the incident resolves."
              />
              <div className="ticket-postmortem-actions">
                <button type="button" onClick={onSavePostmortem} disabled={savingPm}>
                  {savingPm ? "Saving…" : "Save postmortem"}
                </button>
                <button
                  type="button"
                  className="ticket-close-btn"
                  onClick={onClose_}
                  disabled={!canClose || closing}
                  title={
                    !canClose ? "Write a postmortem before closing" : undefined
                  }
                >
                  {closing ? "Closing…" : "Close ticket"}
                </button>
              </div>
            </>
          ) : (
            <p className="ticket-postmortem-readonly">
              {ticket.postmortem ?? "No postmortem yet."}
            </p>
          )}
        </section>

        <section className="ticket-comments-section">
          <h4>Comments ({ticket.comments.length})</h4>
          <div className="ticket-comments-list">
            {ticket.comments.length === 0 ? (
              <p className="ticket-empty">No comments yet.</p>
            ) : (
              ticket.comments.map((c) => (
                <div key={c.id} className={`ticket-comment source-${c.source}`}>
                  <div className="ticket-comment-meta">
                    <strong>{c.author}</strong>
                    <span className="ticket-comment-source">via {c.source}</span>
                    <span className="ticket-comment-time">{c.timestamp}</span>
                  </div>
                  <div className="ticket-comment-body">{c.body}</div>
                </div>
              ))
            )}
          </div>
          {isAdmin ? (
            <form className="ticket-comment-form" onSubmit={onSubmitComment}>
              <textarea
                value={commentInput}
                onChange={(e) => setCommentInput(e.target.value)}
                placeholder="Leave a comment for the team…"
                rows={2}
              />
              <button type="submit" disabled={posting || commentInput.trim().length === 0}>
                {posting ? "Posting…" : "Post comment"}
              </button>
            </form>
          ) : null}
        </section>

        {ticket.plan_ids.length > 0 ? (
          <section className="ticket-plans-section">
            <h4>Plans</h4>
            <ul>
              {ticket.plan_ids.map((id) => (
                <li key={id}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
