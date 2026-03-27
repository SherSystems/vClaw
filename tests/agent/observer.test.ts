import { describe, it, expect, vi } from "vitest";
import { Observer } from "../../src/agent/observer.js";
import type { PlanStep, StepResult, ClusterState } from "../../src/types.js";
import type { AIConfig } from "../../src/agent/llm.js";

vi.mock("../../src/agent/llm.js", () => ({
  callLLM: vi.fn().mockResolvedValue(
    JSON.stringify({
      matches: true,
      discrepancies: [],
      severity: "none",
    }),
  ),
}));

const mockConfig: AIConfig = {
  provider: "anthropic",
  apiKey: "test",
  model: "test",
};

function makeStep(
  action: string,
  params: Record<string, unknown> = {},
  tier = "safe_write",
): PlanStep {
  return {
    id: "s1",
    action,
    params,
    description: "test",
    depends_on: [],
    status: "success",
    tier: tier as PlanStep["tier"],
  };
}

function makeResult(overrides?: Partial<StepResult>): StepResult {
  return {
    success: true,
    duration_ms: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeClusterState(
  vms: Array<{
    id: string | number;
    status: string;
    name?: string;
    node?: string;
  }> = [],
  containers: Array<{
    id: string | number;
    status: string;
    name?: string;
    node?: string;
  }> = [],
): ClusterState {
  return {
    adapter: "test",
    nodes: [],
    storage: [],
    timestamp: new Date().toISOString(),
    vms: vms.map((v) => ({
      id: v.id,
      name: v.name ?? "vm",
      node: v.node ?? "pve1",
      status: v.status as "running" | "stopped" | "paused" | "unknown",
      cpu_cores: 1,
      ram_mb: 1024,
      disk_gb: 10,
    })),
    containers: containers.map((c) => ({
      id: c.id,
      name: c.name ?? "ct",
      node: c.node ?? "pve1",
      status: c.status as "running" | "stopped" | "unknown",
      cpu_cores: 1,
      ram_mb: 512,
      disk_gb: 5,
    })),
  };
}

describe("Observer", () => {
  const observer = new Observer();

  describe("failed result", () => {
    it("returns matches:false, severity:major with error message", async () => {
      const step = makeStep("start_vm", { vmid: 100 });
      const result = makeResult({ success: false, error: "Connection refused" });
      const obs = await observer.observe(step, result, null, mockConfig);

      expect(obs.matches).toBe(false);
      expect(obs.severity).toBe("major");
      expect(obs.discrepancies).toContain("Connection refused");
    });

    it("returns default error when no error message provided", async () => {
      const step = makeStep("start_vm", { vmid: 100 });
      const result = makeResult({ success: false });
      const obs = await observer.observe(step, result, null, mockConfig);

      expect(obs.matches).toBe(false);
      expect(obs.severity).toBe("major");
      expect(obs.discrepancies).toContain("Step failed");
    });
  });

  describe("read-only actions", () => {
    it("list_vms returns matches:true, severity:none", async () => {
      const step = makeStep("list_vms", {}, "read");
      const result = makeResult();
      const obs = await observer.observe(step, result, null, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.discrepancies).toEqual([]);
      expect(obs.severity).toBe("none");
    });

    it("get_vm_status returns matches:true", async () => {
      const step = makeStep("get_vm_status", { vmid: 100 });
      const result = makeResult();
      const obs = await observer.observe(step, result, null, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.severity).toBe("none");
    });
  });

  describe("read tier", () => {
    it("any action with tier read returns matches:true", async () => {
      const step = makeStep("some_custom_action", {}, "read");
      const result = makeResult();
      const obs = await observer.observe(step, result, null, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.discrepancies).toEqual([]);
      expect(obs.severity).toBe("none");
    });
  });

  describe("successful with data", () => {
    it("trusts tool result when data is present", async () => {
      const step = makeStep("create_vm", { vmid: 100 });
      const result = makeResult({ data: { vmid: 100 } });
      const obs = await observer.observe(step, result, null, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.discrepancies).toEqual([]);
      expect(obs.severity).toBe("none");
    });
  });

  describe("no state snapshots", () => {
    it("trusts tool result when no state_before and no state_after", async () => {
      const step = makeStep("resize_vm", { vmid: 100, ram_mb: 2048 });
      const result = makeResult();
      const obs = await observer.observe(step, result, null, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.discrepancies).toEqual([]);
      expect(obs.severity).toBe("none");
    });
  });

  describe("start_vm", () => {
    it("success: VM is running in cluster state", async () => {
      const step = makeStep("start_vm", { vmid: 100 });
      const result = makeResult({
        state_before: { status: "stopped" },
        state_after: { status: "running" },
      });
      const state = makeClusterState([{ id: 100, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.severity).toBe("none");
    });

    it("failure: VM is still stopped in cluster state", async () => {
      const step = makeStep("start_vm", { vmid: 100 });
      const result = makeResult({
        state_before: { status: "stopped" },
        state_after: { status: "stopped" },
      });
      const state = makeClusterState([{ id: 100, status: "stopped" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(false);
      expect(obs.severity).toBe("major");
      expect(obs.discrepancies[0]).toContain("expected to be running");
    });

    it("missing: VM not found in cluster state", async () => {
      const step = makeStep("start_vm", { vmid: 999 });
      const result = makeResult({
        state_before: { status: "stopped" },
        state_after: { status: "running" },
      });
      const state = makeClusterState([{ id: 100, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(false);
      expect(obs.severity).toBe("major");
      expect(obs.discrepancies[0]).toContain("not found");
    });
  });

  describe("stop_vm", () => {
    it("success: VM is stopped in cluster state", async () => {
      const step = makeStep("stop_vm", { vmid: 100 });
      const result = makeResult({
        state_before: { status: "running" },
        state_after: { status: "stopped" },
      });
      const state = makeClusterState([{ id: 100, status: "stopped" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.severity).toBe("none");
    });

    it("failure: VM is still running", async () => {
      const step = makeStep("stop_vm", { vmid: 100 });
      const result = makeResult({
        state_before: { status: "running" },
        state_after: { status: "running" },
      });
      const state = makeClusterState([{ id: 100, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(false);
      expect(obs.severity).toBe("major");
      expect(obs.discrepancies[0]).toContain("expected to be stopped");
    });
  });

  describe("restart_vm", () => {
    it("success: VM is running after restart", async () => {
      const step = makeStep("restart_vm", { vmid: 100 });
      const result = makeResult({
        state_before: { status: "running" },
        state_after: { status: "running" },
      });
      const state = makeClusterState([{ id: 100, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.severity).toBe("none");
    });
  });

  describe("start_container", () => {
    it("success: container is running", async () => {
      const step = makeStep("start_container", { vmid: 200 });
      const result = makeResult({
        state_before: { status: "stopped" },
        state_after: { status: "running" },
      });
      const state = makeClusterState([], [{ id: 200, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.severity).toBe("none");
    });

    it("missing: container not found in cluster state", async () => {
      const step = makeStep("start_container", { vmid: 999 });
      const result = makeResult({
        state_before: { status: "stopped" },
        state_after: { status: "running" },
      });
      const state = makeClusterState([], [{ id: 200, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(false);
      expect(obs.severity).toBe("major");
      expect(obs.discrepancies[0]).toContain("not found");
    });
  });

  describe("stop_container", () => {
    it("success: container is stopped", async () => {
      const step = makeStep("stop_container", { vmid: 200 });
      const result = makeResult({
        state_before: { status: "running" },
        state_after: { status: "stopped" },
      });
      const state = makeClusterState([], [{ id: 200, status: "stopped" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.severity).toBe("none");
    });

    it("failure: container still running", async () => {
      const step = makeStep("stop_container", { vmid: 200 });
      const result = makeResult({
        state_before: { status: "running" },
        state_after: { status: "running" },
      });
      const state = makeClusterState([], [{ id: 200, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(false);
      expect(obs.severity).toBe("major");
      expect(obs.discrepancies[0]).toContain("expected to be stopped");
    });
  });

  describe("no vmid param", () => {
    it("simpleObserve returns null, falls through to LLM", async () => {
      const { callLLM } = await import("../../src/agent/llm.js");
      const step = makeStep("start_vm", {}); // no vmid
      const result = makeResult({
        state_before: { status: "stopped" },
        state_after: { status: "running" },
      });
      const state = makeClusterState([{ id: 100, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      // Falls to LLM which returns matches:true from mock
      expect(obs.matches).toBe(true);
      expect(callLLM).toHaveBeenCalled();
    });
  });

  describe("LLM observation fallback", () => {
    it("calls LLM for unknown write action with state snapshots", async () => {
      const { callLLM } = await import("../../src/agent/llm.js");
      vi.mocked(callLLM).mockClear();

      const step = makeStep("resize_disk", { vmid: 100, size_gb: 50 });
      const result = makeResult({
        state_before: { disk_gb: 20 },
        state_after: { disk_gb: 50 },
      });
      const state = makeClusterState([{ id: 100, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(callLLM).toHaveBeenCalled();
      expect(obs.matches).toBe(true);
      expect(obs.severity).toBe("none");
    });
  });

  describe("LLM observation failure", () => {
    it("returns matches:true when callLLM throws", async () => {
      const { callLLM } = await import("../../src/agent/llm.js");
      vi.mocked(callLLM).mockRejectedValueOnce(new Error("LLM unavailable"));

      // Suppress console.warn for this test
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const step = makeStep("resize_disk", { vmid: 100, size_gb: 50 });
      const result = makeResult({
        state_before: { disk_gb: 20 },
        state_after: { disk_gb: 50 },
      });
      const state = makeClusterState([{ id: 100, status: "running" }]);
      const obs = await observer.observe(step, result, state, mockConfig);

      expect(obs.matches).toBe(true);
      expect(obs.discrepancies).toEqual([]);
      expect(obs.severity).toBe("none");

      warnSpy.mockRestore();
    });
  });
});
