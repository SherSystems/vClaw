import { describe, it, expect, beforeEach, vi } from "vitest";
import { SandboxManager } from "../../src/security/sandbox.js";

describe("SandboxManager", () => {
  let sandbox: SandboxManager;

  beforeEach(() => {
    sandbox = new SandboxManager({
      defaultTimeoutMs: 5000,
      maxConcurrent: 2,
    });
  });

  describe("execute", () => {
    it("executes a tool successfully", async () => {
      sandbox.setExecutor(async (tool, params) => ({
        success: true,
        data: { vms: ["vm1", "vm2"] },
      }));

      const result = await sandbox.execute("list_vms", { node: "pve1" });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ vms: ["vm1", "vm2"] });
      expect(result.sandbox_id).toBeDefined();
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.terminated).toBe(false);
    });

    it("handles tool failure", async () => {
      sandbox.setExecutor(async () => ({
        success: false,
        error: "Connection refused",
      }));

      const result = await sandbox.execute("list_vms", {});

      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection refused");
      expect(result.terminated).toBe(false);
    });

    it("contains tool crashes without propagating", async () => {
      sandbox.setExecutor(async () => {
        throw new Error("Segfault in adapter");
      });

      const result = await sandbox.execute("dangerous_tool", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Tool crashed");
      expect(result.error).toContain("Segfault in adapter");
      expect(result.terminated).toBe(false);
    });

    it("enforces timeout", async () => {
      const shortSandbox = new SandboxManager({ defaultTimeoutMs: 100 });
      shortSandbox.setExecutor(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { success: true };
      });

      const result = await shortSandbox.execute("slow_tool", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
      expect(result.terminated).toBe(true);
    });

    it("uses per-tool timeout overrides", async () => {
      sandbox.setTimeout("fast_tool", 50);
      sandbox.setExecutor(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { success: true };
      });

      const result = await sandbox.execute("fast_tool", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
      expect(result.error).toContain("fast_tool");
    });

    it("enforces concurrency limit", async () => {
      let resolveFirst!: () => void;
      let resolveSecond!: () => void;
      let callCount = 0;

      sandbox.setExecutor(async () => {
        callCount++;
        if (callCount <= 2) {
          await new Promise<void>((r) => {
            if (callCount === 1) resolveFirst = r;
            else resolveSecond = r;
          });
        }
        return { success: true };
      });

      // Start 2 concurrent (at the limit)
      const p1 = sandbox.execute("tool1", {});
      const p2 = sandbox.execute("tool2", {});

      // Wait a tick for them to start
      await new Promise((r) => setTimeout(r, 10));

      // Third should be rejected
      const p3 = sandbox.execute("tool3", {});
      const result3 = await p3;

      expect(result3.success).toBe(false);
      expect(result3.error).toContain("concurrency limit");

      // Clean up
      resolveFirst();
      resolveSecond();
      await Promise.all([p1, p2]);
    });

    it("returns error if executor not configured", async () => {
      const emptySandbox = new SandboxManager();
      const result = await emptySandbox.execute("tool", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("executor not configured");
    });
  });

  describe("stats", () => {
    it("tracks execution statistics", async () => {
      sandbox.setExecutor(async () => ({ success: true }));

      await sandbox.execute("tool1", {});
      await sandbox.execute("tool2", {});

      const stats = sandbox.getStats();
      expect(stats.total_executions).toBe(2);
      expect(stats.successful).toBe(2);
      expect(stats.failed).toBe(0);
      expect(stats.active_workers).toBe(0);
    });

    it("tracks failures separately", async () => {
      sandbox.setExecutor(async () => ({ success: false, error: "fail" }));

      await sandbox.execute("tool", {});

      const stats = sandbox.getStats();
      expect(stats.total_executions).toBe(1);
      expect(stats.successful).toBe(0);
      expect(stats.failed).toBe(1);
    });

    it("tracks timeouts", async () => {
      const shortSandbox = new SandboxManager({ defaultTimeoutMs: 50 });
      shortSandbox.setExecutor(async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return { success: true };
      });

      await shortSandbox.execute("slow", {});

      const stats = shortSandbox.getStats();
      expect(stats.timed_out).toBe(1);
    });

    it("tracks crashes", async () => {
      sandbox.setExecutor(async () => { throw new Error("boom"); });

      await sandbox.execute("crashy", {});

      const stats = sandbox.getStats();
      expect(stats.crashed).toBe(1);
    });

    it("resets stats", async () => {
      sandbox.setExecutor(async () => ({ success: true }));
      await sandbox.execute("tool", {});

      sandbox.resetStats();
      const stats = sandbox.getStats();
      expect(stats.total_executions).toBe(0);
      expect(stats.successful).toBe(0);
    });
  });

  describe("getTimeout", () => {
    it("returns default timeout for unknown tools", () => {
      expect(sandbox.getTimeout("unknown")).toBe(5000);
    });

    it("returns override timeout for configured tools", () => {
      sandbox.setTimeout("special", 60000);
      expect(sandbox.getTimeout("special")).toBe(60000);
    });
  });
});
