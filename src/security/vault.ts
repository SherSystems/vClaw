// ============================================================
// vClaw — Credential Vault
// AES-256-GCM encrypted secret storage with key derivation
// Inspired by NemoClaw's credential isolation model
// ============================================================

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Types ────────────────────────────────────────────────────

export interface EncryptedSecret {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded 12-byte IV */
  iv: string;
  /** Base64-encoded 16-byte auth tag */
  tag: string;
  /** Base64-encoded 32-byte salt used for key derivation */
  salt: string;
  /** Timestamp of encryption */
  encrypted_at: string;
}

export interface VaultEntry {
  id: string;
  encrypted: EncryptedSecret;
  metadata: {
    provider: string;
    field: string;
    created_at: string;
    last_accessed?: string;
    access_count: number;
  };
}

export interface VaultStore {
  version: number;
  entries: Record<string, VaultEntry>;
}

export interface VaultOptions {
  /** Path to the vault file (JSON) */
  path: string;
  /** Master password for key derivation. In production, source from env/HSM. */
  masterKey: string;
}

// ── Constants ────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const SCRYPT_COST = 16384; // N parameter
const VAULT_VERSION = 1;

// ── Credential Vault ─────────────────────────────────────────

export class CredentialVault {
  private path: string;
  private masterKey: string;
  private store: VaultStore;

  constructor(options: VaultOptions) {
    this.path = options.path;
    this.masterKey = options.masterKey;
    this.store = this.load();
  }

  /**
   * Encrypt and store a secret.
   */
  store_secret(id: string, plaintext: string, provider: string, field: string): void {
    const encrypted = this.encrypt(plaintext);
    this.store.entries[id] = {
      id,
      encrypted,
      metadata: {
        provider,
        field,
        created_at: new Date().toISOString(),
        access_count: 0,
      },
    };
    this.save();
  }

  /**
   * Retrieve and decrypt a secret.
   */
  retrieve(id: string): string | null {
    const entry = this.store.entries[id];
    if (!entry) return null;

    entry.metadata.last_accessed = new Date().toISOString();
    entry.metadata.access_count++;
    // Don't save on every access — caller can call flush() if needed

    return this.decrypt(entry.encrypted);
  }

  /**
   * Check if a secret exists without decrypting it.
   */
  has(id: string): boolean {
    return id in this.store.entries;
  }

  /**
   * Remove a secret from the vault.
   */
  remove(id: string): boolean {
    if (!(id in this.store.entries)) return false;
    delete this.store.entries[id];
    this.save();
    return true;
  }

  /**
   * List all secret IDs with their metadata (no decryption).
   */
  list(): Array<{ id: string; provider: string; field: string; created_at: string }> {
    return Object.values(this.store.entries).map((e) => ({
      id: e.id,
      provider: e.metadata.provider,
      field: e.metadata.field,
      created_at: e.metadata.created_at,
    }));
  }

  /**
   * Rotate encryption: re-encrypt all secrets with a new master key.
   */
  rotate(newMasterKey: string): void {
    const decrypted: Array<{ id: string; plaintext: string; entry: VaultEntry }> = [];

    // Decrypt all with old key
    for (const entry of Object.values(this.store.entries)) {
      const plaintext = this.decrypt(entry.encrypted);
      decrypted.push({ id: entry.id, plaintext, entry });
    }

    // Switch to new key
    this.masterKey = newMasterKey;

    // Re-encrypt all with new key
    for (const { id, plaintext, entry } of decrypted) {
      entry.encrypted = this.encrypt(plaintext);
      this.store.entries[id] = entry;
    }

    this.save();
  }

  /**
   * Persist current state to disk.
   */
  flush(): void {
    this.save();
  }

  /**
   * Import secrets from a plain config object (e.g., from env vars).
   * Useful for initial migration from plaintext to vault.
   */
  importFromConfig(secrets: Record<string, { value: string; provider: string; field: string }>): void {
    for (const [id, { value, provider, field }] of Object.entries(secrets)) {
      if (value && value.length > 0) {
        this.store_secret(id, value, provider, field);
      }
    }
  }

  /**
   * Export all secrets as a plain object (for migration or backup).
   * WARNING: Returns plaintext — handle with care.
   */
  exportPlaintext(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [id, entry] of Object.entries(this.store.entries)) {
      result[id] = this.decrypt(entry.encrypted);
    }
    return result;
  }

  // ── Crypto Primitives ───────────────────────────────────────

  private deriveKey(salt: Buffer): Buffer {
    return scryptSync(this.masterKey, salt, KEY_LENGTH, { N: SCRYPT_COST }) as Buffer;
  }

  private encrypt(plaintext: string): EncryptedSecret {
    const salt = randomBytes(SALT_LENGTH);
    const key = this.deriveKey(salt);
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      salt: salt.toString("base64"),
      encrypted_at: new Date().toISOString(),
    };
  }

  private decrypt(secret: EncryptedSecret): string {
    const salt = Buffer.from(secret.salt, "base64");
    const key = this.deriveKey(salt);
    const iv = Buffer.from(secret.iv, "base64");
    const tag = Buffer.from(secret.tag, "base64");
    const ciphertext = Buffer.from(secret.ciphertext, "base64");

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  }

  // ── Persistence ─────────────────────────────────────────────

  private load(): VaultStore {
    if (!existsSync(this.path)) {
      return { version: VAULT_VERSION, entries: {} };
    }

    const raw = readFileSync(this.path, "utf8");
    const parsed = JSON.parse(raw) as VaultStore;

    if (parsed.version !== VAULT_VERSION) {
      throw new Error(`Unsupported vault version: ${parsed.version} (expected ${VAULT_VERSION})`);
    }

    return parsed;
  }

  private save(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.store, null, 2), { mode: 0o600 });
  }
}
