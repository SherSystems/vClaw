// ============================================================
// Tests — EventBus
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../../src/agent/events.js";
import { AgentEventType } from "../../src/types.js";
import type { AgentEvent } from "../../src/types.js";

function makeEvent(
  type: AgentEventType = AgentEventType.PlanCreated,
  data: Record<string, unknown> = {},
): AgentEvent {
  return { type, timestamp: new Date().toISOString(), data };
}

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ── on / emit ───────────────────────────────────────────────

  it("on/emit: listener receives events of the subscribed type", () => {
    const listener = vi.fn();
    bus.on(AgentEventType.PlanCreated, listener);

    const event = makeEvent(AgentEventType.PlanCreated, { id: "p1" });
    bus.emit(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('wildcard "*" listener receives all events', () => {
    const listener = vi.fn();
    bus.on("*", listener);

    const e1 = makeEvent(AgentEventType.PlanCreated);
    const e2 = makeEvent(AgentEventType.StepStarted);
    bus.emit(e1);
    bus.emit(e2);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(e1);
    expect(listener).toHaveBeenCalledWith(e2);
  });

  // ── off ─────────────────────────────────────────────────────

  it("off: unsubscribing removes the listener", () => {
    const listener = vi.fn();
    bus.on(AgentEventType.StepCompleted, listener);
    bus.off(AgentEventType.StepCompleted, listener);

    bus.emit(makeEvent(AgentEventType.StepCompleted));
    expect(listener).not.toHaveBeenCalled();
  });

  // ── Multiple listeners ──────────────────────────────────────

  it("multiple listeners on same type all get notified", () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.on(AgentEventType.StepFailed, a);
    bus.on(AgentEventType.StepFailed, b);

    const event = makeEvent(AgentEventType.StepFailed);
    bus.emit(event);

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  // ── Listener error isolation ────────────────────────────────

  it("listener error does not crash other listeners (console.error is called)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const badListener = vi.fn(() => {
      throw new Error("kaboom");
    });
    const goodListener = vi.fn();

    bus.on(AgentEventType.AlertFired, badListener);
    bus.on(AgentEventType.AlertFired, goodListener);

    bus.emit(makeEvent(AgentEventType.AlertFired));

    expect(goodListener).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  // ── getHistory ──────────────────────────────────────────────

  it("getHistory() returns empty array initially", () => {
    expect(bus.getHistory()).toEqual([]);
  });

  it("getHistory() returns emitted events in order", () => {
    const e1 = makeEvent(AgentEventType.PlanCreated);
    const e2 = makeEvent(AgentEventType.StepStarted);
    const e3 = makeEvent(AgentEventType.StepCompleted);
    bus.emit(e1);
    bus.emit(e2);
    bus.emit(e3);

    expect(bus.getHistory()).toEqual([e1, e2, e3]);
  });

  it("getHistory(limit) returns only the last N events", () => {
    for (let i = 0; i < 10; i++) {
      bus.emit(makeEvent(AgentEventType.PlanCreated, { i }));
    }

    const last3 = bus.getHistory(3);
    expect(last3).toHaveLength(3);
    expect(last3[0].data.i).toBe(7);
    expect(last3[2].data.i).toBe(9);
  });

  it("history has a max of 1000 events (rolling buffer)", () => {
    for (let i = 0; i < 1001; i++) {
      bus.emit(makeEvent(AgentEventType.MetricRecorded, { i }));
    }

    const history = bus.getHistory();
    expect(history).toHaveLength(1000);
    // The very first event (i=0) should have been evicted
    expect(history[0].data.i).toBe(1);
    expect(history[999].data.i).toBe(1000);
  });

  // ── Edge cases ──────────────────────────────────────────────

  it("emitting to a type with no listeners doesn't throw", () => {
    expect(() => bus.emit(makeEvent(AgentEventType.Replan))).not.toThrow();
  });

  it("off() on a listener that isn't subscribed doesn't throw", () => {
    const listener = vi.fn();
    expect(() => bus.off(AgentEventType.PlanCreated, listener)).not.toThrow();
  });

  it("off removes the type key from the map when set is empty", () => {
    const listener = vi.fn();
    bus.on(AgentEventType.PlanApproved, listener);
    bus.off(AgentEventType.PlanApproved, listener);

    // After removal, emitting should still work (no leftover empty set)
    // and a fresh listener should be the only one
    const fresh = vi.fn();
    bus.on(AgentEventType.PlanApproved, fresh);
    bus.emit(makeEvent(AgentEventType.PlanApproved));

    expect(fresh).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });
});
