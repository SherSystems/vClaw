// ============================================================
// Security Module Integration Tests
// Tests end-to-end interaction between security components
// and the rest of the vClaw system.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrivacyRouter } from "../../src/security/privacy.js";
import { SandboxManager } from "../../src/security/sandbox.js";
import { CredentialVault } from "../../src/security/vault.js";
import { AuditLog } from "../../src/governance/audit.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// ── Test 1: Privacy Router redacts LLM prompts ─────────────

describe("Privacy Router + LLM integration", () => {
  it("redacts sensitive data from system and user prompts before LLM call", () => {
    const router = new PrivacyRouter();

    const system = "You manage Proxmox at 192.168.1.100 with password=SuperSecret123";
    const user = "Connect using API key sk-proj-abc123def456ghi789jkl and list VMs on 10.0.0.50";

    const sanitized = router.sanitizeForLLM(system, user);

    // System prompt should have IP and password redacted
    expect(sanitized.system).not.toContain("192.168.1.100");
    expect(sanitized.system).not.toContain("SuperSecret123");
    expect(sanitized.system).toContain("[REDACTED:ip]");
    expect(sanitized.system).toContain("[REDACTED:credential]");

    // User prompt should have API key and IP redacted
    expect(sanitized.user).not.toContain("sk-proj-abc123def456ghi789jkl");
    expect(sanitized.user).not.toContain("10.0.0.50");
    expect(sanitized.user).toContain("[REDACTED:api_key]");
    expect(sanitized.user).toContain("[REDACTED:ip]");

    // Redaction counts should be tracked
    expect(sanitized.redactions.system.redaction_count).toBeGreaterThan(0);
    expect(sanitized.redactions.user.redaction_count).toBeGreaterThan(0);
  });

  it("passes clean prompts through unchanged", () => {
    const router = new PrivacyRouter();

    const system = "You are a helpful infrastructure assistant.";
    const user = "How many VMs are running on node pve1?";

    const sanitized = router.sanitizeForLLM(system, user);

    expect(sanitized.system).toBe(system);
    expect(sanitized.user).toBe(user);
    expect(sanitized.redactions.system.redaction_count).toBe(0);
    expect(sanitized.redactions.user.redaction_count).toBe(0);
  });
});

// ── Test 2: Sandbox wraps executor and contains crashes ─────

describe("Sandbox + Executor integration", () => {
  let sandbox: SandboxManager;

  beforeEach(() => {
    sandbox = new SandboxManager({ defaultTimeoutMs: 5000 });
  });

  it("wraps tool execution and returns results", async () => {
    const mockToolRegistry = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        data: { vms: ["vm-100", "vm-101"] },
      }),
    };

    sandbox.setExecutor((tool, params) => mockToolRegistry.execute(tool, params));

    const result = await sandbox.execute("list_vms", { node: "pve1" });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ vms: ["vm-100", "vm-101"] });
    expect(mockToolRegistry.execute).toHaveBeenCalledWith("list_vms", { node: "pve1" });
  });

  it("contains crashes from executor without propagating", async () => {
    const mockToolRegistry = {
      execute: vi.fn().mockRejectedValue(new Error("Connection to Proxmox lost")),
    };

    sandbox.setExecutor((tool, params) => mockToolRegistry.execute(tool, params));

    const result = await sandbox.execute("list_vms", { node: "pve1" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Tool crashed");
    expect(result.error).toContain("Connection to Proxmox lost");

    // Crash should be tracked in stats
    const stats = sandbox.getStats();
    expect(stats.crashed).toBe(1);
    expect(stats.total_executions).toBe(1);
  });

  it("enforces timeouts on slow executor calls", async () => {
    const shortSandbox = new SandboxManager({ defaultTimeoutMs: 50 });

    shortSandbox.setExecutor(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { success: true };
    });

    const result = await shortSandbox.execute("slow_tool", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.terminated).toBe(true);

    const stats = shortSandbox.getStats();
    expect(stats.timed_out).toBe(1);
  });
});

// ── Test 3: Vault import/export from config ─────────────────

