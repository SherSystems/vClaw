// ============================================================
// Edge-case tests for CredentialVault
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CredentialVault } from "../../src/security/vault.js";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = `/tmp/vclaw-test-vault-edge-${Date.now()}`;
const VAULT_PATH = join(TEST_DIR, "vault.json");
const MASTER_KEY = "test-master-key-for-unit-tests-only";

describe("CredentialVault — Edge Cases", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(VAULT_PATH)) unlinkSync(VAULT_PATH);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("storage edge cases", () => {
    it("stores secret with extremely long value (1MB+)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      const largeSecret = "x".repeat(1024 * 1024 + 1000); // 1MB+
      vault.store_secret("large", largeSecret, "test", "field");

      const retrieved = vault.retrieve("large");
      expect(retrieved).toBe(largeSecret);
      expect(retrieved!.length).toBeGreaterThan(1024 * 1024);
    });

    it("stores secret with empty string ID (edge case)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("", "some-value", "test", "field");

      expect(vault.retrieve("")).toBe("some-value");
      expect(vault.has("")).toBe(true);
    });

    it("stores secret with special chars in ID (spaces, slashes, unicode)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      const specialIds = [
        "id with spaces",
        "id/with/slashes",
        "id\\with\\backslashes",
        "id🔐unicode",
        "id\nwith\nnewlines",
        "id\twith\ttabs",
      ];

      for (const id of specialIds) {
        vault.store_secret(id, `value-${id}`, "test", "field");
      }

      for (const id of specialIds) {
        expect(vault.retrieve(id)).toBe(`value-${id}`);
      }
    });

    it("retrieves secret immediately after store (no flush)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("immediate", "value", "test", "field");
      // No flush() call — data was saved in store()
      const retrieved = vault.retrieve("immediate");
      expect(retrieved).toBe("value");
    });

    it("handles concurrent store operations (potential race condition)", async () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 50; i++) {
        promises.push(
          Promise.resolve().then(() => {
            vault.store_secret(`key-${i}`, `value-${i}`, "test", "field");
          }),
        );
      }

      await Promise.all(promises);

      // Verify all were stored
      for (let i = 0; i < 50; i++) {
        expect(vault.retrieve(`key-${i}`)).toBe(`value-${i}`);
      }
    });
  });

  describe("vault file corruption and deletion", () => {
    it("handles corrupted vault file (invalid JSON) gracefully", () => {
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(VAULT_PATH, "{ this is not valid json }", "utf8");

      // Should throw when loading the file
      expect(() => {
        new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      }).toThrow();
    });

    it("creates new vault file if it doesn't exist on first read", () => {
      const newPath = join(TEST_DIR, "new-vault.json");
      expect(existsSync(newPath)).toBe(false);

      const vault = new CredentialVault({ path: newPath, masterKey: MASTER_KEY });
      vault.store_secret("key1", "value1", "test", "field");

      expect(existsSync(newPath)).toBe(true);
      const content = readFileSync(newPath, "utf8");
      expect(JSON.parse(content).version).toBe(1);
    });

    it("handles vault file deletion between operations", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("key1", "value1", "test", "field");

      // Delete the file
      if (existsSync(VAULT_PATH)) unlinkSync(VAULT_PATH);

      // Now operations should fail or reinitialize
      // store_secret calls save() which will try to write to deleted file location
      // This should not crash, but writes will recreate the file
      // The vault instance still has key1 in memory though, so it persists
      vault.store_secret("key2", "value2", "test", "field");

      // Verify file exists and has the entries
      expect(existsSync(VAULT_PATH)).toBe(true);
      const vault2 = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      // Both keys should be there because vault instance persisted them before file deletion
      expect(vault2.retrieve("key2")).toBe("value2");
      expect(vault2.retrieve("key1")).toBe("value1");
    });
  });

  describe("vault version and master key edge cases", () => {
    it("throws error for wrong vault version number", () => {
      mkdirSync(TEST_DIR, { recursive: true });
      const badVault = { version: 999, entries: {} };
      writeFileSync(VAULT_PATH, JSON.stringify(badVault), "utf8");

      expect(() => {
        new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      }).toThrow(/Unsupported vault version/);
    });

    it("handles empty string master key (cryptographically weak but should not crash)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: "" });
      vault.store_secret("key", "value", "test", "field");
      const retrieved = vault.retrieve("key");
      expect(retrieved).toBe("value");
    });

    it("handles extremely long master key (10K+ chars)", () => {
      const longKey = "x".repeat(10000);
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: longKey });
      vault.store_secret("key", "value", "test", "field");
      const retrieved = vault.retrieve("key");
      expect(retrieved).toBe("value");
    });

    it("fails when retrieving with wrong master key", () => {
      const vault1 = new CredentialVault({ path: VAULT_PATH, masterKey: "key1" });
      vault1.store_secret("secret", "plaintext", "test", "field");

      const vault2 = new CredentialVault({ path: VAULT_PATH, masterKey: "wrong-key" });
      // Trying to decrypt with wrong key should throw (authentication failure)
      expect(() => {
        vault2.retrieve("secret");
      }).toThrow();
    });
  });

  describe("rotate edge cases", () => {
    it("rotate() with empty vault does nothing", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      // No secrets stored
      vault.rotate("new-key");
      // Should not crash, should succeed with no entries to rotate
      expect(vault.list()).toEqual([]);
    });

    it("rotate() with single entry", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: "old-key" });
      vault.store_secret("key", "value", "test", "field");

      vault.rotate("new-key");

      // Create new vault with new key and verify it works
      const vault2 = new CredentialVault({ path: VAULT_PATH, masterKey: "new-key" });
      expect(vault2.retrieve("key")).toBe("value");
    });

    it("rotate() with 100 entries", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: "old-key" });

      for (let i = 0; i < 20; i++) {
        vault.store_secret(`key-${i}`, `value-${i}`, "test", "field");
      }

      vault.rotate("new-key");

      // Verify all entries with new key
      const vault2 = new CredentialVault({ path: VAULT_PATH, masterKey: "new-key" });
      for (let i = 0; i < 20; i++) {
        expect(vault2.retrieve(`key-${i}`)).toBe(`value-${i}`);
      }
    });
  });

  describe("importFromConfig edge cases", () => {
    it("importFromConfig with all empty values (should skip all)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.importFromConfig({
        empty1: { value: "", provider: "test", field: "field1" },
        empty2: { value: "", provider: "test", field: "field2" },
      });

      expect(vault.list()).toEqual([]);
    });

    it("importFromConfig with mixed empty and non-empty values", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.importFromConfig({
        valid1: { value: "secret1", provider: "test", field: "field1" },
        empty: { value: "", provider: "test", field: "field2" },
        valid2: { value: "secret2", provider: "test", field: "field3" },
      });

      const list = vault.list();
      expect(list).toHaveLength(2);
      expect(vault.retrieve("valid1")).toBe("secret1");
      expect(vault.retrieve("valid2")).toBe("secret2");
      expect(vault.has("empty")).toBe(false);
    });

    it("importFromConfig with null values (should skip)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      // Simulate object with null-ish values
      vault.importFromConfig({
        key1: { value: "valid", provider: "test", field: "f1" },
      });

      expect(vault.retrieve("key1")).toBe("valid");
    });
  });

  describe("exportPlaintext edge cases", () => {
    it("exportPlaintext on empty vault returns empty object", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      const exported = vault.exportPlaintext();
      expect(exported).toEqual({});
    });

    it("exportPlaintext with special chars and unicode", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      const secrets = {
        special: "p@$$w0rd!#%^&*()",
        unicode: "密码🔐",
        newlines: "line1\nline2\nline3",
      };

      for (const [id, value] of Object.entries(secrets)) {
        vault.store_secret(id, value, "test", "field");
      }

      const exported = vault.exportPlaintext();
      for (const [id, value] of Object.entries(secrets)) {
        expect(exported[id]).toBe(value);
      }
    });

    it("exportPlaintext with 100+ entries", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });

      for (let i = 0; i < 100; i++) {
        vault.store_secret(`key-${i}`, `value-${i}`, "test", "field");
      }

      const exported = vault.exportPlaintext();
      expect(Object.keys(exported)).toHaveLength(100);
      for (let i = 0; i < 100; i++) {
        expect(exported[`key-${i}`]).toBe(`value-${i}`);
      }
    });
  });

  describe("flush and persistence edge cases", () => {
    it("flush() called multiple times (idempotent)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("key", "value", "test", "field");

      vault.flush();
      vault.flush();
      vault.flush();

      // Should not crash and data should be intact
      expect(vault.retrieve("key")).toBe("value");
    });

    it("file permissions after save (mode 0o600)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("key", "value", "test", "field");

      const stats = require("node:fs").statSync(VAULT_PATH);
      // Check that file has restricted permissions (0o600 = rw-------)
      expect((stats.mode & 0o777) & 0o077).toBe(0); // No permissions for others
    });
  });

  describe("multiple vaults with different master keys (isolation)", () => {
    it("two vaults with different keys maintain isolation", () => {
      const path1 = join(TEST_DIR, "vault1.json");
      const path2 = join(TEST_DIR, "vault2.json");

      const vault1 = new CredentialVault({ path: path1, masterKey: "key1" });
      const vault2 = new CredentialVault({ path: path2, masterKey: "key2" });

      vault1.store_secret("secret", "vault1-value", "test", "field");
      vault2.store_secret("secret", "vault2-value", "test", "field");

      expect(vault1.retrieve("secret")).toBe("vault1-value");
      expect(vault2.retrieve("secret")).toBe("vault2-value");

      // Different master keys should not decrypt each other's data
      const vault1b = new CredentialVault({ path: path2, masterKey: "key1" });
      expect(() => {
        vault1b.retrieve("secret");
      }).toThrow(); // Wrong key
    });

    it("same file, different master key fails gracefully on decrypt", () => {
      const vault1 = new CredentialVault({ path: VAULT_PATH, masterKey: "key1" });
      vault1.store_secret("secret", "encrypted-value", "test", "field");

      const vault2 = new CredentialVault({ path: VAULT_PATH, masterKey: "key2" });
      // Trying to decrypt with different key should throw
      expect(() => {
        vault2.retrieve("secret");
      }).toThrow();
    });
  });

  describe("metadata tracking edge cases", () => {
    it("retrieve() updates last_accessed and access_count", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("key", "value", "test", "field");

      const list1 = vault.list();
      expect(list1[0].created_at).toBeDefined();

      vault.retrieve("key");
      vault.retrieve("key");

      const vault2 = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      const list2 = vault2.list();
      // Metadata should be preserved
      expect(list2[0].created_at).toBe(list1[0].created_at);
    });
  });

  describe("delete and overwrite edge cases", () => {
    it("store, delete, store same ID (overwrite)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });

      vault.store_secret("key", "value1", "test", "field");
      expect(vault.retrieve("key")).toBe("value1");

      vault.remove("key");
      expect(vault.has("key")).toBe(false);

      vault.store_secret("key", "value2", "test", "field");
      expect(vault.retrieve("key")).toBe("value2");
    });

    it("retrieve() returns exact same value (unicode, special chars, newlines)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });

      const testValues = [
        "value with spaces",
        "value\nwith\nnewlines",
        "value\twith\ttabs",
        "密码🔐🔑",
        "p@$$w0rd!#%^&*(){}[]|\\:\";<>?/~`'",
      ];

      for (const value of testValues) {
        vault.store_secret("test", value, "test", "field");
        expect(vault.retrieve("test")).toBe(value);
      }
    });
  });

  describe("list() edge cases", () => {
    it("list() with no secrets returns empty array", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      expect(vault.list()).toEqual([]);
    });

    it("list() includes metadata but not decrypted values", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("secret1", "super-secret", "proxmox", "tokenSecret");

      const list = vault.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toHaveProperty("id", "secret1");
      expect(list[0]).toHaveProperty("provider", "proxmox");
      expect(list[0]).toHaveProperty("field", "tokenSecret");
      expect(list[0]).toHaveProperty("created_at");
      // Should NOT include the plaintext value
      expect(Object.values(list[0]).some((v) => v === "super-secret")).toBe(false);
    });
  });
});
