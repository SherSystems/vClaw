#!/usr/bin/env node

// ============================================================
// vClaw — Autonomous Infrastructure Agent
// Plan. Deploy. Monitor. Heal. Govern.
// ============================================================

import { getConfig, getDataDir, getPoliciesDir } from "./config.js";
import { loadPolicy } from "./governance/policy.js";
import { GovernanceEngine } from "./governance/index.js";
import { ToolRegistry } from "./providers/registry.js";
import { ProxmoxAdapter } from "./providers/proxmox/adapter.js";
import { SystemAdapter } from "./providers/system/adapter.js";
import { AgentCore } from "./agent/core.js";
import { EventBus } from "./agent/events.js";
import { vClawCLI } from "./frontends/cli.js";
import { vClawBot } from "./frontends/telegram.js";
import { DashboardServer } from "./frontends/dashboard/server.js";
import { vClawMCP } from "./frontends/mcp.js";
import { AutopilotDaemon } from "./autopilot/daemon.js";
import { HealingOrchestrator } from "./healing/orchestrator.js";
import { ChaosEngine } from "./chaos/engine.js";
import { join } from "path";
import { mkdirSync } from "fs";

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "cli";

  // Ensure data directory exists
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });

  // Load config and policy
  const config = getConfig();
  const policyPath = join(getPoliciesDir(), "default.yaml");
  const policy = loadPolicy(policyPath);

  // Initialize event bus
  const eventBus = new EventBus();

  // Initialize governance
  const governance = new GovernanceEngine(policy);

  // Initialize tool registry
  const registry = new ToolRegistry();

  // Register Proxmox adapter
  if (config.proxmox.tokenId && config.proxmox.tokenSecret) {
    const proxmox = new ProxmoxAdapter({
      host: config.proxmox.host,
      port: config.proxmox.port,
      tokenId: config.proxmox.tokenId,
      tokenSecret: config.proxmox.tokenSecret,
      allowSelfSignedCerts: config.proxmox.allowSelfSignedCerts,
    });
    registry.registerAdapter(proxmox);
  }

  // Register system adapter
  const system = new SystemAdapter();
  registry.registerAdapter(system);

  // Connect all adapters
  await registry.connectAll();

  // Initialize agent core
  const agentCore = new AgentCore({
    toolRegistry: registry,
    governance,
    eventBus,
    config: {
      provider: config.ai.provider,
      apiKey: config.ai.apiKey,
      model: config.ai.model,
    },
  });

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down vClaw...");
    await registry.disconnectAll();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  switch (mode) {
    case "cli": {
      const cli = new vClawCLI(agentCore, registry, eventBus, governance);

      // If there's additional text after "cli", treat as one-shot
      const input = args.slice(1).join(" ");
      if (input) {
        await cli.runOnce(input);
      } else {
        await cli.start();
      }
      break;
    }

    case "telegram": {
      if (!config.telegram.botToken) {
        console.error("Error: TELEGRAM_BOT_TOKEN is required for telegram mode");
        process.exit(1);
      }
      const bot = new vClawBot(
        {
          botToken: config.telegram.botToken,
          allowedUsers: config.telegram.allowedUsers,
        },
        agentCore,
        registry,
        eventBus,
        governance,
      );
      await bot.start();
      break;
    }

    case "dashboard": {
      const dashboard = new DashboardServer(
        config.dashboard.port,
        agentCore,
        registry,
        eventBus,
        governance.audit
      );
      await dashboard.start();

      // If autopilot is enabled, start it alongside dashboard
      if (config.autopilot.enabled) {
        const autopilot = new AutopilotDaemon(
          registry,
          governance,
          eventBus,
          {
            pollIntervalMs: config.autopilot.pollIntervalMs,
            enabled: true,
          }
        );
        autopilot.start();
      }
      break;
    }

    case "mcp": {
      const mcp = new vClawMCP(agentCore, registry, eventBus, governance);
      await mcp.start();
      break;
    }

    case "autopilot": {
      const autopilot = new AutopilotDaemon(
        registry,
        governance,
        eventBus,
        {
          pollIntervalMs: config.autopilot.pollIntervalMs,
          enabled: true,
        }
      );
      autopilot.start();
      console.log(`Autopilot daemon started (polling every ${config.autopilot.pollIntervalMs}ms)`);

      // Also start dashboard for monitoring
      const dashboard = new DashboardServer(
        config.dashboard.port,
        agentCore,
        registry,
        eventBus,
        governance.audit
      );
      await dashboard.start();
      break;
    }

    case "full": {
      // Start everything
      console.log("Starting vClaw in full mode...\n");

      // Dashboard
      const dashboard = new DashboardServer(
        config.dashboard.port,
        agentCore,
        registry,
        eventBus,
        governance.audit
      );
      await dashboard.start();

      // Telegram (if configured)
      let fullBot: vClawBot | undefined;
      if (config.telegram.botToken) {
        fullBot = new vClawBot(
          {
            botToken: config.telegram.botToken,
            allowedUsers: config.telegram.allowedUsers,
          },
          agentCore,
          registry,
          eventBus,
          governance,
        );
        await fullBot.start();
      }

      // Autopilot (if enabled)
      if (config.autopilot.enabled) {
        const autopilot = new AutopilotDaemon(
          registry,
          governance,
          eventBus,
          {
            pollIntervalMs: config.autopilot.pollIntervalMs,
            enabled: true,
          }
        );
        autopilot.start();
      }

      // Self-healing orchestrator
      const healer = new HealingOrchestrator({
        agentCore,
        toolRegistry: registry,
        eventBus,
        governance,
        dataDir: join(dataDir, "healing"),
        config: {
          pollIntervalMs: config.autopilot.pollIntervalMs || 60000,
          healingEnabled: true,
          maxConcurrentHeals: 2,
        },
      });
      healer.start();
      console.log("  Self-healing orchestrator started");

      // Expose orchestrator on dashboard for API routes
      (dashboard as unknown as { healer: HealingOrchestrator }).healer = healer;

      // Chaos engineering engine
      const chaosEngine = new ChaosEngine({
        agentCore,
        toolRegistry: registry,
        eventBus,
        healingOrchestrator: healer,
      });

      // Expose on dashboard for API routes
      (dashboard as unknown as { chaosEngine: ChaosEngine }).chaosEngine = chaosEngine;

      // Wire chaos engine to Telegram bot
      if (fullBot) {
        fullBot.chaosEngine = chaosEngine;
      }

      console.log("  Chaos engineering engine ready");

      console.log("\nAll services running. Press Ctrl+C to stop.\n");
      break;
    }

    case "dev": {
      // Dashboard + Telegram + CLI — all sharing the same event bus
      // Type goals in the CLI and watch them stream live on the dashboard
      console.log("Starting vClaw in dev mode (Dashboard + Telegram + CLI)...\n");

      const dashboard = new DashboardServer(
        config.dashboard.port,
        agentCore,
        registry,
        eventBus,
        governance.audit
      );
      await dashboard.start();

      let devBot: vClawBot | undefined;
      if (config.telegram.botToken) {
        devBot = new vClawBot(
          {
            botToken: config.telegram.botToken,
            allowedUsers: config.telegram.allowedUsers,
          },
          agentCore,
          registry,
          eventBus,
          governance,
        );
        await devBot.start();
      }

      // Self-healing orchestrator
      const devHealer = new HealingOrchestrator({
        agentCore,
        toolRegistry: registry,
        eventBus,
        governance,
        dataDir: join(dataDir, "healing"),
        config: {
          pollIntervalMs: 60000,
          healingEnabled: true,
          maxConcurrentHeals: 2,
        },
      });
      devHealer.start();

      // Chaos engineering engine
      const devChaosEngine = new ChaosEngine({
        agentCore,
        toolRegistry: registry,
        eventBus,
        healingOrchestrator: devHealer,
      });

      // Expose on dashboard for API routes
      (dashboard as unknown as { chaosEngine: ChaosEngine }).chaosEngine = devChaosEngine;

      // Wire chaos engine to Telegram bot
      if (devBot) {
        devBot.chaosEngine = devChaosEngine;
      }

      const cli = new vClawCLI(agentCore, registry, eventBus, governance);
      await cli.start();
      break;
    }

    default: {
      // Treat as one-shot command
      const cli = new vClawCLI(agentCore, registry, eventBus, governance);
      const oneShot = args.join(" ");
      if (oneShot) {
        await cli.runOnce(oneShot);
      } else {
        console.log(`
vClaw — Autonomous Infrastructure Agent

Usage:
  vclaw                         Interactive CLI (REPL)
  vclaw cli                     Interactive CLI (REPL)
  vclaw cli "goal"              One-shot: plan and execute a goal
  vclaw "goal"                  One-shot: plan and execute a goal
  vclaw telegram                Start Telegram bot
  vclaw dashboard               Start web dashboard
  vclaw mcp                     Start MCP server (for Claude Code)
  vclaw autopilot               Start autopilot daemon + dashboard
  vclaw dev                     CLI + Dashboard + Telegram (best for testing)
  vclaw full                    Start all services (no CLI)

Environment (Proxmox):
  PROXMOX_HOST                  Proxmox VE host (default: localhost)
  PROXMOX_PORT                  Proxmox VE port (default: 8006)
  PROXMOX_TOKEN_ID              API token ID (user@realm!token)
  PROXMOX_TOKEN_SECRET          API token secret

Environment (VMware):
  VMWARE_HOST                   vCenter host
  VMWARE_USER                   vCenter username
  VMWARE_PASSWORD               vCenter password
  VMWARE_INSECURE               Skip TLS verification (default: true)

Environment (General):
  AI_PROVIDER                   LLM provider: anthropic | openai
  AI_API_KEY                    LLM API key
  AI_MODEL                      LLM model name
  TELEGRAM_BOT_TOKEN            Telegram bot token
  TELEGRAM_ALLOWED_USERS        Comma-separated Telegram user IDs
  DASHBOARD_PORT                Dashboard port (default: 3000)
  AUTOPILOT_ENABLED             Enable autopilot (default: false)
  AUTOPILOT_POLL_INTERVAL_MS    Poll interval in ms (default: 30000)
`);
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
