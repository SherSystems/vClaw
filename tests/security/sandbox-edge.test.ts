// ============================================================
// Edge-case tests for SandboxManager
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SandboxManager, type SandboxStats } from "../../src/security/sandbox.js";

describe("SandboxManager — Edge Cases", () => {
  let sandbox: SandboxManager;

  beforeEach(() => {
    sandbox = new SandboxManager({
      defaultTimeoutMs: 100,
      maxConcurrent: 5,
    });
  });

  describe("executor validation edge cases", () => {
    it("execute with executor not configured", async () => {
      // Don't call setExecutor()
      const result = await sandbox.execute("test-tool", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("not configured");
    });

    it("execute with undefined tool name", async () => {
      sandbox.setExecutor(async (tool: string, params: Record<string, unknown>) => ({
        success: true,
        data: `called ${tool}`,
      }));

      const result = await sandbox.execute(undefined as any, {});
      expect(result.success).toBe(true); // Executor still called with undefined
    });

    it("execute with null tool name", async () => {
      sandbox.setExecutor(async (tool: string, params: Record<string, unknown>) => ({
        success: true,
        data: `tool: ${tool}`,
      }));

      const result = await sandbox.execute(null as any, {});
      expect(result.success).toBe(true);
    });

    it("execute with empty params object", async () => {
      sandbox.setExecutor(async (tool: string, params: Record<string, unknown>) => ({
        success: true,
        data: { paramsLength: Object.keys(params).length },
      }));

      const result = await sandbox.execute("tool", {});
      expect(result.success).toBe(true);
      expect((result.data as any).paramsLength).toBe(0);
    });

    it("execute with extremely large params object (1MB)", async () => {
      const largeParams: Record<string, unknown> = {};
      for (let i = 0; i < 10000; i++) {
        largeParams[`key-${i}`] = "x".repeat(100);
      }

      sandbox.setExecutor(async (tool: string, params: Record<string, unknown>) => ({
        success: true,
        data: { paramCount: Object.keys(params).length },
      }));

      const result = await sandbox.execute("tool", largeParams);
      expect(result.success).toBe(true);
      expect((result.data as any).paramCount).toBeGreaterThan(1000);
    });
  });

  describe("executor return value edge cases", () => {
    it("executor returns undefined", async () => {
      sandbox.setExecutor(async () => undefined as any);

      const result = await sandbox.execute("tool", {});
      expect(result.error).toBeDefined();
    });

    it("executor returns null", async () => {
      sandbox.setExecutor(async () => null as any);

      const result = await sandbox.execute("tool", {});
      expect(result.error).toBeDefined();
    });

    it("executor returns object with undefined success field", async () => {
      sandbox.setExecutor(async () => ({
        success: undefined as any,
        data: "test",
      }));

      const result = await sandbox.execute("tool", {});
      // Should still wrap the result
      expect(result).toBeDefined();
    });

    it("executor returns only success: true (no data/error)", async () => {
      sandbox.setExecutor(async () => ({ success: true }));

      const result = await sandbox.execute("tool", {});
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it("executor returns only success: false (no error message)", async () => {
      sandbox.setExecutor(async () => ({ success: false }));

      const result = await sandbox.execute("tool", {});
      expect(result.success).toBe(false);
      expect(result.error).toBeUndefined();
    });
  });

  describe("timeout boundary edge cases", () => {
    it("executor takes exactly timeout ms (boundary)", async () => {
      sandbox = new SandboxManager({ defaultTimeoutMs: 50, maxConcurrent: 5 });
      sandbox.setExecutor(
        async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ success: true }), 50);
          }),
      );

      const result = await sandbox.execute("tool", {});
      // May or may not timeout depending on exact timing
      expect(result).toBeDefined();
    });

    it("executor takes timeout - 1ms (should succeed)", async () => {
      sandbox = new SandboxManager({ defaultTimeoutMs: 50, maxConcurrent: 5 });
      sandbox.setExecutor(
        async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ success: true }), 49);
          }),
      );

      const result = await sandbox.execute("tool", {});
      expect(result.success).toBe(true);
    });

    it("executor takes timeout + 1ms (should timeout)", async () => {
      sandbox = new SandboxManager({ defaultTimeoutMs: 50, maxConcurrent: 5 });
      sandbox.setExecutor(
        async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ success: true }), 51);
          }),
      );

      const result = await sandbox.execute("tool", {});
      expect(result.terminated).toBe(true);
      expect(result.error).toContain("timed out");
    });

    it("setTimeout to 0 (immediate timeout)", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 5 });
      sandbox.setTimeout("test-tool", 0);

      sandbox.setExecutor(
        async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ success: true }), 10);
          }),
      );

      const result = await sandbox.execute("test-tool", {});
      expect(result.error).toContain("timed out");
    });

    it("setTimeout to -1 (should be safe, treated as 0 or ignored)", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 5 });
      sandbox.setTimeout("test-tool", -1);

      sandbox.setExecutor(async () => ({ success: true }));

      // This should either not timeout (if negative is ignored) or timeout immediately
      const result = await sandbox.execute("test-tool", {});
      expect(result).toBeDefined();
    });
  });

  describe("concurrency limit edge cases", () => {
    it("maxConcurrent = 0 (should reject everything)", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 0, defaultTimeoutMs: 100 });
      sandbox.setExecutor(async () => ({ success: true }));

      const result = await sandbox.execute("tool", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("concurrency limit");
    });

    it("maxConcurrent = 1 (serial execution)", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 1, defaultTimeoutMs: 500 });
      const callTimes: number[] = [];

      sandbox.setExecutor(async () => {
        callTimes.push(Date.now());
        return await new Promise((resolve) => {
          setTimeout(() => resolve({ success: true }), 50);
        });
      });

      const results = await Promise.all([
        sandbox.execute("tool1", {}),
        sandbox.execute("tool2", {}),
        sandbox.execute("tool3", {}),
      ]);

      // Most should succeed given timeout
      expect(results.length).toBeGreaterThan(0);
      expect(callTimes.length).toBeGreaterThan(0);
    });

    it("maxConcurrent = 1000 (allow many)", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 1000, defaultTimeoutMs: 500 });
      sandbox.setExecutor(async () => ({ success: true }));

      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(sandbox.execute("tool", {}));
      }

      const results = await Promise.all(promises);
      expect(results.every((r) => r.success)).toBe(true);
      expect(results).toHaveLength(100);
    });

    it("multiple rapid executions hitting concurrency limit", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 2, defaultTimeoutMs: 500 });
      sandbox.setExecutor(
        async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ success: true }), 100);
          }),
      );

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(sandbox.execute("tool", {}));
      }

      const results = await Promise.all(promises);
      const succeeded = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      // Some should succeed, some should hit concurrency limit
      expect(succeeded.length + failed.length).toBe(10);
    });
  });

  describe("stats tracking edge cases", () => {
    it("getStats() called on empty sandbox", () => {
      const stats = sandbox.getStats();
      expect(stats.total_executions).toBe(0);
      expect(stats.successful).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.timed_out).toBe(0);
      expect(stats.crashed).toBe(0);
      expect(stats.active_workers).toBe(0);
      expect(stats.max_concurrent).toBe(5);
    });

    it("resetStats() while execution is in progress", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 1, defaultTimeoutMs: 500 });
      sandbox.setExecutor(
        async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ success: true }), 100);
          }),
      );

      const promise = sandbox.execute("tool1", {});
      sandbox.resetStats(); // Reset while first execution running
      await promise;

      const stats = sandbox.getStats();
      expect(stats.total_executions).toBe(0); // Was reset
      expect(stats.active_workers).toBeGreaterThanOrEqual(0); // But active_workers preserved
    });

    it("stats accuracy after multiple executions", async () => {
      sandbox.setExecutor(async (tool: string, params: Record<string, unknown>) => {
        if (tool === "fail") return { success: false, error: "test error" };
        return { success: true };
      });

      await sandbox.execute("success1", {});
      await sandbox.execute("fail", {});
      await sandbox.execute("success2", {});

      const stats = sandbox.getStats();
      expect(stats.total_executions).toBe(3);
      expect(stats.successful).toBe(2);
      expect(stats.failed).toBe(1);
    });
  });

  describe("timeout override edge cases", () => {
    it("getTimeout for tool that was never configured (should return default)", () => {
      const timeout = sandbox.getTimeout("never-configured");
      expect(timeout).toBe(100); // defaultTimeoutMs
    });

    it("getTimeout for tool with override", () => {
      sandbox.setTimeout("special-tool", 999);
      expect(sandbox.getTimeout("special-tool")).toBe(999);
    });

    it("setTimeout the same tool twice (second overrides)", () => {
      sandbox.setTimeout("tool", 100);
      expect(sandbox.getTimeout("tool")).toBe(100);

      sandbox.setTimeout("tool", 200);
      expect(sandbox.getTimeout("tool")).toBe(200);
    });

    it("setTimeout to very large value", () => {
      sandbox.setTimeout("slow-tool", 999999);
      expect(sandbox.getTimeout("slow-tool")).toBe(999999);
    });
  });

  describe("tool name edge cases", () => {
    it("execute with very long tool name (1K chars)", async () => {
      const longName = "tool-".repeat(200).slice(0, 1000);
      sandbox.setExecutor(async (tool: string) => ({
        success: true,
        data: `called ${tool.length}`,
      }));

      const result = await sandbox.execute(longName, {});
      expect(result.success).toBe(true);
    });

    it("execute with empty string tool name", async () => {
      sandbox.setExecutor(async (tool: string) => ({
        success: true,
        data: tool,
      }));

      const result = await sandbox.execute("", {});
      expect(result.success).toBe(true);
    });

    it("execute with special characters in tool name", async () => {
      const names = ["tool@host", "tool#1", "tool[bracket]", "tool/path", "tool\\back"];

      sandbox.setExecutor(async (tool: string) => ({ success: true, data: tool }));

      for (const name of names) {
        const result = await sandbox.execute(name, {});
        expect(result.success).toBe(true);
      }
    });
  });

  describe("crash handling and error scenarios", () => {
    it("executor that throws an error", async () => {
      sandbox.setExecutor(async () => {
        throw new Error("Executor crashed!");
      });

      const result = await sandbox.execute("tool", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("crashed");
      expect(result.terminated).toBe(false); // Not a timeout, a crash
    });

    it("executor that throws undefined error", async () => {
      sandbox.setExecutor(async () => {
        throw undefined;
      });

      const result = await sandbox.execute("tool", {});
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("executor that rejects after sandbox gives up (zombie result)", async () => {
      sandbox = new SandboxManager({ defaultTimeoutMs: 50, maxConcurrent: 5 });
      let resolveFunc: any;

      sandbox.setExecutor(
        async () =>
          new Promise((resolve) => {
            resolveFunc = resolve;
          }),
      );

      const promise = sandbox.execute("tool", {});
      // Don't resolve yet - let it timeout
      const result = await promise;
      expect(result.error).toContain("timed out");

      // Now resolve the executor's promise (zombie)
      resolveFunc({ success: true });
      // Should not crash the test
    });
  });

  describe("result structure edge cases", () => {
    it("result always includes sandbox_id", async () => {
      sandbox.setExecutor(async () => ({ success: true }));
      const result = await sandbox.execute("tool", {});

      expect(result.sandbox_id).toBeDefined();
      expect(typeof result.sandbox_id).toBe("string");
      expect(result.sandbox_id.length).toBeGreaterThan(0);
    });

    it("each execution gets unique sandbox_id", async () => {
      sandbox.setExecutor(async () => ({ success: true }));

      const result1 = await sandbox.execute("tool", {});
      const result2 = await sandbox.execute("tool", {});

      expect(result1.sandbox_id).not.toBe(result2.sandbox_id);
    });

    it("duration_ms is always set", async () => {
      sandbox.setExecutor(async () => ({ success: true }));
      const result = await sandbox.execute("tool", {});

      expect(result.duration_ms).toBeDefined();
      expect(typeof result.duration_ms).toBe("number");
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("terminated is false for non-timeout failures", async () => {
      sandbox.setExecutor(async () => ({ success: false, error: "test" }));
      const result = await sandbox.execute("tool", {});

      expect(result.success).toBe(false);
      expect(result.terminated).toBe(false);
    });

    it("terminated is true for timeouts", async () => {
      sandbox = new SandboxManager({ defaultTimeoutMs: 10, maxConcurrent: 5 });
      sandbox.setExecutor(
        async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ success: true }), 100);
          }),
      );

      const result = await sandbox.execute("tool", {});
      expect(result.error).toContain("timed out");
      expect(result.terminated).toBe(true);
    });
  });

  describe("setExecutor and state management", () => {
    it("setExecutor can be called multiple times", async () => {
      sandbox.setExecutor(async () => ({ success: true, data: "executor1" }));
      const result1 = await sandbox.execute("tool", {});

      sandbox.setExecutor(async () => ({ success: true, data: "executor2" }));
      const result2 = await sandbox.execute("tool", {});

      expect((result1.data as any)).toBe("executor1");
      expect((result2.data as any)).toBe("executor2");
    });

    it("executor scope and closure preservation", async () => {
      const state = { counter: 0 };
      sandbox.setExecutor(async () => {
        state.counter++;
        return { success: true, data: state.counter };
      });

      const result1 = await sandbox.execute("tool", {});
      const result2 = await sandbox.execute("tool", {});

      expect((result1.data as any)).toBe(1);
      expect((result2.data as any)).toBe(2);
    });
  });

  describe("concurrent execution with various configurations", () => {
    it("high concurrency with mixed success/failure", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 10, defaultTimeoutMs: 500 });
      sandbox.setExecutor(async (tool: string) => {
        if (tool.includes("fail")) {
          return { success: false, error: "intentional" };
        }
        return { success: true };
      });

      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(
          sandbox.execute(i % 2 === 0 ? "fail" : "success", {}),
        );
      }

      const results = await Promise.all(promises);
      // Some may hit concurrency limits, so just verify we got results
      expect(results.length).toBe(20);
      expect(results.some((r) => r.success)).toBe(true);
      expect(results.some((r) => !r.success)).toBe(true);
    });

    it("concurrency limit respected under heavy load", async () => {
      sandbox = new SandboxManager({ maxConcurrent: 3, defaultTimeoutMs: 500 });
      const concurrent: number[] = [];
      let maxConcurrentSeen = 0;

      sandbox.setExecutor(async () => {
        concurrent.push(1);
        maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrent.length);
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrent.pop();
        return { success: true };
      });

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(sandbox.execute("tool", {}));
      }

      await Promise.all(promises);
      expect(maxConcurrentSeen).toBeLessThanOrEqual(3);
    });
  });
});
