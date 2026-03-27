import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dotenv so it doesn't load .env file at import time
vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
  config: vi.fn(),
}));

describe("getConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns defaults when no env vars are set", async () => {
    const { getConfig } = await import("../src/config.js");
    const config = getConfig();

    expect(config.proxmox.host).toBe("localhost");
    expect(config.proxmox.port).toBe(8006);
    expect(config.proxmox.tokenId).toBe("");
    expect(config.proxmox.tokenSecret).toBe("");
    expect(config.proxmox.allowSelfSignedCerts).toBe(true);
    expect(config.ai.provider).toBe("anthropic");
    expect(config.ai.model).toBe("claude-sonnet-4-20250514");
    expect(config.dashboard.port).toBe(3000);
    expect(config.autopilot.enabled).toBe(false);
    expect(config.autopilot.pollIntervalMs).toBe(30000);
  });

  it("reads PROXMOX_HOST from env", async () => {
    vi.stubEnv("PROXMOX_HOST", "10.0.0.1");
    const { getConfig } = await import("../src/config.js");
    const config = getConfig();
    expect(config.proxmox.host).toBe("10.0.0.1");
  });

  it("reads PROXMOX_PORT and coerces to number", async () => {
    vi.stubEnv("PROXMOX_PORT", "9999");
    const { getConfig } = await import("../src/config.js");
    const config = getConfig();
    expect(config.proxmox.port).toBe(9999);
    expect(typeof config.proxmox.port).toBe("number");
  });

  it('parses PROXMOX_ALLOW_SELF_SIGNED "true"/"false" to boolean', async () => {
    vi.stubEnv("PROXMOX_ALLOW_SELF_SIGNED", "false");
    const { getConfig } = await import("../src/config.js");
    const config = getConfig();
    expect(config.proxmox.allowSelfSignedCerts).toBe(false);
  });

  it('parses AUTOPILOT_ENABLED "true" to boolean true', async () => {
    vi.stubEnv("AUTOPILOT_ENABLED", "true");
    const { getConfig } = await import("../src/config.js");
    const config = getConfig();
    expect(config.autopilot.enabled).toBe(true);
  });

  it("caches config (calling twice returns same object)", async () => {
    const { getConfig } = await import("../src/config.js");
    const first = getConfig();
    const second = getConfig();
    expect(first).toBe(second);
  });

  it('AI provider validates "anthropic"', async () => {
    vi.stubEnv("AI_PROVIDER", "anthropic");
    const { getConfig } = await import("../src/config.js");
    const config = getConfig();
    expect(config.ai.provider).toBe("anthropic");
  });

  it('AI provider validates "openai"', async () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    const { getConfig } = await import("../src/config.js");
    const config = getConfig();
    expect(config.ai.provider).toBe("openai");
  });

  it("AI provider rejects invalid value", async () => {
    vi.stubEnv("AI_PROVIDER", "invalid_provider");
    const { getConfig } = await import("../src/config.js");
    expect(() => getConfig()).toThrow();
  });
});
