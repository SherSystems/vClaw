import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigSchema } from "../../src/config.js";

describe("Config", () => {
  describe("ConfigSchema", () => {
    it("parses with all defaults when empty", () => {
      const config = ConfigSchema.parse({
        proxmox: {},
        vmware: {},
        ai: {},
        dashboard: {},
        autopilot: {},
      });

      expect(config.proxmox.host).toBe("localhost");
      expect(config.proxmox.port).toBe(8006);
      expect(config.proxmox.tokenId).toBe("");
      expect(config.proxmox.tokenSecret).toBe("");
      expect(config.proxmox.allowSelfSignedCerts).toBe(true);

      expect(config.vmware.host).toBe("");
      expect(config.vmware.user).toBe("");
      expect(config.vmware.password).toBe("");
      expect(config.vmware.insecure).toBe(true);

      expect(config.ai.provider).toBe("anthropic");
      expect(config.ai.model).toContain("claude");

      expect(config.dashboard.port).toBe(3000);
      expect(config.autopilot.enabled).toBe(false);
    });

    it("parses Proxmox config from env-like values", () => {
      const config = ConfigSchema.parse({
        proxmox: {
          host: "10.0.0.50",
          port: "8006",
          tokenId: "root@pam!mytoken",
          tokenSecret: "aabbccdd-1122-3344-5566-778899aabbcc",
          allowSelfSignedCerts: "true",
        },
        vmware: {},
        ai: {},
        dashboard: {},
        autopilot: {},
      });

      expect(config.proxmox.host).toBe("10.0.0.50");
      expect(config.proxmox.port).toBe(8006);
      expect(config.proxmox.tokenId).toBe("root@pam!mytoken");
      expect(config.proxmox.tokenSecret).toBe("aabbccdd-1122-3344-5566-778899aabbcc");
      expect(config.proxmox.allowSelfSignedCerts).toBe(true);
    });

    it("parses VMware config from env-like values", () => {
      const config = ConfigSchema.parse({
        proxmox: {},
        vmware: {
          host: "vcenter.lab.local",
          user: "administrator@vsphere.local",
          password: "VMware123!",
          insecure: "true",
        },
        ai: {},
        dashboard: {},
        autopilot: {},
      });

      expect(config.vmware.host).toBe("vcenter.lab.local");
      expect(config.vmware.user).toBe("administrator@vsphere.local");
      expect(config.vmware.password).toBe("VMware123!");
      expect(config.vmware.insecure).toBe(true);
    });

    it("parses VMware insecure=false", () => {
      const config = ConfigSchema.parse({
        proxmox: {},
        vmware: { insecure: "false" },
        ai: {},
        dashboard: {},
        autopilot: {},
      });

      expect(config.vmware.insecure).toBe(false);
    });

    it("parses AI config", () => {
      const config = ConfigSchema.parse({
        proxmox: {},
        vmware: {},
        ai: {
          provider: "openai",
          apiKey: "sk-test-key",
          model: "gpt-4o",
        },
        dashboard: {},
        autopilot: {},
      });

      expect(config.ai.provider).toBe("openai");
      expect(config.ai.apiKey).toBe("sk-test-key");
      expect(config.ai.model).toBe("gpt-4o");
    });

    it("parses autopilot config", () => {
      const config = ConfigSchema.parse({
        proxmox: {},
        vmware: {},
        ai: {},
        dashboard: {},
        autopilot: {
          pollIntervalMs: "60000",
          enabled: "true",
        },
      });

      expect(config.autopilot.pollIntervalMs).toBe(60000);
      expect(config.autopilot.enabled).toBe(true);
    });

    it("coerces port from string to number", () => {
      const config = ConfigSchema.parse({
        proxmox: { port: "9006" },
        vmware: {},
        ai: {},
        dashboard: { port: "8080" },
        autopilot: {},
      });

      expect(config.proxmox.port).toBe(9006);
      expect(config.dashboard.port).toBe(8080);
    });

    it("supports both Proxmox and VMware simultaneously", () => {
      const config = ConfigSchema.parse({
        proxmox: {
          host: "10.0.0.50",
          tokenId: "root@pam!token",
          tokenSecret: "secret",
        },
        vmware: {
          host: "vcenter.lab.local",
          user: "admin@vsphere.local",
          password: "pass",
        },
        ai: {},
        dashboard: {},
        autopilot: {},
      });

      // Both configured
      expect(config.proxmox.host).toBe("10.0.0.50");
      expect(config.vmware.host).toBe("vcenter.lab.local");
    });
  });
});
