import { useEffect, useState } from "react";
import { useStore } from "../store";
import {
  fetchPendingApprovals,
  submitApprovalDecision,
  type PendingApproval,
} from "../api/client";

const TIER_LABEL: Record<string, string> = {
  read: "READ",
  safe_write: "SAFE WRITE",
  risky_write: "RISKY WRITE",
  destructive: "DESTRUCTIVE",
  never: "FORBIDDEN",
};

function operatorFromEnv(): string {
  if (typeof window === "undefined") return "dashboard_operator";
  // Lightweight: let the operator self-identify by setting localStorage.rhodes_operator.
  const stored = window.localStorage?.getItem("rhodes_operator");
  return stored && stored.trim().length > 0 ? stored.trim() : "dashboard_operator";
}

export default function Approvals() {
  const pending = useStore((s) => s.pendingApprovals);
  const setPendingApprovals = useStore((s) => s.setPendingApprovals);
  const removePendingApproval = useStore((s) => s.removePendingApproval);
  const addToast = useStore((s) => s.addToast);

  const [busy, setBusy] = useState<Record<string, "approve" | "reject" | undefined>>({});
  const [error, setError] = useState<string | null>(null);

  // Initial catch-up: pull anything blocked from before the SSE connected.
  useEffect(() => {
    let cancelled = false;
    fetchPendingApprovals()
      .then((rows) => {
        if (!cancelled) setPendingApprovals(rows);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load pending approvals.");
      });
    return () => {
      cancelled = true;
    };
  }, [setPendingApprovals]);

  const decide = async (entry: PendingApproval, decision: "approve" | "reject") => {
    setBusy((b) => ({ ...b, [entry.plan_id]: decision }));
    setError(null);
    try {
      const operator = operatorFromEnv();
      const result = await submitApprovalDecision(entry.plan_id, decision, operator);
      removePendingApproval(entry.plan_id);
      addToast({
        type: decision === "approve" ? "success" : "warning",
        title: decision === "approve" ? "Plan Approved" : "Plan Rejected",
        message: `Plan ${result.plan_id.slice(0, 8)} — ${result.status}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Decision failed";
      setError(msg);
      addToast({ type: "error", title: "Approval Failed", message: msg });
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[entry.plan_id];
        return next;
      });
    }
  };

  if (pending.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-title">Pending Approvals</span>
          <span className="card-badge">0</span>
        </div>
        <div className="card-body">
          <div className="event-log-empty">No approvals waiting.</div>
          {error && <div className="error-detail">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Pending Approvals</span>
        <span className="card-badge">{pending.length}</span>
      </div>
      <div className="card-body">
        {error && <div className="error-detail" style={{ marginBottom: 8 }}>{error}</div>}
        {pending.map((entry) => {
          const state = busy[entry.plan_id];
          const tierLabel = TIER_LABEL[entry.tier] ?? entry.tier.toUpperCase();
          return (
            <div
              key={entry.plan_id}
              className="pipe-step"
              style={{ flexDirection: "column", gap: 6 }}
            >
              <div className="pipe-step-content">
                <span className="pipe-step-action">{entry.action}</span>
                <span className="pipe-step-desc">{entry.reasoning}</span>
                <div className="pipe-step-meta">
                  <span className={`pipe-step-tier ${entry.tier}`}>{tierLabel}</span>
                  <span className="pipe-step-duration">
                    plan {entry.plan_id.slice(0, 8)} · {entry.scope}
                  </span>
                </div>
                {entry.params && Object.keys(entry.params).length > 0 && (
                  <pre
                    style={{
                      fontSize: 11,
                      marginTop: 6,
                      maxHeight: 120,
                      overflow: "auto",
                      background: "var(--bg-elev, rgba(255,255,255,0.04))",
                      padding: 6,
                      borderRadius: 4,
                    }}
                  >
                    {JSON.stringify(entry.params, null, 2)}
                  </pre>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  className="sub-tab"
                  disabled={state !== undefined}
                  onClick={() => decide(entry, "approve")}
                  style={{ borderColor: "var(--green, #4ade80)" }}
                >
                  {state === "approve" ? "Approving…" : "Approve"}
                </button>
                <button
                  className="sub-tab"
                  disabled={state !== undefined}
                  onClick={() => decide(entry, "reject")}
                  style={{ borderColor: "var(--red, #f87171)" }}
                >
                  {state === "reject" ? "Rejecting…" : "Reject"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
