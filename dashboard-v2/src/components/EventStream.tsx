import React, { useRef, useEffect } from "react";
import { useStore } from "../store";
import { timeAgo } from "../hooks/useFormatters";

const SKIP_TYPES = new Set([
  "health_check",
  "healing_tick",
  "metric_recorded",
]);

function getIconAndClass(type: string): { cls: string; icon: string } | null {
  switch (type) {
    case "plan_created":
    case "replan":
      return { cls: "plan", icon: "▸" };
    case "step_started":
      return { cls: "info", icon: "⟳" };
    case "step_completed":
      return { cls: "ok", icon: "✓" };
    case "step_failed":
      return { cls: "err", icon: "✗" };
    case "incident_opened":
      return { cls: "err", icon: "⚠" };
    case "incident_resolved":
    case "healing_completed":
      return { cls: "ok", icon: "✓" };
    case "healing_started":
      return { cls: "warn", icon: "⚡" };
    case "chaos_started":
    case "chaos_simulated":
      return { cls: "warn", icon: "⚡" };
    case "chaos_completed":
      return { cls: "ok", icon: "✓" };
    case "chaos_failed":
      return { cls: "err", icon: "✗" };
    default:
      return { cls: "info", icon: "•" };
  }
}

function formatTitle(type: string, data: Record<string, unknown>): React.ReactNode {
  switch (type) {
    case "plan_created": {
      const count = (data.step_count as number) ?? (data.steps as unknown[])?.length ?? 0;
      return <>Plan created &middot; {count} steps</>;
    }
    case "step_started":
      return <>Running <span style={{ color: "var(--blue)" }}>{String(data.action ?? data.name ?? "")}</span></>;
    case "step_completed":
      return <>Completed <span style={{ color: "var(--green)" }}>{String(data.action ?? data.name ?? "")}</span></>;
    case "step_failed":
      return <>Failed <span style={{ color: "var(--red)" }}>{String(data.action ?? data.name ?? "")}</span></>;
    case "incident_opened":
      return <>Incident: {String(data.description ?? data.message ?? "")}</>;
    case "incident_resolved":
      return <>Resolved: {String(data.description ?? data.message ?? "")}</>;
    case "healing_started":
      return <>Healing: {String(data.playbook ?? data.description ?? "")}</>;
    case "chaos_started":
      return <>Chaos: {String(data.scenario ?? data.name ?? "")}</>;
    case "chaos_completed":
      return <>Chaos complete: {String(data.verdict ?? "done")}</>;
    default: {
      const label = type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
      return <>{label}</>;
    }
  }
}

function formatDetail(type: string, data: Record<string, unknown>): { text: string; isError: boolean } | null {
  switch (type) {
    case "step_failed": {
      const msg = String(data.error ?? data.message ?? data.reason ?? "");
      return msg ? { text: msg, isError: true } : null;
    }
    case "step_completed": {
      const dur = data.duration_ms ?? data.duration;
      return dur != null ? { text: `${dur}ms`, isError: false } : null;
    }
    case "chaos_completed": {
      const score = data.resilience_score;
      return score != null ? { text: `Resilience: ${score}`, isError: false } : null;
    }
    case "incident_opened": {
      const sev = data.severity;
      return sev != null ? { text: `Severity: ${sev}`, isError: false } : null;
    }
    case "healing_started": {
      const target = data.target ?? data.node;
      return target != null ? { text: `Target: ${target}`, isError: false } : null;
    }
    default:
      return null;
  }
}

export function EventStream() {
  const events = useStore((s) => s.events);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events.length]);

  const visible = [...events]
    .reverse()
    .filter((e) => !SKIP_TYPES.has(e.type))
    .slice(0, 100);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Event Stream</span>
        <span className="card-badge">{visible.length}</span>
      </div>
      <div className="card-body">
        <div className="event-log" ref={logRef}>
          {visible.length === 0 ? (
            <div className="event-log-empty">
              <span className="pulsing-dot" />
              Waiting for events...
            </div>
          ) : (
            visible.map((event, idx) => {
              const iconInfo = getIconAndClass(event.type);
              if (!iconInfo) return null;

              const detail = formatDetail(event.type, event.data);

              return (
                <div className="event-item" key={`${event.timestamp}-${idx}`}>
                  <div className={`event-icon ${iconInfo.cls}`}>{iconInfo.icon}</div>
                  <div className="event-body">
                    <div className="event-title">
                      {formatTitle(event.type, event.data)}
                    </div>
                    {detail && (
                      <div className={`event-detail${detail.isError ? " error-detail" : ""}`}>
                        {detail.text}
                      </div>
                    )}
                  </div>
                  <div className="event-ts">{timeAgo(event.timestamp)}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default EventStream;
