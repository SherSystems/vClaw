// ============================================================
// Tests — EventBus
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../../src/agent/events.js";
import type { AgentEvent, AgentEventType } from "../../src/types.js";

function makeEvent(
  type: AgentEventType = "plan_created",
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
    bus.on("plan_created", listener);

    const event = makeEvent("plan_created", { id: "p1" });
    bus.emit(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('wildcard "*" listener receives all events', () => {
    const listener = vi.fn();
    bus.on("*", listener);

    const e1 = makeEvent("plan_created");
    const e2 = makeEvent("step_started");
    bus.emit(e1);
    bus.emit(e2);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(e1);
    expect(listener).toHaveBeenCalledWith(e2);
  });

  // ── off ─────────────────────────────────────────────────────

  it("off: unsubscribing removes the listener", () => {
    const listener = vi.fn();
    bus.on("step_completed", listener);
    bus.off("step_completed", listener);

    bus.emit(makeEvent("step_completed"));
    expect(listener).not.toHaveBeenCalled();
  });

  // ── Multiple listeners ──────────────────────────────────────

  it("multiple listeners on same type all get notified", () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.on("step_failed", a);
    bus.on("step_failed", b);

    const event = makeEvent("step_failed");
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

    bus.on("alert_fired", badListener);
    bus.on("alert_fired", goodListener);

    bus.emit(makeEvent("alert_fired"));

    expect(goodListener).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  // ── getHistory ──────────────────────────────────────────────

  it("getHistory() returns empty array initially", () => {
    expect(bus.getHistory()).toEqual([]);
  });

  it("getHistory() returns emitted events in order", () => {
    const e1 = makeEvent("plan_created");
    const e2 = makeEvent("step_started");
    const e3 = makeEvent("step_completed");
    bus.emit(e1);
    bus.emit(e2);
    bus.emit(e3);

    expect(bus.getHistory()).toEqual([e1, e2, e3]);
  });

  it("getHistory(limit) returns only the last N events", () => {
    for (let i = 0; i < 10; i++) {
      bus.emit(makeEvent("plan_created", { i }));
    }

    const last3 = bus.getHistory(3);
    expect(last3).toHaveLength(3);
    expect(last3[0].data.i).toBe(7);
    expect(last3[2].data.i).toBe(9);
  });

  it("history has a max of 1000 events (rolling buffer)", () => {
    for (let i = 0; i < 1001; i++) {
      bus.emit(makeEvent("metric_recorded", { i }));
    }

    const history = bus.getHistory();
    expect(history).toHaveLength(1000);
    // The very first event (i=0) should have been evicted
    expect(history[0].data.i).toBe(1);
    expect(history[999].data.i).toBe(1000);
  });

  // ── Edge cases ──────────────────────────────────────────────

  it("emitting to a type with no listeners doesn't throw", () => {
    expect(() => bus.emit(makeEvent("replan"))).not.toThrow();
  });

  it("off() on a listener that isn't subscribed doesn't throw", () => {
    const listener = vi.fn();
    expect(() => bus.off("plan_created", listener)).not.toThrow();
  });

  it("off removes the type key from the map when set is empty", () => {
    const listener = vi.fn();
    bus.on("plan_approved", listener);
    bus.off("plan_approved", listener);

    // After removal, emitting should still work (no leftover empty set)
    // and a fresh listener should be the only one
    const fresh = vi.fn();
    bus.on("plan_approved", fresh);
    bus.emit(makeEvent("plan_approved"));

    expect(fresh).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });
});
