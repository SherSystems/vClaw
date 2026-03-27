import { describe, it, expect } from "vitest";
import { PrivacyRouter } from "../../src/security/privacy.js";

describe("PrivacyRouter", () => {
  const router = new PrivacyRouter();

  describe("redactText", () => {
    it("redacts Anthropic API keys", () => {
      const text = "Using key sk-ant-api03-abc123def456ghi789jkl012mno345pq";
      const result = router.redactText(text);
      expect(result.text).not.toContain("sk-ant-api03");
      expect(result.text).toContain("[REDACTED:anthropic_key]");
      expect(result.redaction_count).toBeGreaterThan(0);
      expect(result.categories).toContain("anthropic_api_key");
    });

    it("redacts OpenAI API keys", () => {
      const text = "Using key sk-proj-abc123def456ghi789jkl";
      const result = router.redactText(text);
      expect(result.text).not.toContain("sk-proj-abc123");
      expect(result.text).toContain("[REDACTED:api_key]");
    });

    it("redacts Proxmox API tokens", () => {
      const text = "Authorization: PVEAPIToken=root@pam!token=aabbccdd-1122-3344-5566-778899aabbcc";
      const result = router.redactText(text);
      expect(result.text).not.toContain("aabbccdd-1122-3344-5566-778899aabbcc");
      expect(result.text).toContain("[REDACTED]");
    });

    it("redacts private IPv4 addresses", () => {
      const text = "Connecting to 192.168.1.100 on port 8006. Also 10.0.0.50 and 172.16.0.1";
      const result = router.redactText(text);
      expect(result.text).not.toContain("192.168.1.100");
      expect(result.text).not.toContain("10.0.0.50");
      expect(result.text).not.toContain("172.16.0.1");
      expect(result.categories).toContain("private_ip");
    });

    it("preserves public IP addresses", () => {
      const text = "Fetching from 8.8.8.8 DNS server";
      const result = router.redactText(text);
      expect(result.text).toContain("8.8.8.8");
    });

    it("redacts password fields", () => {
      const text = 'password=VMware123! and secret: my-api-secret';
      const result = router.redactText(text);
      expect(result.text).not.toContain("VMware123!");
      expect(result.text).not.toContain("my-api-secret");
      expect(result.categories).toContain("password_field");
    });

    it("redacts SSH private keys", () => {
      const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
      const result = router.redactText(text);
      expect(result.text).not.toContain("MIIEpAIBAAKCAQEA");
      expect(result.text).toContain("[REDACTED:private_key]");
    });

    it("redacts Bearer tokens", () => {
      const text = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123";
      const result = router.redactText(text);
      expect(result.text).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
      expect(result.text).toContain("Bearer [REDACTED]");
    });

    it("redacts Telegram bot tokens", () => {
      const text = "Bot token: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789a";
      const result = router.redactText(text);
      expect(result.text).not.toContain("123456789:ABCdefGHI");
      expect(result.categories).toContain("telegram_token");
    });

    it("handles text with no sensitive data", () => {
      const text = "List all VMs on node pve1";
      const result = router.redactText(text);
      expect(result.text).toBe(text);
      expect(result.redaction_count).toBe(0);
      expect(result.categories).toHaveLength(0);
    });

    it("handles empty string", () => {
      const result = router.redactText("");
      expect(result.text).toBe("");
      expect(result.redaction_count).toBe(0);
    });

    it("handles multiple sensitive items in one text", () => {
      const text = "Connect to 192.168.1.1 with password=admin123 and token sk-ant-api03-abcdefghijklmnopqrstuvwx";
      const result = router.redactText(text);
      expect(result.text).not.toContain("192.168.1.1");
      expect(result.text).not.toContain("admin123");
      expect(result.text).not.toContain("sk-ant-api03");
      expect(result.redaction_count).toBeGreaterThanOrEqual(3);
    });
  });

  describe("redactObject", () => {
    it("redacts sensitive field names", () => {
      const obj = {
        host: "vcenter.lab.local",
        user: "admin",
        password: "VMware123!",
        port: 443,
      };
      const result = router.redactObject(obj);
      expect(result.host).toBe("vcenter.lab.local");
      expect(result.user).toBe("admin");
      expect(result.password).toBe("[REDACTED]");
      expect(result.port).toBe(443);
    });

    it("redacts nested sensitive fields", () => {
      const obj = {
        proxmox: {
          tokenId: "root@pam!token",
          tokenSecret: "my-secret-here",
        },
        vmware: {
          password: "vm-pass",
        },
      };
      const result = router.redactObject(obj);
      expect(result.proxmox.tokenSecret).toBe("[REDACTED]");
      expect(result.vmware.password).toBe("[REDACTED]");
      expect(result.proxmox.tokenId).toBe("root@pam!token"); // Not sensitive field name
    });

    it("redacts patterns within string values", () => {
      const obj = {
        log: "Connected to 192.168.1.100 successfully",
        note: "No sensitive data here",
      };
      const result = router.redactObject(obj);
      expect(result.log).not.toContain("192.168.1.100");
      expect(result.note).toBe("No sensitive data here");
    });

    it("handles arrays", () => {
      const obj = {
        hosts: ["192.168.1.1", "192.168.1.2"],
        names: ["pve1", "pve2"],
      };
      const result = router.redactObject(obj);
      expect(result.hosts[0]).toContain("[REDACTED:ip]");
      expect(result.names[0]).toBe("pve1");
    });

    it("handles null and undefined", () => {
      expect(router.redactObject(null)).toBeNull();
      expect(router.redactObject(undefined)).toBeUndefined();
    });

    it("handles primitive types", () => {
      expect(router.redactObject(42)).toBe(42);
      expect(router.redactObject(true)).toBe(true);
    });
  });

  describe("sanitizeForLLM", () => {
    it("sanitizes both system and user prompts", () => {
      const system = "You manage infrastructure at 192.168.1.0/24 with password=admin";
      const user = "Connect to 10.0.0.50 and list VMs";

      const result = router.sanitizeForLLM(system, user);

      expect(result.system).not.toContain("192.168.1.0");
      expect(result.system).not.toContain("admin");
      expect(result.user).not.toContain("10.0.0.50");
      expect(result.redactions.system.redaction_count).toBeGreaterThan(0);
      expect(result.redactions.user.redaction_count).toBeGreaterThan(0);
    });

    it("passes through clean prompts unchanged", () => {
      const system = "You are a helpful infrastructure assistant.";
      const user = "How many VMs are running?";

      const result = router.sanitizeForLLM(system, user);

      expect(result.system).toBe(system);
      expect(result.user).toBe(user);
      expect(result.redactions.system.redaction_count).toBe(0);
      expect(result.redactions.user.redaction_count).toBe(0);
    });
  });

  describe("custom patterns", () => {
    it("supports custom redaction patterns", () => {
      const customRouter = new PrivacyRouter({
        customPatterns: [
          { pattern: /VCSA-\d{4}-[A-Z]{4}/g, label: "vcenter_license" },
        ],
      });

      const text = "License: VCSA-1234-ABCD";
      const result = customRouter.redactText(text);
      expect(result.text).not.toContain("VCSA-1234-ABCD");
      expect(result.text).toContain("[REDACTED:vcenter_license]");
    });

    it("supports custom sensitive fields", () => {
      const customRouter = new PrivacyRouter({
        sensitiveFields: ["my_custom_secret"],
      });

      const obj = {
        my_custom_secret: "hidden",
        visible: "shown",
      };
      const result = customRouter.redactObject(obj);
      expect(result.my_custom_secret).toBe("[REDACTED]");
      expect(result.visible).toBe("shown");
    });
  });

  describe("mask", () => {
    it("masks a value showing first and last chars", () => {
      expect(PrivacyRouter.mask("sk-ant-api03-abcdef123456")).toBe("sk-a..3456");
    });

    it("masks short values entirely", () => {
      expect(PrivacyRouter.mask("abc")).toBe("***");
    });

    it("masks with custom visible chars", () => {
      expect(PrivacyRouter.mask("my-long-secret-value", 6)).toBe("my-lon..-value");
    });
  });
});
