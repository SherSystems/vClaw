// ============================================================
// RHODES — Notifications: SupraProvider
// Sends alerts to a local Supra agent at SUPRA_URL/api/chat. The
// agent's `notify` skill picks the request up and hits Telegram on
// its own. We don't talk to Telegram directly here.
//
// v0.4.2 — Supra's /api/chat takes 5–10s because the LLM dispatches
// the notify skill in turn, but Telegram delivery happens irrespective
// of whether we keep our connection open. Behaviour change:
//   1. Default timeout bumped from 5s → 30s (env: SUPRA_REQUEST_TIMEOUT_MS).
//   2. New `fireAndForget` mode (default ON in daemon contexts) — we
//      log a 200-ACK as success and don't await the LLM round trip.
//   3. Abort/timeout while the LLM was still thinking is no longer
//      reported as "delivery failed" — Supra has already received the
//      payload and will deliver downstream.
// ============================================================

import type { Alert, AlertProvider, NotificationDeliveryResult } from "../types.js";

export interface SupraProviderOptions {
  /** Base URL of the Supra HTTP API (no trailing slash). */
  url: string;
  /** Logical sender id Supra uses to attribute the message. */
  userId: string;
  /**
   * Override for `fetch`. Always inject in tests so we never accidentally
   * hit a real Supra instance.
   */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Defaults to 30s (env: SUPRA_REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * When true (default), return success as soon as Supra ACKs the
   * dispatch — we don't wait for the LLM to invoke the notify skill.
   * When false, await the full response body.
   */
  fireAndForget?: boolean;
}

const DEFAULT_TIMEOUT_MS = parseTimeout(process.env.SUPRA_REQUEST_TIMEOUT_MS) ?? 30_000;

function parseTimeout(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (/aborted/i.test(err.message)) return true;
  }
  return false;
}

export class SupraProvider implements AlertProvider {
  readonly id = "supra";
  private readonly url: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly fireAndForget: boolean;

  constructor(options: SupraProviderOptions) {
    // Trim trailing slash so callers can pass either form.
    this.url = options.url.replace(/\/+$/, "");
    this.userId = options.userId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fireAndForget = options.fireAndForget ?? true;
  }

  async send(alert: Alert): Promise<NotificationDeliveryResult> {
    const endpoint = `${this.url}/api/chat`;
    // Supra's planner reads `message` directly; carrying the structured
    // alert in a separate field lets the notify skill key off `kind`
    // and `context` without re-parsing the body string.
    const payload = {
      message: alert.body,
      userId: this.userId,
      metadata: {
        source: "rhodes",
        kind: alert.kind,
        title: alert.title,
        timestamp: alert.timestamp ?? new Date().toISOString(),
        context: alert.context ?? {},
        link: alert.link,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      // Only treat *transport* failures as delivery failures. A timeout
      // while Supra's LLM was still spinning means the dispatch reached
      // Supra and Telegram delivery is in flight — that's not a failure
      // RHODES needs to surface.
      if (isAbortError(err)) {
        console.log(
          `[notify] dispatched via supra (timeout after ${this.timeoutMs}ms; Supra ack assumed in-flight)`,
        );
        return { delivered: true, provider: this.id, response: { dispatched: "timeout" } };
      }
      return {
        delivered: false,
        provider: this.id,
        error: `Supra request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await safeText(res);
      return {
        delivered: false,
        provider: this.id,
        error: `Supra responded ${res.status}: ${text.slice(0, 256)}`,
      };
    }

    // 2xx — Supra ACKed the dispatch. The LLM may still be working on
    // the notify skill, but Telegram delivery will happen regardless.
    console.log(`[notify] dispatched via supra (HTTP ${res.status})`);

    if (this.fireAndForget) {
      // Drain the body in the background so the connection can close
      // cleanly, but don't make our caller wait on the LLM round-trip.
      void safeJson(res).catch(() => undefined);
      return { delivered: true, provider: this.id, response: { dispatched: true } };
    }

    const data = await safeJson(res);
    return { delivered: true, provider: this.id, response: data };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
