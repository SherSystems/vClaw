// ============================================================
// Proxmox remediateHost — apt full-upgrade + conditional reboot,
// via the injected ExecRunner.
// ============================================================

import { describe, expect, it } from "vitest";
import { createProxmoxPrimitives } from "../../src/primitives/proxmox.js";
import { PrimitiveNotImplemented } from "../../src/primitives/index.js";
import type { ExecRunner } from "../../src/primitives/proxmox.js";

interface FakeRunnerOpts {
  /** Map command-prefix → return value. Longest matching prefix wins. */
  responses?: Record<
    string,
    { exitCode: number; stdout?: string; stderr?: string } | (() => never)
  >;
  /** Captures every call for assertions. */
  calls?: Array<{ target: string; command: string }>;
}

function fakeRunner(opts: FakeRunnerOpts = {}): ExecRunner {
  return {
    async exec(target, command) {
      opts.calls?.push({ target, command });
      const matches = Object.keys(opts.responses ?? {})
        .filter((prefix) => command.startsWith(prefix))
        .sort((a, b) => b.length - a.length);
      const key = matches[0];
      const response =
        key !== undefined
          ? opts.responses![key]
          : { exitCode: 0, stdout: "", stderr: "" };
      if (typeof response === "function") {
        // Used to simulate "connection dropped" from systemctl reboot.
        response();
      }
      return {
        exitCode: response.exitCode,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    },
  };
}

describe("remediateHost — happy paths", () => {
  it("runs apt update + full-upgrade and reports no-reboot-needed", async () => {
    const calls: FakeRunnerOpts["calls"] = [];
    const runner = fakeRunner({
      responses: {
        "apt-get update": { exitCode: 0, stdout: "" },
        "DEBIAN_FRONTEND=noninteractive apt-get": {
          exitCode: 0,
          stdout: "Inst foo (1.2.3)",
        },
        "test -f /var/run/reboot-required": {
          exitCode: 0,
          stdout: "NO\n",
        },
      },
      calls,
    });
    const prims = createProxmoxPrimitives({ execRunner: runner });
    const result = await prims.remediateHost({
      hostId: "proxmox:proxmox_node:pranavlab",
      provider: "proxmox",
    });
    expect(result.success).toBe(true);
    const data = result.data as { node: string; needsReboot: boolean };
    expect(data.node).toBe("pranavlab");
    expect(data.needsReboot).toBe(false);
    // 3 calls: update, upgrade, reboot-check (no reboot call)
    expect(calls).toHaveLength(3);
    expect(calls[0].command).toBe("apt-get update");
    expect(calls[1].command).toContain("apt-get -y full-upgrade");
    expect(calls[2].command).toContain("reboot-required");
    expect(calls.every((c) => c.target === "pranavlab")).toBe(true);
  });

  it("triggers systemctl reboot when reboot-required is set", async () => {
    const calls: FakeRunnerOpts["calls"] = [];
    const runner = fakeRunner({
      responses: {
        "apt-get update": { exitCode: 0 },
        "DEBIAN_FRONTEND=noninteractive apt-get": { exitCode: 0 },
        "test -f /var/run/reboot-required": {
          exitCode: 0,
          stdout: "NEEDED\n",
        },
        "systemctl reboot": () => {
          throw new Error("Connection closed by remote host");
        },
      },
      calls,
    });
    const prims = createProxmoxPrimitives({ execRunner: runner });
    const result = await prims.remediateHost({
      hostId: "proxmox:proxmox_node:pranavlab",
      provider: "proxmox",
    });
    expect(result.success).toBe(true);
    const data = result.data as { needsReboot: boolean };
    expect(data.needsReboot).toBe(true);
    // 4 calls: update, upgrade, reboot-check, reboot itself (which throws but is caught)
    expect(calls).toHaveLength(4);
    expect(calls[3].command).toBe("systemctl reboot");
  });

  it("passes image as --target-release when provided", async () => {
    const calls: FakeRunnerOpts["calls"] = [];
    const runner = fakeRunner({
      responses: {
        "apt-get update": { exitCode: 0 },
        "DEBIAN_FRONTEND=noninteractive apt-get": { exitCode: 0 },
        "test -f": { exitCode: 0, stdout: "NO" },
      },
      calls,
    });
    const prims = createProxmoxPrimitives({ execRunner: runner });
    await prims.remediateHost({
      hostId: "proxmox:proxmox_node:nodeA",
      provider: "proxmox",
      image: "bookworm-backports",
    });
    const upgradeCmd = calls.find((c) =>
      c.command.includes("apt-get -y --target-release"),
    );
    expect(upgradeCmd).toBeDefined();
    expect(upgradeCmd!.command).toContain("'bookworm-backports'");
    expect(upgradeCmd!.command).toContain("full-upgrade");
  });
});

describe("remediateHost — failure paths", () => {
  it("throws when apt update fails", async () => {
    const runner = fakeRunner({
      responses: {
        "apt-get update": {
          exitCode: 100,
          stderr: "could not resolve mirror.example.com",
        },
      },
    });
    const prims = createProxmoxPrimitives({ execRunner: runner });
    await expect(
      prims.remediateHost({
        hostId: "proxmox:proxmox_node:nodeA",
        provider: "proxmox",
      }),
    ).rejects.toThrow(/apt-get update failed/);
  });

  it("throws when apt full-upgrade fails", async () => {
    const runner = fakeRunner({
      responses: {
        "apt-get update": { exitCode: 0 },
        "DEBIAN_FRONTEND=noninteractive apt-get": {
          exitCode: 100,
          stderr: "dpkg was interrupted",
        },
      },
    });
    const prims = createProxmoxPrimitives({ execRunner: runner });
    await expect(
      prims.remediateHost({
        hostId: "proxmox:proxmox_node:nodeA",
        provider: "proxmox",
      }),
    ).rejects.toThrow(/full-upgrade failed/);
  });

  it("throws PrimitiveNotImplemented when no execRunner is configured", async () => {
    const prims = createProxmoxPrimitives();
    await expect(
      prims.remediateHost({
        hostId: "proxmox:proxmox_node:nodeA",
        provider: "proxmox",
      }),
    ).rejects.toThrow(PrimitiveNotImplemented);
  });

  it("throws on malformed hostId", async () => {
    const runner = fakeRunner({});
    const prims = createProxmoxPrimitives({ execRunner: runner });
    await expect(
      prims.remediateHost({
        hostId: "vsphere:vsphere_host:wrong",
        provider: "proxmox",
      }),
    ).rejects.toThrow(/proxmox:proxmox_node:/);
  });
});
