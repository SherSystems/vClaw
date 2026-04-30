import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We import config.ts fresh per test by clearing the vitest module
// registry first — getConfig() caches the parsed config in a module
// variable so we'd otherwise see whatever the first test set.

async function loadFreshConfig() {
  vi.resetModules();
  const mod = await import("../../../src/config.js");
  return mod;
}

describe("SshConfigSchema in getConfig()", () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vclaw-ssh-cfg-"));
    savedEnv = {
      VCLAW_SSH_TARGETS_FILE: process.env.VCLAW_SSH_TARGETS_FILE,
      VCLAW_SSH_TARGETS: process.env.VCLAW_SSH_TARGETS,
      VCLAW_SSH_ALLOW_DESTRUCTIVE: process.env.VCLAW_SSH_ALLOW_DESTRUCTIVE,
      VCLAW_SSH_DEFAULT_TIMEOUT_S: process.env.VCLAW_SSH_DEFAULT_TIMEOUT_S,
      VCLAW_SSH_MAX_OUTPUT_BYTES: process.env.VCLAW_SSH_MAX_OUTPUT_BYTES,
      VCLAW_SSH_STRICT_HOST_KEY_CHECKING: process.env.VCLAW_SSH_STRICT_HOST_KEY_CHECKING,
    };
    delete process.env.VCLAW_SSH_TARGETS_FILE;
    delete process.env.VCLAW_SSH_TARGETS;
    delete process.env.VCLAW_SSH_ALLOW_DESTRUCTIVE;
    delete process.env.VCLAW_SSH_DEFAULT_TIMEOUT_S;
    delete process.env.VCLAW_SSH_MAX_OUTPUT_BYTES;
    delete process.env.VCLAW_SSH_STRICT_HOST_KEY_CHECKING;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { unlinkSync(join(tmpDir, "targets.json")); } catch { /* noop */ }
  });

  it("defaults to empty targets, sane numbers, kill-switch off", async () => {
    const { getConfig } = await loadFreshConfig();
    const cfg = getConfig();
    expect(cfg.ssh.targets).toEqual([]);
    expect(cfg.ssh.max_output_bytes).toBe(65536);
    expect(cfg.ssh.default_timeout_s).toBe(30);
    expect(cfg.ssh.allow_destructive).toBe(false);
    expect(cfg.ssh.strict_host_key_checking).toBe(true);
  });

  it("loads targets from VCLAW_SSH_TARGETS_FILE", async () => {
    const file = join(tmpDir, "targets.json");
    writeFileSync(file, JSON.stringify([
      { id: "lab", host: "10.0.0.1", user: "root", port: 22 },
      { id: "esxi", host: "esxi.lab", user: "root", identity_file: "/keys/lab" },
    ]));
    process.env.VCLAW_SSH_TARGETS_FILE = file;

    const { getConfig } = await loadFreshConfig();
    const cfg = getConfig();
    expect(cfg.ssh.targets).toHaveLength(2);
    expect(cfg.ssh.targets[0]!.id).toBe("lab");
    expect(cfg.ssh.targets[1]!.identity_file).toBe("/keys/lab");
  });

  it("loads targets from inline VCLAW_SSH_TARGETS json", async () => {
    process.env.VCLAW_SSH_TARGETS = JSON.stringify([
      { id: "self", host: "127.0.0.1", user: "test" },
    ]);
    const { getConfig } = await loadFreshConfig();
    const cfg = getConfig();
    expect(cfg.ssh.targets).toHaveLength(1);
    expect(cfg.ssh.targets[0]!.id).toBe("self");
  });

  it("returns empty list (and does NOT throw) when targets file is missing", async () => {
    process.env.VCLAW_SSH_TARGETS_FILE = join(tmpDir, "does-not-exist.json");
    const { getConfig } = await loadFreshConfig();
    const cfg = getConfig();
    expect(cfg.ssh.targets).toEqual([]);
  });

  it("returns empty list when inline JSON is malformed", async () => {
    process.env.VCLAW_SSH_TARGETS = "{not json";
    const { getConfig } = await loadFreshConfig();
    const cfg = getConfig();
    expect(cfg.ssh.targets).toEqual([]);
  });

  it("respects VCLAW_SSH_ALLOW_DESTRUCTIVE=true", async () => {
    process.env.VCLAW_SSH_ALLOW_DESTRUCTIVE = "true";
    const { getConfig } = await loadFreshConfig();
    expect(getConfig().ssh.allow_destructive).toBe(true);
  });
});
