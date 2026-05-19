// ============================================================
// SlackProvider — caller-supplied blocks pass-through (v0.7.2.3c)
// and the upgrade_approval kind allowlist entry.
// ============================================================

import { describe, expect, it } from "vitest";
import { SlackProvider } from "../../src/notifications/providers/slack.ts";
import type { Alert } from "../../src/notifications/types.js";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: Record<string, unknown> = {};
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = { raw: init.body };
      }
    }
    captured.push({ url, body });
    return new Response(
      JSON.stringify({ ok: true, ts: "1779207100.001", channel: "C0TEST" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function provider(captured: CapturedRequest[]): SlackProvider {
  return new SlackProvider({
    botToken: "xoxb-test",
    defaultChannel: "C0TEAM",
    fetchImpl: fakeFetch(captured),
  });
}

describe("SlackProvider — blocks pass-through (v0.7.2.3c)", () => {
  it("posts caller-supplied blocks verbatim when Alert.blocks is set", async () => {
    const captured: CapturedRequest[] = [];
    const customBlocks = [
      { type: "header", text: { type: "plain_text", text: "custom" } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            action_id: "upgrade_approve",
            value: "plan-abc",
          },
        ],
      },
    ];
    const alert: Alert = {
      title: "fallback title",
      body: "fallback body should NOT appear in blocks",
      kind: "upgrade_approval",
      blocks: customBlocks,
    };
    const result = await provider(captured).send(alert);
    expect(result.delivered).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].body.blocks).toEqual(customBlocks);
    // Fallback text still set (Slack requires it for notifications)
    expect(captured[0].body.text).toBe("fallback title");
  });

  it("falls back to buildBlocks when Alert.blocks is absent (existing behavior)", async () => {
    const captured: CapturedRequest[] = [];
    const alert: Alert = {
      title: "approval test",
      body: "Plan ABC needs approval",
      kind: "approval_needed",
    };
    await provider(captured).send(alert);
    expect(captured).toHaveLength(1);
    const blocks = captured[0].body.blocks as unknown[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    // Provider built blocks itself — shape is the legacy approval_needed
    // layout (header + section + actions with rhodes_approve buttons).
    const json = JSON.stringify(blocks);
    expect(json).toContain("RHODES — approval needed");
    expect(json).toContain("rhodes_approve");
  });

  it("falls back to buildBlocks when Alert.blocks is empty array", async () => {
    const captured: CapturedRequest[] = [];
    const alert: Alert = {
      title: "approval test",
      body: "should fall back",
      kind: "approval_needed",
      blocks: [],
    };
    await provider(captured).send(alert);
    const blocks = captured[0].body.blocks as unknown[];
    expect(blocks.length).toBeGreaterThan(0); // built, not empty
  });

  it("upgrade_approval kind passes the team-channel allowlist (posted, not suppressed)", async () => {
    const captured: CapturedRequest[] = [];
    const alert: Alert = {
      title: "upgrade ready",
      body: "cluster X ready",
      kind: "upgrade_approval",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "test" } }],
    };
    const result = await provider(captured).send(alert);
    expect(result.delivered).toBe(true);
    expect((result.response as { suppressed?: boolean })?.suppressed).not.toBe(true);
    expect(captured).toHaveLength(1); // actually posted
  });

  it("upgrade_progress without thread_ts IS suppressed (channel spam protection)", async () => {
    const captured: CapturedRequest[] = [];
    const alert: Alert = {
      title: "progress",
      body: "entering maintenance",
      kind: "upgrade_progress",
      // NOTE: no slack_thread_ts in context — that's what bypasses
      // the allowlist for progress replies. Without it, this is
      // treated as channel-level traffic and dropped.
    };
    const result = await provider(captured).send(alert);
    expect(result.delivered).toBe(true);
    expect((result.response as { suppressed?: boolean })?.suppressed).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("upgrade_progress WITH thread_ts is posted (thread-reply bypass)", async () => {
    const captured: CapturedRequest[] = [];
    const alert: Alert = {
      title: "progress",
      body: "entering maintenance",
      kind: "upgrade_progress",
      context: { slack_thread_ts: "1779207100.001", slack_channel: "C0TEAM" },
    };
    await provider(captured).send(alert);
    expect(captured).toHaveLength(1);
    // Body should carry thread_ts so Slack threads the reply
    expect(captured[0].body.thread_ts).toBe("1779207100.001");
  });
});
