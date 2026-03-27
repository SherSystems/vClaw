// ============================================================
// vClaw — Event Bus
// Simple pub/sub for streaming agent state to frontends
// ============================================================

import type { AgentEvent, AgentEventType, EventListener } from "../types.js";

const MAX_HISTORY = 1000;

export class EventBus {
  private listeners: Map<AgentEventType | "*", Set<EventListener>> = new Map();
  private history: AgentEvent[] = [];

  /**
   * Subscribe to a specific event type, or "*" for all events.
   */
  on(type: AgentEventType | "*", listener: EventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  /**
   * Unsubscribe a listener from a specific event type.
   */
  off(type: AgentEventType | "*", listener: EventListener): void {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(type);
      }
    }
  }

  /**
   * Emit an event. Notifies both type-specific and wildcard listeners.
   * Stores the event in the rolling history buffer.
   */
  emit(event: AgentEvent): void {
    // Add to history (rolling buffer)
    this.history.push(event);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    // Notify type-specific listeners
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch (err) {
          console.error(`Event listener error [${event.type}]:`, err);
        }
      }
    }

    // Notify wildcard listeners
    const wildcardListeners = this.listeners.get("*");
    if (wildcardListeners) {
      for (const listener of wildcardListeners) {
        try {
          listener(event);
        } catch (err) {
          console.error(`Wildcard event listener error [${event.type}]:`, err);
        }
      }
    }
  }

  /**
   * Get recent events from the rolling history buffer.
   */
  getHistory(limit?: number): AgentEvent[] {
    if (limit === undefined || limit >= this.history.length) {
      return [...this.history];
    }
    return this.history.slice(-limit);
  }
}
