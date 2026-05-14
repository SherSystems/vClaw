import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, chmodSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserStore } from "../../src/auth/store.js";

describe("UserStore", () => {
  let tmpDir: string;
  let filePath: string;
  let store: UserStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rhodes-auth-"));
    filePath = join(tmpDir, "users.json");
    store = new UserStore({ path: filePath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts empty / not bootstrapped", () => {
    expect(store.exists()).toBe(false);
    expect(store.isBootstrapped()).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("round-trips users through JSON file", () => {
    const user = {
      username: "pranav",
      bcrypt_hash: "$2b$12$abcdefghijklmnopqrstuv.fakefakefakefakefakefakefakefake", // secret-scan: allow
      role: "admin" as const,
      created_at: "2026-05-14T12:00:00.000Z",
    };
    store.upsert(user);
    const reread = new UserStore({ path: filePath });
    expect(reread.list()).toEqual([user]);
    expect(reread.find("pranav")).toEqual(user);
    expect(reread.find("ghost")).toBeNull();
  });

  it("writes the file with mode 0600", () => {
    store.upsert({
      username: "u",
      bcrypt_hash: "$2b$12$x".padEnd(60, "y"),
      role: "viewer",
      created_at: "2026-05-14T00:00:00Z",
    });
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses to read a file with broader permissions", () => {
    store.upsert({
      username: "u",
      bcrypt_hash: "$2b$12$x".padEnd(60, "y"),
      role: "viewer",
      created_at: "2026-05-14T00:00:00Z",
    });
    chmodSync(filePath, 0o644);
    expect(() => new UserStore({ path: filePath }).list()).toThrow(/mode/);
  });

  it("uses atomic write — no .tmp file left behind on success", () => {
    store.upsert({
      username: "u",
      bcrypt_hash: "$2b$12$x".padEnd(60, "y"),
      role: "admin",
      created_at: "2026-05-14T00:00:00Z",
    });
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it("upsert replaces an existing user", () => {
    store.upsert({
      username: "u",
      bcrypt_hash: "h1".padEnd(60, "x"),
      role: "viewer",
      created_at: "2026-01-01T00:00:00Z",
    });
    store.upsert({
      username: "u",
      bcrypt_hash: "h2".padEnd(60, "x"),
      role: "admin",
      created_at: "2026-02-01T00:00:00Z",
    });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe("admin");
    expect(list[0].bcrypt_hash).toMatch(/^h2/);
  });

  it("remove deletes a user", () => {
    store.upsert({
      username: "u",
      bcrypt_hash: "h1".padEnd(60, "x"),
      role: "viewer",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(store.remove("u")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove("u")).toBe(false);
  });

  it("rejects unknown roles via zod", () => {
    expect(() =>
      store.upsert({
        username: "u",
        bcrypt_hash: "h".padEnd(60, "x"),
        // @ts-expect-error testing runtime validation
        role: "superuser",
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toThrow();
  });

  it("throws on malformed JSON", () => {
    writeFileSync(filePath, "{this is not json", { mode: 0o600 });
    expect(() => new UserStore({ path: filePath }).list()).toThrow(/JSON/);
  });
});
