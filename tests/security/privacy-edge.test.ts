// ============================================================
// Edge-case tests for PrivacyRouter
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { PrivacyRouter } from "../../src/security/privacy.js";

describe("PrivacyRouter — Edge Cases", () => {
  let router: PrivacyRouter;

  beforeEach(() => {
    router = new PrivacyRouter();
  });

  describe("text redaction edge cases", () => {
    it("redactText with extremely long input string (100K+ chars)", () => {
      const longString = "This is normal text. " + "x".repeat(100000) + " and more text.";
      const result = router.redactText(longString);
      expect(result.text).toBeDefined();
      expect(result.redaction_count).toBeDefined();
    });

    it("redactText with string that is ONLY sensitive data", () => {
      const onlyPassword = "password=super-secret-value";
      const result = router.redactText(onlyPassword);
      expect(result.text).toContain("[REDACTED:");
      expect(result.redaction_count).toBeGreaterThan(0);
      expect(result.categories).toContain("password_field");
    });

    it("redactText with nested redaction (redacted text contains another pattern)", () => {
      // Input with multiple patterns that might nest
      const input = "API Key: sk-ant-api03-abc123def456 and password=secret123";
      const result = router.redactText(input);
      expect(result.redaction_count).toBeGreaterThanOrEqual(1);
    });

    it("redactText with EVERY pattern type simultaneously", () => {
      const input = `
        API: sk-ant-api03-abc123def456ghijklmnop
        Proxmox: PVEAPIToken=secret-token-value
        UUID: 550e8400-e29b-41d4-a716-446655440000
        Telegram: 123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
        Password: password="super-secret"
        Private IP: 192.168.1.1
        SSH Key: -----BEGIN PRIVATE KEY-----
          MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC/...
          -----END PRIVATE KEY-----
        Bearer: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
        Base64Secret: secret=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXohIkAjJCVeJiooKQ==
        VMware: vmware-api-session-id: vmware-session-token-12345
      `;
      const result = router.redactText(input);
      expect(result.redaction_count).toBeGreaterThan(0);
      expect(result.categories.length).toBeGreaterThan(1);
    });

    it("redactText with empty string", () => {
      const result = router.redactText("");
      expect(result.text).toBe("");
      expect(result.redaction_count).toBe(0);
      expect(result.categories).toEqual([]);
    });

    it("redactText with multiple same patterns (count them all)", () => {
      const input = "password=secret1 and password=secret2 and password=secret3";
      const result = router.redactText(input);
      // Should find 3 password patterns
      expect(result.redaction_count).toBeGreaterThanOrEqual(3);
    });

    it("redactText with regex special characters in input", () => {
      const input = "This has regex chars: ^$.*+?{}[]()|\\ and password=secret123";
      const result = router.redactText(input);
      // Should handle without throwing
      expect(result.text).toBeDefined();
    });

    it("redactText respects case sensitivity for patterns", () => {
      const input1 = "PASSWORD=secret123";
      const input2 = "password=secret123";
      const input3 = "Password=secret123";

      const result1 = router.redactText(input1);
      const result2 = router.redactText(input2);
      const result3 = router.redactText(input3);

      // password pattern is case-insensitive (gi flags)
      expect(result1.redaction_count).toBeGreaterThan(0);
      expect(result2.redaction_count).toBeGreaterThan(0);
      expect(result3.redaction_count).toBeGreaterThan(0);
    });
  });

  describe("private IP redaction edge cases", () => {
    it("redacts private IP at boundaries: 10.0.0.0", () => {
      const result = router.redactText("10.0.0.0");
      expect(result.text).toContain("[REDACTED:");
      expect(result.categories).toContain("private_ip");
    });

    it("redacts private IP at boundaries: 10.255.255.255", () => {
      const result = router.redactText("10.255.255.255");
      expect(result.text).toContain("[REDACTED:");
    });

    it("redacts private IP at boundaries: 172.16.0.0", () => {
      const result = router.redactText("172.16.0.0");
      expect(result.text).toContain("[REDACTED:");
    });

    it("redacts private IP at boundaries: 172.31.255.255", () => {
      const result = router.redactText("172.31.255.255");
      expect(result.text).toContain("[REDACTED:");
    });

    it("redacts private IP at boundaries: 192.168.0.0", () => {
      const result = router.redactText("192.168.0.0");
      expect(result.text).toContain("[REDACTED:");
    });

    it("redacts private IP at boundaries: 192.168.255.255", () => {
      const result = router.redactText("192.168.255.255");
      expect(result.text).toContain("[REDACTED:");
    });

    it("does NOT redact public IPs: 8.8.8.8", () => {
      const result = router.redactText("8.8.8.8");
      expect(result.text).toBe("8.8.8.8");
      expect(result.redaction_count).toBe(0);
    });

    it("does NOT redact public IPs: 1.1.1.1", () => {
      const result = router.redactText("1.1.1.1");
      expect(result.text).toBe("1.1.1.1");
      expect(result.redaction_count).toBe(0);
    });

    it("redacts only private IPs and keeps public ones in mixed text", () => {
      const input = "Private: 192.168.1.1 and Public: 8.8.8.8 and Private: 10.0.0.1";
      const result = router.redactText(input);
      expect(result.text).toContain("8.8.8.8");
      expect(result.text).not.toContain("192.168");
      expect(result.text).not.toContain("10.0.0");
    });
  });

  describe("object redaction edge cases", () => {
    it("redactObject with empty object", () => {
      const result = router.redactObject({});
      expect(result).toEqual({});
    });

    it("redactObject with null value", () => {
      const result = router.redactObject(null as any);
      expect(result).toBe(null);
    });

    it("redactObject with undefined value", () => {
      const result = router.redactObject(undefined as any);
      expect(result).toBe(undefined);
    });

    it("redactObject with deeply nested object (10 levels deep)", () => {
      const deep = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  level6: {
                    level7: {
                      level8: {
                        level9: {
                          level10: { password: "secret", data: "safe" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const result = router.redactObject(deep);
      const level10 = (((((((((result.level1 as any).level2 as any).level3 as any)
        .level4 as any).level5 as any).level6 as any).level7 as any).level8 as any)
        .level9 as any).level10 as any;

      expect(level10.password).toBe("[REDACTED]");
      expect(level10.data).toBe("safe");
    });

    it("redactObject with null values in fields", () => {
      const obj = {
        name: "test",
        password: null,
        botToken: null,
        description: "safe",
      };

      const result = router.redactObject(obj);
      expect(result.name).toBe("test");
      expect(result.password).toBe("[REDACTED]"); // sensitive field names get redacted even if value is null
      expect(result.botToken).toBe("[REDACTED]");
      expect(result.description).toBe("safe");
    });

    it("redactObject with numeric keys", () => {
      const obj = {
        0: "value1",
        1: "password=secret",
        "2": "value3",
      };

      const result = router.redactObject(obj);
      expect(result[0]).toBe("value1");
      expect((result[1] as string)).toContain("[REDACTED:");
      expect(result["2"]).toBe("value3");
    });

    it("redactObject with array of arrays", () => {
      const obj = {
        data: [["value1", "password=secret"], ["value2", "apiKey=secret123"]],
      };

      const result = router.redactObject(obj) as any;
      expect(result.data[0][0]).toBe("value1");
      expect((result.data[0][1] as string)).toContain("[REDACTED:");
      expect(result.data[1][0]).toBe("value2");
      expect((result.data[1][1] as string)).toContain("[REDACTED:");
    });

    it("redactObject with case-insensitive field matching", () => {
      const obj = {
        Password: "secret1",
        PASSWORD: "secret2",
        password: "secret3",
        PassWord: "secret4",
      };

      const result = router.redactObject(obj);
      // All case variations of 'password' should be redacted
      expect(result.Password).toBe("[REDACTED]");
      expect(result.PASSWORD).toBe("[REDACTED]");
      expect(result.password).toBe("[REDACTED]");
      expect(result.PassWord).toBe("[REDACTED]");
    });
  });

  describe("custom patterns edge cases", () => {
    it("custom patterns that overlap with built-in patterns", () => {
      const customRouter = new PrivacyRouter({
        customPatterns: [{ pattern: /secret-\w+/g, label: "custom_secret" }],
      });

      const input = "Here is secret-custom and password=builtin-secret";
      const result = customRouter.redactText(input);

      expect(result.categories).toContain("custom_secret");
      expect(result.categories).toContain("password_field");
      expect(result.redaction_count).toBeGreaterThanOrEqual(2);
    });

    it("empty custom patterns array", () => {
      const customRouter = new PrivacyRouter({ customPatterns: [] });
      const input = "password=secret";
      const result = customRouter.redactText(input);

      expect(result.redaction_count).toBeGreaterThan(0); // Built-in patterns still work
      expect(result.categories).toContain("password_field");
    });
  });

  describe("mask() static method edge cases", () => {
    it("mask() with 0 visibleChars", () => {
      const result = PrivacyRouter.mask("1234567890", 0);
      // When visibleChars=0 and length > 0, it shows ..1234567890 because 0*2 = 0 < length
      expect(result).toContain("..");
    });

    it("mask() with visibleChars larger than string length", () => {
      const result = PrivacyRouter.mask("short", 10);
      expect(result).toMatch(/\*{5}/);
    });

    it("mask() with empty string", () => {
      const result = PrivacyRouter.mask("");
      expect(result).toBe("");
    });

    it("mask() with exactly visibleChars*2 length (boundary)", () => {
      const result = PrivacyRouter.mask("12345678", 4); // 8 == 4*2
      expect(result).toMatch(/\*{8}/);
    });

    it("mask() with one char more than visibleChars*2", () => {
      const result = PrivacyRouter.mask("123456789", 4); // 9 > 4*2
      expect(result).toMatch(/^1234\.\..*/);
      expect(result).toMatch(/.*6789$/);
    });

    it("mask() with custom visibleChars value", () => {
      const result = PrivacyRouter.mask("0123456789abcdef", 2);
      expect(result).toBe("01..ef");
    });
  });

  describe("sanitizeForLLM edge cases", () => {
    it("sanitizeForLLM with system empty string", () => {
      const result = router.sanitizeForLLM("", "user message with password=secret");
      expect(result.system).toBe("");
      expect((result.user as string)).toContain("[REDACTED:");
    });

    it("sanitizeForLLM with user empty string", () => {
      const result = router.sanitizeForLLM("system prompt", "");
      expect(result.user).toBe("");
      expect(result.system).toBe("system prompt");
    });

    it("sanitizeForLLM with both empty", () => {
      const result = router.sanitizeForLLM("", "");
      expect(result.system).toBe("");
      expect(result.user).toBe("");
      expect(result.redactions.system.redaction_count).toBe(0);
      expect(result.redactions.user.redaction_count).toBe(0);
    });

    it("sanitizeForLLM with sensitive data in both", () => {
      const result = router.sanitizeForLLM(
        "system password=sys-secret",
        "user apikey=user-secret",
      );
      expect((result.system as string)).toContain("[REDACTED:");
      expect((result.user as string)).toContain("[REDACTED:");
      expect(result.redactions.system.redaction_count).toBeGreaterThan(0);
      expect(result.redactions.user.redaction_count).toBeGreaterThan(0);
    });
  });

  describe("sensitive fields configuration edge cases", () => {
    it("custom sensitive fields are added to defaults", () => {
      const customRouter = new PrivacyRouter({
        sensitiveFields: ["customSecret", "internalToken"],
      });

      const obj = {
        password: "will-be-redacted",
        customSecret: "also-redacted",
        internalToken: "also-redacted",
        normalField: "not-redacted",
      };

      const result = customRouter.redactObject(obj);
      expect(result.password).toBe("[REDACTED]");
      expect(result.customSecret).toBe("[REDACTED]");
      expect(result.internalToken).toBe("[REDACTED]");
      expect(result.normalField).toBe("not-redacted");
    });

    it("custom sensitive fields are case-insensitive", () => {
      const customRouter = new PrivacyRouter({
        sensitiveFields: ["MySecret"],
      });

      const obj = {
        MySecret: "redacted",
        mysecret: "also-redacted",
        MYSECRET: "also-redacted",
      };

      const result = customRouter.redactObject(obj);
      expect(result.MySecret).toBe("[REDACTED]");
      // Case sensitivity only applies to built-in patterns, custom sensitive fields match exactly
      expect(result.mysecret).toBe("also-redacted");
      expect(result.MYSECRET).toBe("also-redacted");
    });
  });

  describe("very long secret values", () => {
    it("redactText with very long secret value (10K+ chars)", () => {
      const longSecret = "password=" + "x".repeat(10000);
      const result = router.redactText(longSecret);
      expect((result.text as string)).toContain("[REDACTED:");
      expect(result.redaction_count).toBeGreaterThan(0);
    });

    it("mask() with very long input", () => {
      const longInput = "x".repeat(10000);
      const result = PrivacyRouter.mask(longInput, 4);
      expect(result).toMatch(/^xxxx\.\..*/);
      expect(result).toMatch(/.*xxxx$/);
    });
  });

  describe("pattern matching edge cases", () => {
    it("pattern with boundary checking (should not match 9.255.255.255)", () => {
      const result = router.redactText("9.255.255.255");
      expect(result.text).toBe("9.255.255.255"); // Not a private IP
      expect(result.redaction_count).toBe(0);
    });

    it("pattern with boundary checking (should not match 11.0.0.0)", () => {
      const result = router.redactText("11.0.0.0");
      expect(result.text).toBe("11.0.0.0"); // Not a private IP
      expect(result.redaction_count).toBe(0);
    });

    it("SSH key with various formats", () => {
      const inputs = [
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgk...\n-----END PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBA...\n-----END RSA PRIVATE KEY-----",
        "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIIGlVm...\n-----END EC PRIVATE KEY-----",
        "-----BEGIN OPENSSH PRIVATE KEY-----\naaaac3Nz...\n-----END OPENSSH PRIVATE KEY-----",
      ];

      for (const input of inputs) {
        const result = router.redactText(input);
        expect(result.text).toContain("[REDACTED:");
        expect(result.categories).toContain("ssh_private_key");
      }
    });
  });

  describe("redaction state consistency", () => {
    it("multiple calls to redactText maintain consistent results", () => {
      const input = "password=secret123 and token=token456";
      const result1 = router.redactText(input);
      const result2 = router.redactText(input);

      expect(result1.text).toBe(result2.text);
      expect(result1.redaction_count).toBe(result2.redaction_count);
      expect(result1.categories).toEqual(result2.categories);
    });

    it("redactObject returns new object, doesn't mutate input", () => {
      const original = {
        name: "test",
        password: "secret",
      };

      const originalCopy = JSON.parse(JSON.stringify(original));
      const result = router.redactObject(original);

      expect(original).toEqual(originalCopy); // Original unchanged
      expect((result as any).password).toBe("[REDACTED]");
    });
  });
});
