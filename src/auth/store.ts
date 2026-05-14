// ============================================================
// RHODES — Auth User Store
// File-backed user store at ~/.rhodes/users.json
// Schema validated with zod, mode 0600 enforced.
// ============================================================

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const RoleSchema = z.enum(["admin", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const UserRecordSchema = z.object({
  username: z.string().min(1),
  bcrypt_hash: z.string().min(1),
  role: RoleSchema,
  created_at: z.string().min(1),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const UserStoreFileSchema = z.object({
  users: z.array(UserRecordSchema),
});
export type UserStoreFile = z.infer<typeof UserStoreFileSchema>;

const FILE_MODE = 0o600;

/**
 * Resolve the location of the users.json file.
 * Override via $RHODES_AUTH_USERS_FILE (test + custom-deploy use).
 */
export function getUsersFilePath(): string {
  const override = process.env.RHODES_AUTH_USERS_FILE;
  if (override && override.length > 0) return override;
  return join(homedir(), ".rhodes", "users.json");
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Throws if the file exists and is readable/writeable by group or world.
 * On startup, we refuse to open a users file with broader permissions.
 */
function assertFileMode(path: string): void {
  const st = statSync(path);
  // Permission bits — mask off file type
  const perm = st.mode & 0o777;
  if (perm & 0o077) {
    throw new Error(
      `[auth/store] Refusing to read ${path}: mode is ${perm.toString(8)}, must be 600`,
    );
  }
}

/**
 * Atomic write: write to .tmp, fsync, rename. File mode 0600 enforced.
 */
function atomicWrite(path: string, data: string): void {
  ensureParentDir(path);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", FILE_MODE);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export interface UserStoreOptions {
  /** Override file path (test injection). */
  path?: string;
}

/**
 * File-backed user store. Stateless wrapper that round-trips the JSON file
 * on every read; auth lookups are infrequent (login, whoami) so we don't
 * bother with caching.
 */
export class UserStore {
  private readonly path: string;

  constructor(opts: UserStoreOptions = {}) {
    this.path = opts.path ?? getUsersFilePath();
  }

  /** Path on disk. Exposed for diagnostics / tests. */
  get filePath(): string {
    return this.path;
  }

  /** True if the users file exists and is non-empty. */
  exists(): boolean {
    return existsSync(this.path);
  }

  /** Returns whether any users are configured (bootstrap detection). */
  isBootstrapped(): boolean {
    if (!this.exists()) return false;
    try {
      const file = this.readRaw();
      return file.users.length > 0;
    } catch {
      return false;
    }
  }

  /** Parse the file. Throws on bad mode or invalid JSON/schema. */
  readRaw(): UserStoreFile {
    if (!existsSync(this.path)) {
      return { users: [] };
    }
    assertFileMode(this.path);
    const raw = readFileSync(this.path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `[auth/store] ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    return UserStoreFileSchema.parse(parsed);
  }

  /** All users (do NOT return hashes to callers that don't need them). */
  list(): UserRecord[] {
    return this.readRaw().users;
  }

  /** Look up a single user by username; returns null if missing. */
  find(username: string): UserRecord | null {
    const file = this.readRaw();
    return file.users.find((u) => u.username === username) ?? null;
  }

  /** Insert or update a user. Returns the new file state. */
  upsert(user: UserRecord): UserStoreFile {
    UserRecordSchema.parse(user);
    const file = this.exists() ? this.readRaw() : { users: [] };
    const idx = file.users.findIndex((u) => u.username === user.username);
    if (idx >= 0) {
      file.users[idx] = user;
    } else {
      file.users.push(user);
    }
    this.writeRaw(file);
    return file;
  }

  /** Remove a user by username. Returns true if present. */
  remove(username: string): boolean {
    if (!this.exists()) return false;
    const file = this.readRaw();
    const before = file.users.length;
    file.users = file.users.filter((u) => u.username !== username);
    if (file.users.length === before) return false;
    this.writeRaw(file);
    return true;
  }

  /** Persist file with atomic rename and 0600 mode. */
  writeRaw(file: UserStoreFile): void {
    UserStoreFileSchema.parse(file);
    const json = JSON.stringify(file, null, 2);
    atomicWrite(this.path, json);
  }
}
