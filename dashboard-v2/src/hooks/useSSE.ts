import { useEffect, useRef } from "react";
import { useStore } from "../store";
import type { AgentEvent } from "../types";

const EVENT_TYPES = [
  "plan_created", "plan_approved", "replan",
  "step_started", "step_completed", "step_failed",
  "approval_requested", "circuit_breaker_tripped",
  "investigation_started", "investigation_complete",
  "incident_opened", "incident_action", "incident_resolved",
  "incident_failed", "incident_rca",
  "healing_started", "healing_completed", "healing_failed",
  "healing_paused", "healing_escalated",
  "chaos_simulated", "chaos_started", "chaos_recovery_detected",
  "chaos_completed", "chaos_failed",
  "health_check",
  "migration_started", "migration_step", "migration_completed", "migration_failed",
  "migration_progress", "MigrationProgress", "MigrationCompleted", "MigrationFailed",
] as const;

type StoreSnapshot = ReturnType<typeof useStore.getState>;

export function safeParseSseData(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseAgentSseMessage(raw: string): AgentEvent | null {
  const parsed = safeParseSseData(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const event = parsed as Partial<AgentEvent>;
  if (typeof event.type !== "string") return null;
  if (typeof event.timestamp !== "string") return null;
  if (event.data === undefined || event.data === null) return null;
  if (typeof event.data !== "object") return null;

  return event as AgentEvent;
}

export function applySseEvent(event: AgentEvent, s: StoreSnapshot) {
  const d = event.data;
  const normalizedMigrationType = event.type
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

  // Add to event stream
  s.addEvent(event);

  switch (event.type) {
    case "plan_created":
      s.setPlan(d as unknown as import("../types").Plan);
      if (d.mode) s.setMode(d.mode as import("../types").AgentMode);
      break;

    case "replan":
      s.incrementReplans();
      if (d.new_plan) s.setPlan(d.new_plan as unknown as import("../types").Plan);
      break;

    case "step_started":
      s.updateStep(d.step_id as string, { status: "running" });
      s.incrementActions();
      break;

    case "step_completed":
      s.updateStep(d.step_id as string, {
        status: "success",
        duration_ms: d.duration_ms as number,
        output: d.result,
      });
      s.incrementCompleted();
      s.addToast({
        type: "success",
        title: "Task Completed",
        message: (d.description as string) || `Step ${d.step_id} completed`,
      });
      break;

    case "step_failed":
      s.updateStep(d.step_id as string, {
        status: "failed",
        duration_ms: d.duration_ms as number,
        error: d.error as string,
      });
      s.incrementFailed();
      s.incrementFailures();
      s.addToast({
        type: "error",
        title: "Step Failed",
        message: (d.error as string) || `Step ${d.step_id} failed`,
      });
      break;

    case "incident_opened":
      s.addActiveIncident(d as unknown as import("../types").Incident);
      s.addToast({
        type: "error",
        title: "Incident Detected",
        message: (d.description as string) || `${d.severity} incident opened`,
      });
      break;

    case "incident_action":
      s.updateIncident(d.incident_id as string, {
        actions_taken: d.actions_taken as import("../types").IncidentAction[],
      });
      break;

    case "incident_resolved":
      s.resolveIncident(d.incident_id as string, {
        status: "resolved",
        resolved_at: d.resolved_at as string,
        duration_ms: d.duration_ms as number,
        resolution: d.resolution as string,
      });
      break;

    case "incident_failed":
      s.resolveIncident(d.incident_id as string, {
        status: "failed",
        resolved_at: d.resolved_at as string,
      });
      s.addToast({
        type: "error",
        title: "Incident Failed",
        message: (d.description as string) || "Incident resolution failed",
      });
      break;

    case "incident_rca":
      s.updateIncident(d.incident_id as string, {
        rca: d.rca as import("../types").RootCauseAnalysis,
      });
      break;

    case "healing_started":
      s.updateIncident(d.incident_id as string, { status: "healing" });
      s.setMode("heal");
      break;

    case "healing_completed":
      s.removeHealingBanner(d.incident_id as string);
      s.addToast({
        type: "success",
        title: "Healing Complete",
        message: (d.message as string) || "Auto-healing finished successfully",
      });
      break;

    case "healing_failed":
      s.removeHealingBanner(d.incident_id as string);
      s.addToast({
        type: "warning",
        title: "Healing Failed",
        message: (d.message as string) || "Auto-healing could not resolve the issue",
      });
      break;

    case "healing_paused":
      s.addHealingBanner({
        type: "paused",
        message: d.message as string || "Healing paused - circuit breaker tripped",
        id: d.incident_id as string || "paused",
      });
      break;

    case "healing_escalated":
      s.addHealingBanner({
        type: "escalated",
        message: d.message as string || "Incident escalated to operator",
        id: d.incident_id as string || "escalated",
      });
      s.addToast({
        type: "warning",
        title: "Incident Escalated",
        message: (d.message as string) || "Incident escalated to operator",
      });
      break;

    case "chaos_simulated":
    case "chaos_started":
      s.addToast({
        type: "info",
        title: "Chaos Experiment",
        message: (d.name as string) || (d.scenario_name as string) || "Chaos experiment in progress",
      });
      break;

    case "chaos_completed":
      s.addToast({
        type: "success",
        title: "Chaos Completed",
        message: (d.verdict as string) ? `Verdict: ${d.verdict}` : "Chaos experiment finished",
      });
      break;

    case "chaos_failed":
      s.addToast({
        type: "warning",
        title: "Chaos Failed",
        message: (d.error as string) || "Chaos experiment failed",
      });
      break;

    case "circuit_breaker_tripped":
      s.addToast({
        type: "warning",
        title: "Circuit Breaker Tripped",
        message: (d.message as string) || "Risk threshold exceeded",
      });
      break;

    case "health_check":
      s.addHealth(d as unknown as import("../types").HealthSummary);
      break;

    case "migration_started":
      s.applyMigrationEvent(event.type, d, event.timestamp);
      s.addToast({
        type: "info",
        title: "Migration Started",
        message: (d.vm_name as string) || `VM ${d.vm_id} migration in progress`,
      });
      break;

    case "migration_step":
      s.applyMigrationEvent(event.type, d, event.timestamp);
      break;

    case "migration_progress":
    case "MigrationProgress":
      s.applyMigrationEvent(event.type, d, event.timestamp);
      break;

    case "migration_completed":
    case "MigrationCompleted":
      s.applyMigrationEvent(event.type, d, event.timestamp);
      s.addToast({
        type: "success",
        title: "Migration Complete",
        message: (d.vm_name as string)
          ? `${d.vm_name} migrated successfully`
          : "Migration completed",
      });
      break;

    case "migration_failed":
    case "MigrationFailed":
      s.applyMigrationEvent(event.type, d, event.timestamp);
      s.addToast({
        type: "error",
        title: "Migration Failed",
        message: (d.error as string) || "Migration failed",
      });
      break;
    default:
      if (normalizedMigrationType === "migration_progress") {
        s.applyMigrationEvent(event.type, d, event.timestamp);
      }
      break;
  }
}

export function useSSE() {
  const sourceRef = useRef<EventSource | null>(null);
  const store = useStore();

  useEffect(() => {
    function connect() {
      const es = new EventSource("/api/agent/events");
      sourceRef.current = es;

      es.onopen = () => store.setConnected(true);
      es.onerror = () => {
        store.setConnected(false);
        es.close();
        setTimeout(connect, 3000);
      };

      es.onmessage = (msg) => {
        const event = parseAgentSseMessage(msg.data);
        if (!event) return;
        applySseEvent(event, useStore.getState());
      };

      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (e) => {
          const raw = (e as MessageEvent).data;
          const parsedEvent = parseAgentSseMessage(raw);
          if (parsedEvent) {
            applySseEvent(parsedEvent, useStore.getState());
            return;
          }

          const parsedData = safeParseSseData(raw);
          if (!parsedData || typeof parsedData !== "object") return;
          applySseEvent({
            type,
            timestamp: new Date().toISOString(),
            data: parsedData as Record<string, unknown>,
          }, useStore.getState());
        });
      }
    }

    connect();

    return () => {
      sourceRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