describe("Vault + Config integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vclaw-vault-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports config secrets into vault and exports them back", () => {
    const vault = new CredentialVault({
      path: join(tmpDir, "vault.json"),
      masterKey: "test-master-key-integration",
    });

    // Simulate config secrets
    const secrets = {
      "proxmox.tokenSecret": {
        value: "aabbccdd-1122-3344-5566-778899aabbcc",
        provider: "proxmox",
        field: "tokenSecret",
      },
      "vmware.password": {
        value: "VMware123!",
        provider: "vmware",
        field: "password",
      },
      "ai.apiKey": {
        value: "sk-ant-api03-realkey123456789012345678901234567890",
        provider: "ai",
        field: "apiKey",
      },
    };

    vault.importFromConfig(secrets);

    // Verify all secrets were stored
    expect(vault.has("proxmox.tokenSecret")).toBe(true);
    expect(vault.has("vmware.password")).toBe(true);
    expect(vault.has("ai.apiKey")).toBe(true);

    // Verify secrets decrypt correctly
    expect(vault.retrieve("proxmox.tokenSecret")).toBe("aabbccdd-1122-3344-5566-778899aabbcc");
    expect(vault.retrieve("vmware.password")).toBe("VMware123!");
    // Verify export returns all plaintext
    const exported = vault.exportPlaintext();
    expect(exported["proxmox.tokenSecret"]).toBe("aabbccdd-1122-3344-5566-778899aabbcc");
    expect(exported["ai.apiKey"]).toBe("sk-ant-api03-realkey123456789012345678901234567890");

    // Verify listing shows metadata
    const list = vault.list();
    expect(list).toHaveLength(3);
    expect(list.find((e) => e.id === "vmware.password")?.provider).toBe("vmware");
  });

  it("persists vault to disk and reloads", () => {
    const vaultPath = join(tmpDir, "persistent-vault.json");

    // Create vault and store a secret
    const vault1 = new CredentialVault({
      path: vaultPath,
      masterKey: "persist-test-key",
    });
    vault1.store_secret("test.secret", "my-secret-value", "test", "secret");

    // Create a new vault instance from the same file
    const vault2 = new CredentialVault({
      path: vaultPath,
      masterKey: "persist-test-key",
    });

    // Should be able to retrieve the secret
    expect(vault2.retrieve("test.secret")).toBe("my-secret-value");
  });

  it("skips empty config values during import", () => {
    const vault = new CredentialVault({
      path: join(tmpDir, "vault.json"),
      masterKey: "test-key",
    });

    vault.importFromConfig({
      "has.value": { value: "real-secret", provider: "test", field: "value" },
      "empty.value": { value: "", provider: "test", field: "empty" },
    });

    expect(vault.has("has.value")).toBe(true);
    expect(vault.has("empty.value")).toBe(false);
  });
});

// ── Test 4: Audit entries have redacted params ──────────────

describe("Audit + Privacy Router integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vclaw-audit-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("redacts sensitive params before logging to SQLite", () => {
    const auditLog = new AuditLog(join(tmpDir, "audit.db"));

    const entry = {
      id: "test-001",
      timestamp: new Date().toISOString(),
      action: "connect_proxmox",
      tier: "read" as const,
      reasoning: "Connecting to Proxmox node",
      params: {
        host: "192.168.1.100",
        tokenId: "root@pam!token",
        password: "SuperSecret123",
      },
      result: "success" as const,
      duration_ms: 150,
    };

    auditLog.log(entry);

    const results = auditLog.query({ action: "connect_proxmox" });
    expect(results).toHaveLength(1);

    const logged = results[0];

    // Password field should be redacted (sensitive field name)
    expect(logged.params.password).toBe("[REDACTED]");

    // Private IP should be redacted in host field
    expect(logged.params.host).not.toContain("192.168.1.100");
    expect(logged.params.host).toContain("[REDACTED:ip]");

    // Non-sensitive fields should be preserved
    expect(logged.params.tokenId).toBe("root@pam!token");

    auditLog.close();
  });

  it("redacts sensitive data in state_before and state_after", () => {
    const auditLog = new AuditLog(join(tmpDir, "audit.db"));

    const entry = {
      id: "test-002",
      timestamp: new Date().toISOString(),
      action: "modify_vm",
      tier: "write" as const,
      reasoning: "Resizing VM disk",
      params: { vmid: 100 },
      result: "success" as const,
      duration_ms: 500,
      state_before: {
        vm_config: "password=OldPass123",
        network: "192.168.1.50",
      },
      state_after: {
        vm_config: "password=NewPass456",
        network: "192.168.1.50",
      },
    };

    auditLog.log(entry);

    const results = auditLog.query({ action: "modify_vm" });
    expect(results).toHaveLength(1);

    const logged = results[0];

    // State before should have secrets redacted
    expect(logged.state_before?.vm_config).not.toContain("OldPass123");
    expect(logged.state_before?.network).not.toContain("192.168.1.50");

    // State after should also have secrets redacted
    expect(logged.state_after?.vm_config).not.toContain("NewPass456");
    expect(logged.state_after?.network).not.toContain("192.168.1.50");

    auditLog.close();
  });

  it("handles entries with no state gracefully", () => {
    const auditLog = new AuditLog(join(tmpDir, "audit.db"));

    const entry = {
      id: "test-003",
      timestamp: new Date().toISOString(),
      action: "list_vms",
      tier: "read" as const,
      reasoning: "Listing VMs",
      params: { node: "pve1" },
      result: "success" as const,
      duration_ms: 50,
    };

    auditLog.log(entry);

    const results = auditLog.query({ action: "list_vms" });
    expect(results).toHaveLength(1);
    expect(results[0].params.node).toBe("pve1");
    expect(results[0].state_before).toBeUndefined();
    expect(results[0].state_after).toBeUndefined();

    auditLog.close();
  });
});
