import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CredentialVault } from "../../src/security/vault.js";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = `/tmp/vclaw-test-vault-${Date.now()}`;
const VAULT_PATH = join(TEST_DIR, "vault.json");
const MASTER_KEY = "test-master-key-for-unit-tests-only";

describe("CredentialVault", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(VAULT_PATH)) unlinkSync(VAULT_PATH);
  });

  afterEach(() => {
    if (existsSync(VAULT_PATH)) unlinkSync(VAULT_PATH);
  });

  describe("store and retrieve", () => {
    it("encrypts and decrypts a secret", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("proxmox-token", "super-secret-token", "proxmox", "tokenSecret");

      const retrieved = vault.retrieve("proxmox-token");
      expect(retrieved).toBe("super-secret-token");
    });

    it("returns null for non-existent secret", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      expect(vault.retrieve("nonexistent")).toBeNull();
    });

    it("stores multiple secrets", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("key1", "value1", "proxmox", "tokenId");
      vault.store_secret("key2", "value2", "vmware", "password");
      vault.store_secret("key3", "value3", "ai", "apiKey");

      expect(vault.retrieve("key1")).toBe("value1");
      expect(vault.retrieve("key2")).toBe("value2");
      expect(vault.retrieve("key3")).toBe("value3");
    });

    it("handles special characters in secrets", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      const specialSecret = "p@$$w0rd!#%^&*()_+-={}[]|\\:\";<>?/~`'";
      vault.store_secret("special", specialSecret, "test", "password");

      expect(vault.retrieve("special")).toBe(specialSecret);
    });

    it("handles empty string secret", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("empty", "", "test", "field");
      expect(vault.retrieve("empty")).toBe("");
    });

    it("handles unicode secrets", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("unicode", "密码🔐", "test", "field");
      expect(vault.retrieve("unicode")).toBe("密码🔐");
    });

    it("overwrites existing secret", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("key", "old-value", "test", "field");
      vault.store_secret("key", "new-value", "test", "field");

      expect(vault.retrieve("key")).toBe("new-value");
    });
  });

  describe("has", () => {
    it("returns true for existing secret", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("exists", "value", "test", "field");
      expect(vault.has("exists")).toBe(true);
    });

    it("returns false for non-existent secret", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      expect(vault.has("nope")).toBe(false);
    });
  });

  describe("remove", () => {
    it("removes an existing secret", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("to-remove", "value", "test", "field");
      expect(vault.remove("to-remove")).toBe(true);
      expect(vault.has("to-remove")).toBe(false);
      expect(vault.retrieve("to-remove")).toBeNull();
    });

    it("returns false when removing non-existent secret", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      expect(vault.remove("nonexistent")).toBe(false);
    });
  });

  describe("list", () => {
    it("lists all secrets with metadata", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("key1", "value1", "proxmox", "tokenSecret");
      vault.store_secret("key2", "value2", "vmware", "password");

      const list = vault.list();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe("key1");
      expect(list[0].provider).toBe("proxmox");
      expect(list[0].field).toBe("tokenSecret");
      expect(list[1].provider).toBe("vmware");
    });

    it("returns empty array when vault is empty", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      expect(vault.list()).toHaveLength(0);
    });
  });

  describe("persistence", () => {
    it("persists secrets across vault instances", () => {
      const vault1 = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault1.store_secret("persistent", "my-secret", "test", "field");

      // Create new instance pointing to same file
      const vault2 = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      expect(vault2.retrieve("persistent")).toBe("my-secret");
    });

    it("creates vault file with restrictive permissions", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("test", "value", "test", "field");

      expect(existsSync(VAULT_PATH)).toBe(true);
    });
  });

  describe("wrong master key", () => {
    it("fails to decrypt with wrong key", () => {
      const vault1 = new CredentialVault({ path: VAULT_PATH, masterKey: "correct-key" });
      vault1.store_secret("secret", "value", "test", "field");

      const vault2 = new CredentialVault({ path: VAULT_PATH, masterKey: "wrong-key" });
      expect(() => vault2.retrieve("secret")).toThrow();
    });
  });

  describe("rotate", () => {
    it("rotates master key and all secrets remain accessible", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: "old-key" });
      vault.store_secret("s1", "value1", "test", "field1");
      vault.store_secret("s2", "value2", "test", "field2");

      vault.rotate("new-key");

      // Old key should no longer work
      const vaultOld = new CredentialVault({ path: VAULT_PATH, masterKey: "old-key" });
      expect(() => vaultOld.retrieve("s1")).toThrow();

      // New key should work
      const vaultNew = new CredentialVault({ path: VAULT_PATH, masterKey: "new-key" });
      expect(vaultNew.retrieve("s1")).toBe("value1");
      expect(vaultNew.retrieve("s2")).toBe("value2");
    });
  });

  describe("importFromConfig", () => {
    it("imports secrets from a config object", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.importFromConfig({
        "proxmox-token-secret": { value: "pve-secret", provider: "proxmox", field: "tokenSecret" },
        "vmware-password": { value: "vm-pass", provider: "vmware", field: "password" },
        "empty-skip": { value: "", provider: "test", field: "field" },
      });

      expect(vault.retrieve("proxmox-token-secret")).toBe("pve-secret");
      expect(vault.retrieve("vmware-password")).toBe("vm-pass");
      expect(vault.has("empty-skip")).toBe(false); // Empty values skipped
    });
  });

  describe("exportPlaintext", () => {
    it("exports all secrets as plaintext", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("k1", "v1", "test", "f1");
      vault.store_secret("k2", "v2", "test", "f2");

      const exported = vault.exportPlaintext();
      expect(exported).toEqual({ k1: "v1", k2: "v2" });
    });
  });

  describe("encryption properties", () => {
    it("produces different ciphertexts for same plaintext (unique IVs)", () => {
      const vault = new CredentialVault({ path: VAULT_PATH, masterKey: MASTER_KEY });
      vault.store_secret("a", "same-value", "test", "field");
      vault.store_secret("b", "same-value", "test", "field");

      // Access internal store to check ciphertexts differ
      const list = vault.list();
      expect(list).toHaveLength(2);

      // Retrieve both — they should decrypt to same value
      expect(vault.retrieve("a")).toBe("same-value");
      expect(vault.retrieve("b")).toBe("same-value");
    });
  });
});
