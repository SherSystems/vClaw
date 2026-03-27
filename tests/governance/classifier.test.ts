import { describe, it, expect } from "vitest";
import { classifyAction } from "../../src/governance/classifier.js";
import type { ToolDefinition } from "../../src/types.js";

// ── Mock Tool Definitions ───────────────────────────────────

const mockTools: ToolDefinition[] = [
  {
    name: "list_vms",
    description: "List all virtual machines",
    tier: "read",
    adapter: "proxmox",
    params: [],
    returns: "VMInfo[]",
  },
  {
    name: "create_vm",
    description: "Create a new VM",
    tier: "safe_write",
    adapter: "proxmox",
    params: [
      { name: "name", type: "string", required: true, description: "VM name" },
      { name: "ram_mb", type: "number", required: true, description: "RAM in MB" },
      { name: "disk_gb", type: "number", required: true, description: "Disk in GB" },
    ],
    returns: "VMInfo",
  },
  {
    name: "stop_vm",
    description: "Stop a VM",
    tier: "risky_write",
    adapter: "proxmox",
    params: [
      { name: "vmid", type: "number", required: true, description: "VM ID" },
    ],
    returns: "StepResult",
  },
  {
    name: "delete_vm",
    description: "Delete a VM permanently",
    tier: "destructive",
    adapter: "proxmox",
    params: [
      { name: "vmid", type: "number", required: true, description: "VM ID" },
    ],
    returns: "StepResult",
  },
];

// ── Tests ───────────────────────────────────────────────────

describe("classifyAction", () => {
  describe("forbidden patterns", () => {
    const forbidden = [
      "delete_all",
      "format_storage",
      "modify_host_config",
      "disable_firewall",
      "destroy_cluster",
      "wipe_disk",
      "rm_rf_root",
    ];

    for (const action of forbidden) {
      it(`returns "never" for forbidden action: ${action}`, () => {
        expect(classifyAction(action, {}, mockTools)).toBe("never");
      });
    }

    it('returns "never" for forbidden patterns case-insensitively', () => {
      expect(classifyAction("DELETE_ALL", {}, mockTools)).toBe("never");
      expect(classifyAction("Format_Storage", {}, mockTools)).toBe("never");
    });
  });

  describe("base tier from tool definition", () => {
    it("returns the defined tier for a known tool", () => {
      expect(classifyAction("list_vms", {}, mockTools)).toBe("read");
      expect(classifyAction("create_vm", {}, mockTools)).toBe("safe_write");
      expect(classifyAction("stop_vm", {}, mockTools)).toBe("risky_write");
      expect(classifyAction("delete_vm", {}, mockTools)).toBe("destructive");
    });

    it('defaults to "risky_write" for an unknown tool', () => {
      expect(classifyAction("unknown_tool", {}, mockTools)).toBe("risky_write");
    });
  });

  describe("param-based elevation", () => {
    it("elevates to at least risky_write when count > 1", () => {
      const result = classifyAction("create_vm", { count: 5 }, mockTools);
      expect(result).toBe("risky_write");
    });

    it("elevates to at least risky_write when num_vms > 1", () => {
      const result = classifyAction("create_vm", { num_vms: 3 }, mockTools);
      expect(result).toBe("risky_write");
    });

    it("elevates to risky_write when RAM > 16384 MB", () => {
      const result = classifyAction("create_vm", { ram_mb: 32768 }, mockTools);
      expect(result).toBe("risky_write");
    });

    it("elevates to risky_write when disk > 500 GB", () => {
      const result = classifyAction("create_vm", { disk_gb: 1000 }, mockTools);
      expect(result).toBe("risky_write");
    });

    it("elevates to destructive when force=true", () => {
      const result = classifyAction("stop_vm", { force: true }, mockTools);
      expect(result).toBe("destructive");
    });

    it("elevates to destructive when skip_checks=true", () => {
      const result = classifyAction("stop_vm", { skip_checks: true }, mockTools);
      expect(result).toBe("destructive");
    });

    it("elevates to risky_write when delete=true", () => {
      const result = classifyAction("create_vm", { delete: true }, mockTools);
      expect(result).toBe("risky_write");
    });

    it("elevates to risky_write when action=delete", () => {
      const result = classifyAction("create_vm", { action: "delete" }, mockTools);
      expect(result).toBe("risky_write");
    });

    it("elevates to risky_write when targets > 3", () => {
      const result = classifyAction("stop_vm", { vmids: [1, 2, 3, 4] }, mockTools);
      expect(result).toBe("risky_write");
    });

    it('read-tier tool stays "read" when no elevation rules match', () => {
      const result = classifyAction("list_vms", {}, mockTools);
      expect(result).toBe("read");
    });

    it('safe_write tool elevated to "destructive" with force=true', () => {
      const result = classifyAction("create_vm", { force: true }, mockTools);
      expect(result).toBe("destructive");
    });

    it("multiple elevation rules stack correctly (highest wins)", () => {
      // count > 1 => risky_write, force => destructive
      // highest should win => destructive
      const result = classifyAction(
        "create_vm",
        { count: 5, force: true, ram_mb: 32768 },
        mockTools,
      );
      expect(result).toBe("destructive");
    });

    it("does not elevate when params are below thresholds", () => {
      const result = classifyAction(
        "create_vm",
        { count: 1, ram_mb: 4096, disk_gb: 50 },
        mockTools,
      );
      expect(result).toBe("safe_write");
    });
  });
});
