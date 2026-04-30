import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SshAdapter } from "../../../src/providers/ssh/adapter.js";
import type { SpawnFn, SpawnedProcess } from "../../../src/providers/ssh/client.js";
import type { SshClassification, SshTarget } from "../../../src/providers/ssh/types.js";

const targets: SshTarget[] = [
  { id: "self", host: "127.0.0.1", user: "test" },
  { id: "pve", host: "10.0.0.10", user: "root", description: "Lab Proxmox" },
];

// ── Fake spawn that drives a one-shot stdout/close cycle ────

interface FakeProc extends SpawnedProcess {
  driveStdout: (s: string) => void;
  driveClose: (code: number | null) => void;
  killed: boolean;
}

function makeFakeSpawn(behaviour: (p: FakeProc, args: readonly string[], cmd: string) => void): SpawnFn {
  return (cmd, args) => {
    const stdoutE = new EventEmitter();
    const stderrE = new EventEmitter();
    const procE = new EventEmitter();
    const proc: FakeProc = {
      stdout: stdoutE as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
      stderr: stderrE as unknown as { on(e: "data", cb: (b: Buffer) => void): void },
      on: ((e: string, cb: (...a: unknown[]) => void) => procE.on(e, cb)) as SpawnedProcess["on"],
      kill: () => { proc.killed = true; return true; },
      killed: false,
      driveStdout: (s) => stdoutE.emit("data", Buffer.from(s)),
      driveClose: (code) => procE.emit("close", code),
    };
    setImmediate(() => behaviour(proc, args, cmd));
    return proc;
  };
}

