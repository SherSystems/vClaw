import { useStore } from "../store";
import { timeAgo, formatDuration } from "../hooks/useFormatters";
import type { Incident } from "../types";

function renderTimeline(incident: Incident) {
  return (
    <div className="incident-timeline">
      {/* Detected entry */}
      <div className="timeline-entry">
        <div className="timeline-gutter">
          <span className="timeline-dot detected" />
          <span className="timeline-line" />
        </div>
        <div className="timeline-content">
          <span className="timeline-label">Detected</span>
          <span className="timeline-detail">{incident.description}</span>
          <span className="timeline-time">{timeAgo(incident.detected_at)}</span>
        </div>
      </div>

      {/* Action entries */}
      {incident.actions_taken?.map((action, idx) => (
        <div className="timeline-entry" key={idx}>
          <div className="timeline-gutter">
            <span
              className={`timeline-dot action ${action.success ? "success" : "fail"}`}
            />
            <span className="timeline-line" />
          </div>
          <div className="timeline-content">
            <span className="timeline-label">{action.action}</span>
            {action.detail && (
              <span className="timeline-detail">{action.detail}</span>
            )}
            <span className="timeline-time">{timeAgo(action.timestamp)}</span>
          </div>
        </div>
      ))}

      {/* Resolved entry */}
      {incident.status === "resolved" && incident.resolved_at && (
        <div className="timeline-entry">
          <div className="timeline-gutter">
            <span className="timeline-dot resolved" />
            <span className="timeline-line" />
          </div>
          <div className="timeline-content">
            <span className="timeline-label">Resolved</span>
            <span className="timeline-detail">
              {incident.resolution || "Incident resolved"}
            </span>
            <span className="timeline-time">{timeAgo(incident.resolved_at)}</span>
          </div>
        </div>
      )}

      {/* Failed entry */}
      {incident.status === "failed" && (
        <div className="timeline-entry">
          <div className="timeline-gutter">
            <span className="timeline-dot failed" />
            <span className="timeline-line" />
          </div>
          <div className="timeline-content">
            <span className="timeline-label">Failed</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Incidents() {
  const activeIncidents = useStore((s) => s.activeIncidents);
  const recentIncidents = useStore((s) => s.recentIncidents);
  const healingBanners = useStore((s) => s.healingBanners);
  const expandedIncidents = useStore((s) => s.expandedIncidents);
  const toggleIncidentExpanded = useStore((s) => s.toggleIncidentExpanded);

  return (
    <div>
      {/* Healing banners */}
      {healingBanners.map((banner) => (
        <div
          key={banner.id}
          className={`healing-banner ${banner.type}`}
        >
          <span>{banner.type === "paused" ? "⚠" : "☠"}</span>
          <span>{banner.message}</span>
        </div>
      ))}

      {/* Active Incidents */}
      <div className="incidents-section-title">Active Incidents</div>
      {activeIncidents.length === 0 ? (
        <div className="empty-state">No active incidents</div>
      ) : (
        activeIncidents.map((incident) => (
          <div
            key={incident.id}
            className="incident-card"
            onClick={() => toggleIncidentExpanded(incident.id)}
          >
            <div className="incident-card-header">
              <span className={`incident-severity ${incident.severity}`}>
                {incident.severity === "critical" ? "CRITICAL" : "WARNING"}
              </span>
              <span className={`incident-status-pill ${incident.status}`}>
                {incident.status}
              </span>
            </div>
            <div className="incident-desc">{incident.description}</div>
            {(incident.metric_name || incident.trigger_value != null) && (
              <div className="incident-card-meta">
                {incident.metric_name}
                {incident.trigger_value != null && ` = ${incident.trigger_value}`}
              </div>
            )}
            {incident.status === "healing" && incident.playbook_name && (
              <div className="incident-playbook">
                <span className="spinner" />
                {incident.playbook_name}
              </div>
            )}
            <div className="incident-time-ago">
              {timeAgo(incident.detected_at)}
            </div>
            {expandedIncidents[incident.id] && renderTimeline(incident)}
          </div>
        ))
      )}

      {/* Recent Incidents */}
      <div className="incidents-section-title">Recent Incidents</div>
      {recentIncidents.length === 0 ? (
        <div className="empty-state">No recent incidents</div>
      ) : (
        recentIncidents.map((incident) => (
          <div
            key={incident.id}
            className="incident-row"
            onClick={() => toggleIncidentExpanded(incident.id)}
          >
            <span className={`incident-sev-dot ${incident.severity}`} />
            <span className="incident-row-desc">{incident.description}</span>
            {incident.pattern_id && (
              <span className="incident-pattern-tag">{incident.pattern_id}</span>
            )}
            {incident.duration_ms != null && (
              <span className="incident-row-duration">
                {formatDuration(incident.duration_ms)}
              </span>
            )}
            {incident.resolution && (
              <span className="incident-row-resolution">
                {incident.resolution}
              </span>
            )}
            <span
              className={`incident-row-result ${
                incident.status === "resolved" ? "resolved" : "failed"
              }`}
            />
            {expandedIncidents[incident.id] && renderTimeline(incident)}
          </div>
        ))
      )}
    </div>
  );
}
