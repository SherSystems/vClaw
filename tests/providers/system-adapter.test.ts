import { describe, it, expect, beforeEach } from "vitest";
import { SystemAdapter } from "../../src/providers/system/adapter.js";

describe("SystemAdapter", () => {
  let adapter: SystemAdapter;

  beforeEach(() => {
    adapter = new SystemAdapter();
  });

  describe("lifecycle", () => {
    it("connects and disconnects", async () => {
      expect(adapter.isConnected()).toBe(false);
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });

    it("has name 'system'", () => {
      expect(adapter.name).toBe("system");
    });
  });

  describe("getTools", () => {
    it("returns tool definitions", () => {
      const tools = adapter.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it("includes ssh_exec, local_exec, ping", () => {
      const tools = adapter.getTools();
      const names = tools.map(t => t.name);
      expect(names).toContain("ssh_exec");
      expect(names).toContain("local_exec");
      expect(names).toContain("ping");
    });

    it("includes install_packages, configure_service, run_script, wait_for_ssh", () => {
      const tools = adapter.getTools();
      const names = tools.map(t => t.name);
      expect(names).toContain("install_packages");
      expect(names).toContain("configure_service");
      expect(names).toContain("run_script");
      expect(names).toContain("wait_for_ssh");
    });

    it("all tools have adapter set to 'system'", () => {
      const tools = adapter.getTools();
      expect(tools.every(t => t.adapter === "system")).toBe(true);
    });

    it("ping is a read tool", () => {
      const tool = adapter.getTools().find(t => t.name === "ping");
      expect(tool!.tier).toBe("read");
    });

    it("ssh_exec is a risky_write tool", () => {
      const tool = adapter.getTools().find(t => t.name === "ssh_exec");
      expect(tool!.tier).toBe("risky_write");
    });
  });

  describe("getClusterState", () => {
    it("returns empty state with system adapter name", async () => {
      await adapter.connect();
      const state = await adapter.getClusterState();
      expect(state.adapter).toBe("system");
      expect(state.nodes).toHaveLength(0);
      expect(state.vms).toHaveLength(0);
      expect(state.containers).toHaveLength(0);
      expect(state.storage).toHaveLength(0);
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("returns error for unknown tool", async () => {
      const result = await adapter.execute("nonexistent", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown system tool");
    });

    it("local_exec requires command param", async () => {
      const result = await adapter.execute("local_exec", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("command is required");
    });

    it("ssh_exec requires host and command", async () => {
      const result = await adapter.execute("ssh_exec", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("host and command are required");
    });

    it("ping requires host", async () => {
      const result = await adapter.execute("ping", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("host is required");
    });

    it("install_packages requires host and packages", async () => {
      const result = await adapter.execute("install_packages", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("host and packages are required");
    });

    it("configure_service requires host and service", async () => {
      const result = await adapter.execute("configure_service", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("host and service are required");
    });

    it("run_script requires host and script", async () => {
      const result = await adapter.execute("run_script", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("host and script are required");
    });

    it("wait_for_ssh requires host", async () => {
      const result = await adapter.execute("wait_for_ssh", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("host is required");
    });

    it("executes local_exec with echo", async () => {
      const result = await adapter.execute("local_exec", {
        command: "echo hello",
        timeout_ms: 5000,
      });
      expect(result.success).toBe(true);
      expect((result.data as { stdout: string }).stdout.trim()).toBe("hello");
    });

    it("strips internal params prefixed with _", async () => {
      const result = await adapter.execute("local_exec", {
        _plan_id: "test-plan",
        command: "echo stripped",
        timeout_ms: 5000,
      });
      expect(result.success).toBe(true);
    });

    it("handles command timeout", async () => {
      const result = await adapter.execute("local_exec", {
        command: "sleep 10",
        timeout_ms: 500,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("handles command failure (non-zero exit)", async () => {
      const result = await adapter.execute("local_exec", {
        command: "exit 1",
        timeout_ms: 5000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Exit code");
    });
  });
});
