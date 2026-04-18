import { useState } from "react";
import { useStore } from "../store";
import { formatDuration } from "../hooks/useFormatters";
import type { StepStatus } from "../types";

const modeIcons: Record<string, string> = {
  watch: "👁",
  build: "🔨",
  investigate: "🔍",
  heal: "⚡",
};

export default function ActivePlan() {
  const plan = useStore((s) => s.plan);
  const planSteps = useStore((s) => s.planSteps);
  const planCompleted = useStore((s) => s.planCompleted);
  const planFailed = useStore((s) => s.planFailed);
  const replans = useStore((s) => s.replans);
  const mode = useStore((s) => s.mode);
  const planGoals = useStore((s) => s.planGoals);

  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({});

  const toggleOutput = (stepId: string) => {
    setExpandedOutputs((prev) => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  if (!plan) {
    return (
      <div className="empty-state">
        <span>📋</span>
        <p>No active plan</p>
        <p>Send a goal via CLI, Telegram, or Cmd+K</p>
      </div>
    );
  }

  const totalSteps = plan.steps.length;
  const allDone = totalSteps > 0 && planCompleted + planFailed >= totalSteps;
  const progressPct = totalSteps > 0 ? ((planCompleted + planFailed) / totalSteps) * 100 : 0;
  const goalText = plan.goal_id || (plan.id && planGoals[plan.id]) || plan.reasoning || "";

  return (
    <div className="card">
      {/* Plan header */}
      <div className="plan-header">
        <div className="plan-goal-row">
          <span className={`plan-mode-icon ${mode}`}>{modeIcons[mode] ?? "👁"}</span>
          <span className="plan-goal">{goalText}</span>
        </div>

        {plan.reasoning && (
          <div className="plan-reasoning">{plan.reasoning}</div>
        )}

        <div className="plan-meta">
          <span>{totalSteps} steps</span>
          <span>
            <span className="dot green" /> {planCompleted} done
          </span>
          {planFailed > 0 && (
            <span>
              <span className="dot red" /> {planFailed} failed
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="plan-progress-bar">
        <div
          className={`plan-progress-fill${planFailed > 0 ? " has-failures" : ""}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Completion banner */}
      {allDone && (
        <div
          className={`plan-complete-banner ${planFailed > 0 ? "partial" : "success"}`}
        >
          {planFailed > 0
            ? `Plan completed with ${planFailed} failures`
            : "Plan completed successfully"}
        </div>
      )}

      {/* Replan banner */}
      {replans > 0 && (
        <div className="plan-replan-banner">
          Replanned {replans} time(s)
        </div>
      )}

      {/* Pipeline steps */}
      <div className="pipeline">
        {plan.steps.map((step, idx) => {
          const stepState = planSteps[step.id];
          const status: StepStatus = stepState?.status ?? step.status;
          const isLast = idx === plan.steps.length - 1;
          const hasOutput = status === "success" && stepState?.output != null;

          return (
            <div key={step.id} className={`pipe-step ${status}`}>
              <div className="pipe-step-gutter">
                <span className="pipe-step-number">
                  {status === "success"
                    ? "✓"
                    : status === "failed"
                      ? "✗"
                      : status === "running"
                        ? <span className="spinner" />
                        : idx + 1}
                </span>
                {!isLast && <div className="pipe-step-line" />}
              </div>

              <div className="pipe-step-content">
                <span className="pipe-step-action">{step.action}</span>
                <span className="pipe-step-desc">{step.description}</span>

                <div className="pipe-step-meta">
                  {step.tier && (
                    <span className={`pipe-step-tier ${step.tier}`}>{step.tier}</span>
                  )}
                  {stepState?.duration_ms != null && (
                    <span className="pipe-step-duration">
                      {formatDuration(stepState.duration_ms)}
                    </span>
                  )}
                </div>

                {status === "failed" && stepState?.error && (
                  <div className="pipe-step-error">{stepState.error}</div>
                )}

                {hasOutput && (
                  <>
                    <button
                      className="step-output-toggle"
                      onClick={() => toggleOutput(step.id)}
                    >
                      {expandedOutputs[step.id] ? "Hide output ▴" : "Show output ▾"}
                    </button>
                    {expandedOutputs[step.id] && (
                      <div className="step-output">
                        <pre>{JSON.stringify(stepState.output, null, 2)}</pre>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
