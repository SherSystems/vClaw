#!/usr/bin/env tsx
// scripts/test-slack-outbound.ts — one-shot Slack outbound smoke test.
//
// Reads RHODES_SLACK_BOT_TOKEN + RHODES_SLACK_DEFAULT_CHANNEL from
// ~/.rhodes/.env (or process env) and posts a fake `approval_needed`
// alert to confirm the SlackProvider Block Kit rendering shows up
// correctly in Slack with interactive buttons.
//
// Usage:
//   npx tsx scripts/test-slack-outbound.ts
//
// Exit codes:
//   0 — message delivered
//   1 — provider misconfigured (missing env vars)
//   2 — Slack rejected the request (auth, channel, scope)

import { SlackProvider } from "../src/notifications/providers/slack.js";
import type { Alert } from "../src/notifications/types.js";
import { getConfig } from "../src/config.js";

async function main(): Promise<void> {
  const config = getConfig();
  const token = config.notifications.slackBotToken;
  const channel = config.notifications.slackDefaultChannel;
  const dashboardUrl = config.notifications.dashboardUrl;

  if (!token || !channel) {
    console.error(
      "[test-slack] missing RHODES_SLACK_BOT_TOKEN or RHODES_SLACK_DEFAULT_CHANNEL",
    );
    process.exit(1);
  }

  console.log(`[test-slack] team channel: ${channel}`);
  console.log(`[test-slack] dashboard URL: ${dashboardUrl || "(none)"}`);

  const provider = new SlackProvider({
    botToken: token,
    defaultChannel: channel,
    dashboardUrl: dashboardUrl || undefined,
  });

  const alert: Alert = {
    title: "Approval needed — proxmox-storage-pause",
    body: "Smoke test alert from RHODES v0.5.0 SlackProvider.",
    kind: "approval_needed",
    timestamp: new Date().toISOString(),
    context: {
      plan_id: "plan_test_01HXYZ123",
      step_id: "step_9",
      tier: "destructive",
      action: "qm delsnapshot 200 autosnap_2026-04-18",
      reasoning:
        "Step 9 of an 11-step storage-pause recovery for esxi-01 (vmid 200). " +
        "The thin-pool data% is currently 92% and pruning the oldest snapshot " +
        "should drop us under the 80% target before qm resume. Hard rules " +
        "block destroy/rm — only delete_snapshot is in scope.",
    },
  };

  console.log("[test-slack] sending Block Kit approval_needed payload...");
  const result = await provider.send(alert);

  if (result.delivered) {
    const resp = result.response as { channel?: string; ts?: string } | undefined;
    console.log(
      `[test-slack] ✓ delivered. channel=${resp?.channel ?? channel} ts=${resp?.ts ?? "?"}`,
    );
    console.log("[test-slack] check your Slack channel — you should see the message");
    console.log("            with Approve / Reject / Open-in-dashboard buttons.");
    process.exit(0);
  } else {
    console.error(`[test-slack] ✗ delivery failed: ${result.error}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`[test-slack] uncaught: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