describe("SshAdapter", () => {
  let adapter: SshAdapter;

  beforeEach(() => {
    adapter = new SshAdapter({ targets });
  });

  describe("metadata", () => {
    it("name is 'ssh'", () => {
      expect(adapter.name).toBe("ssh");
    });
    it("kind is 'service' (NOT hypervisor)", () => {
      expect(adapter.kind).toBe("service");
    });
    it("connect/disconnect lifecycle", async () => {
      expect(adapter.isConnected()).toBe(false);
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });
    it("getClusterState returns empty state with adapter='ssh'", async () => {
      const state = await adapter.getClusterState();
      expect(state.adapter).toBe("ssh");
      expect(state.nodes).toHaveLength(0);
      expect(state.vms).toHaveLength(0);
      expect(state.containers).toHaveLength(0);
      expect(state.storage).toHaveLength(0);
    });
  });

  describe("getTools", () => {
    it("registers ssh_exec, ssh_list_targets, ssh_dry_run", () => {
      const names = adapter.getTools().map((t) => t.name);
      expect(names).toContain("ssh_exec");
      expect(names).toContain("ssh_list_targets");
      expect(names).toContain("ssh_dry_run");
    });
    it("all tools are owned by adapter='ssh'", () => {
      expect(adapter.getTools().every((t) => t.adapter === "ssh")).toBe(true);
    });
    it("ssh_list_targets and ssh_dry_run are read tier", () => {
      const tools = adapter.getTools();
      expect(tools.find((t) => t.name === "ssh_list_targets")!.tier).toBe("read");
      expect(tools.find((t) => t.name === "ssh_dry_run")!.tier).toBe("read");
    });
    it("ssh_exec base tier is risky_write (runtime tier comes from classifier)", () => {
      const t = adapter.getTools().find((x) => x.name === "ssh_exec")!;
      expect(t.tier).toBe("risky_write");
    });
  });

  describe("ssh_list_targets", () => {
    it("returns all configured targets", async () => {
      const result = await adapter.execute("ssh_list_targets", {});
      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);
      expect(data.map((t) => t.id)).toEqual(["self", "pve"]);
    });

    it("never returns the identity_file path — only a boolean flag", async () => {
      const a = new SshAdapter({
        targets: [{ id: "x", host: "h", user: "u", identity_file: "/very/secret/key" }],
      });
      const result = await a.execute("ssh_list_targets", {});
      const json = JSON.stringify(result.data);
      expect(json).not.toContain("/very/secret/key");
      expect(json).toContain("has_identity_file");
    });
  });

  describe("ssh_dry_run", () => {
    it("classifies a read command", async () => {
      const r = await adapter.execute("ssh_dry_run", { command: "uptime" });
      expect(r.success).toBe(true);
      expect((r.data as SshClassification).tier).toBe("read");
    });
    it("classifies a destructive command without executing it", async () => {
      const r = await adapter.execute("ssh_dry_run", { command: "rm -rf /" });
      expect((r.data as SshClassification).tier).toBe("destructive");
    });
    it("returns error for missing command", async () => {
      const r = await adapter.execute("ssh_dry_run", {});
      expect(r.success).toBe(false);
    });
  });

  describe("ssh_exec — input validation", () => {
    it("rejects unknown target_id", async () => {
      const r = await adapter.execute("ssh_exec", { target_id: "no-such", command: "uptime" });
      expect(r.success).toBe(false);
      expect(r.error).toContain("Unknown SSH target");
    });
    it("requires target_id", async () => {
      const r = await adapter.execute("ssh_exec", { command: "uptime" });
      expect(r.success).toBe(false);
    });
    it("requires command", async () => {
      const r = await adapter.execute("ssh_exec", { target_id: "self" });
      expect(r.success).toBe(false);
    });
  });

  describe("ssh_exec — kill-switch and tier handling", () => {
    it("refuses destructive commands when allow_destructive=false", async () => {
      const a = new SshAdapter({ targets, allow_destructive: false });
      const r = await a.execute("ssh_exec", { target_id: "self", command: "rm -rf /tmp" });
      expect(r.success).toBe(false);
      expect(r.error).toContain("ssh.allow_destructive is false");
    });

    it("refuses 'never' tier commands (whitespace-only)", async () => {
      // Note: an empty string fails the "command is required" validation
      // earlier; whitespace is non-empty enough to reach the classifier
      // which then tags it as 'never' and refuses.
      const r = await adapter.execute("ssh_exec", { target_id: "self", command: "   \t " });
      expect(r.success).toBe(false);
      expect(r.error).toContain("refused");
    });

    it("dispatches read commands through the SSH client", async () => {
      const spawnFn = makeFakeSpawn((p) => {
        p.driveStdout("up 1 day\n");
        p.driveClose(0);
      });
      const a = new SshAdapter({ targets }, { spawnFn });
      const r = await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      expect(r.success).toBe(true);
      const data = r.data as { exit_code: number; stdout: string; classification: SshClassification };
      expect(data.exit_code).toBe(0);
      expect(data.stdout).toBe("up 1 day\n");
      expect(data.classification.tier).toBe("read");
    });

    it("with allow_destructive=true, destructive commands still run through governance", async () => {
      const evaluator = vi.fn(async () => ({ allowed: false, reason: "denied for test" }));
      const a = new SshAdapter(
        { targets, allow_destructive: true },
        { governanceEvaluator: evaluator },
      );
      const r = await a.execute("ssh_exec", { target_id: "self", command: "rm -rf /tmp/foo" });
      expect(evaluator).toHaveBeenCalledOnce();
      const [classification] = evaluator.mock.calls[0]!;
      expect(classification.tier).toBe("destructive");
      expect(r.success).toBe(false);
      expect(r.error).toContain("Governance denied");
    });

    it("governance evaluator receives the classified tier per command", async () => {
      const calls: SshClassification[] = [];
      const evaluator = vi.fn(async (c: SshClassification) => {
        calls.push(c);
        return { allowed: true, reason: "ok" };
      });
      const spawnFn = makeFakeSpawn((p) => { p.driveClose(0); });
      const a = new SshAdapter(
        { targets, allow_destructive: true },
        { governanceEvaluator: evaluator, spawnFn },
      );
      await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      await a.execute("ssh_exec", { target_id: "self", command: "systemctl restart nginx" });
      await a.execute("ssh_exec", { target_id: "self", command: "rm -rf /tmp" });
      expect(calls.map((c) => c.tier)).toEqual(["read", "risky_write", "destructive"]);
    });

    it("denied governance never reaches the SSH client", async () => {
      const spawnFn = vi.fn(makeFakeSpawn((p) => p.driveClose(0)));
      const a = new SshAdapter(
        { targets },
        {
          governanceEvaluator: async () => ({ allowed: false, reason: "no" }),
          spawnFn,
        },
      );
      const r = await a.execute("ssh_exec", { target_id: "self", command: "uptime" });
      expect(r.success).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
    });
  });

  describe("dispatch", () => {
    it("returns error for unknown tool", async () => {
      const r = await adapter.execute("nonexistent_tool", {});
      expect(r.success).toBe(false);
      expect(r.error).toContain("Unknown SSH tool");
    });
  });
});
