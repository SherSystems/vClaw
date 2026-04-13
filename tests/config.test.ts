import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

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

  it("reads VMware and system SSH strict host key check env vars", async () => {
    vi.stubEnv("VMWARE_HOST", "vcsa.local");
    vi.stubEnv("VMWARE_USER", "administrator@vsphere.local");
    vi.stubEnv("VMWARE_PASSWORD", "secret");
    vi.stubEnv("VMWARE_INSECURE", "false");
    vi.stubEnv("SYSTEM_SSH_STRICT_HOST_KEY_CHECK", "false");

    const { getConfig } = await import("../src/config.js");
    const config = getConfig();

    expect(config.vmware.host).toBe("vcsa.local");
    expect(config.vmware.user).toBe("administrator@vsphere.local");
    expect(config.vmware.password).toBe("secret");
    expect(config.vmware.insecure).toBe(false);
    expect(config.system.sshStrictHostKeyCheck).toBe(false);
  });

  it("returns stable project, policies, and data directories", async () => {
    const { getProjectRoot, getPoliciesDir, getDataDir } = await import(
      "../src/config.js"
    );

    const root = getProjectRoot();
    expect(getPoliciesDir()).toBe(join(root, "policies"));
    expect(getDataDir()).toBe(join(root, "data"));
  });

  it("returns null from getOrCreateVault when vault key is missing", async () => {
    const { getOrCreateVault } = await import("../src/config.js");
    expect(getOrCreateVault()).toBeNull();
  });

  it("creates and caches vault instance when VCLAW_VAULT_KEY is set", async () => {
    vi.stubEnv("VCLAW_VAULT_KEY", "unit-test-master-key");

    const { getOrCreateVault } = await import("../src/config.js");
    const first = getOrCreateVault();
    const second = getOrCreateVault();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("migrates config secrets into the vault", async () => {
    const { migrateToVault } = await import("../src/config.js");
    const importFromConfig = vi.fn();
    const mockVault = { importFromConfig } as unknown as {
      importFromConfig: (secrets: Record<string, unknown>) => void;
    };

    migrateToVault(
      {
        proxmox: {
          host: "pve.local",
          port: 8006,
          tokenId: "root@pam!qa",
          tokenSecret: "proxmox-secret",
          allowSelfSignedCerts: true,
        },
        vmware: {
          host: "vcsa.local",
          user: "administrator",
          password: "vmware-secret",
          insecure: true,
        },
        system: { sshStrictHostKeyCheck: true },
        ai: {
          provider: "anthropic",
          apiKey: "ai-secret",
          model: "claude-sonnet-4-20250514",
        },
        dashboard: { port: 3000 },
        autopilot: { pollIntervalMs: 30000, enabled: false },
      },
      mockVault as never,
    );

    expect(importFromConfig).toHaveBeenCalledWith({
      "proxmox.tokenSecret": {
        value: "proxmox-secret",
        provider: "proxmox",
        field: "tokenSecret",
      },
      "vmware.password": {
        value: "vmware-secret",
        provider: "vmware",
        field: "password",
      },
      "ai.apiKey": {
        value: "ai-secret",
        provider: "ai",
        field: "apiKey",
      },
    });
  });
});
