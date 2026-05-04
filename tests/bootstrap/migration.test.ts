import { describe, expect, it, vi } from "vitest";
import { createMigrationAdapter } from "../../src/bootstrap/migration.js";
import { ConfigSchema, type Config } from "../../src/config.js";
import { AWSClient } from "../../src/providers/aws/client.js";
import { AzureClient } from "../../src/providers/azure/client.js";
import { ProxmoxClient } from "../../src/providers/proxmox/client.js";
import { VSphereClient } from "../../src/providers/vmware/client.js";
import type { SSHExecFn } from "../../src/migration/types.js";

const sshExec: SSHExecFn = async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  const config = ConfigSchema.parse({
    proxmox: {
      host: "pve.local",
      port: "8006",
      tokenId: "root@pam!vclaw",
      tokenSecret: "secret",
      allowSelfSignedCerts: "true",
    },
    vmware: {
      host: "vcsa.local",
      user: "administrator@vsphere.local",
      password: "secret",
      insecure: "true",
    },
    system: {},
    ai: {},
    dashboard: {},
    migration: {
      esxiHost: "esxi.local",
      proxmoxHost: "pve.local",
      proxmoxNode: "pve",
      proxmoxStorage: "local-lvm",
    },
    aws: {},
    azure: {},
    kubernetes: {},
    autopilot: {},
    executor: {},
    service_health: { enabled: false, probes: [] },
    ssh: {},
  });

  return {
    ...config,
    ...overrides,
    proxmox: { ...config.proxmox, ...overrides.proxmox },
    vmware: { ...config.vmware, ...overrides.vmware },
    migration: { ...config.migration, ...overrides.migration },
    aws: { ...config.aws, ...overrides.aws },
    azure: { ...config.azure, ...overrides.azure },
  };
}

describe("createMigrationAdapter", () => {
  it("returns undefined when core migration config is incomplete", async () => {
    const VSphereClientCtor = vi.fn();
    const adapter = await createMigrationAdapter(
      makeConfig({ vmware: { host: "" } as Config["vmware"] }),
      sshExec,
      {
        VSphereClientCtor: VSphereClientCtor as unknown as typeof VSphereClient,
        logger: { warn: vi.fn() },
      },
    );

    expect(adapter).toBeUndefined();
    expect(VSphereClientCtor).not.toHaveBeenCalled();
  });

  it("fails soft when vCenter is unreachable during migration bootstrap", async () => {
    class FailingVSphereClient {
      async createSession(): Promise<string> {
        throw new Error("vCenter down");
      }
      async deleteSession(): Promise<void> {}
    }

    const ProxmoxClientCtor = vi.fn();
    const logger = { warn: vi.fn() };

    const adapter = await createMigrationAdapter(makeConfig(), sshExec, {
      VSphereClientCtor: FailingVSphereClient as unknown as typeof VSphereClient,
      ProxmoxClientCtor: ProxmoxClientCtor as unknown as typeof ProxmoxClient,
      logger,
    });

    expect(adapter).toBeUndefined();
    expect(ProxmoxClientCtor).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Migration adapter disabled: vCenter down"),
    );
  });

  it("keeps base migrations available when optional cloud clients fail", async () => {
    class ConnectedVSphereClient {
      async createSession(): Promise<string> {
        return "session";
      }
      async deleteSession(): Promise<void> {}
    }

    class ConnectedProxmoxClient {
      async connect(): Promise<void> {}
      disconnect(): void {}
    }

    class FailingAWSClient {
      async connect(): Promise<void> {
        throw new Error("AWS auth failed");
      }
      disconnect(): void {}
    }

    class FailingAzureClient {
      async connect(): Promise<void> {
        throw new Error("Azure auth failed");
      }
      disconnect(): void {}
    }

    const logger = { warn: vi.fn() };
    const adapter = await createMigrationAdapter(
      makeConfig({
        aws: {
          accessKeyId: "AKIA...",
          secretAccessKey: "secret",
        } as Config["aws"],
        azure: {
          tenantId: "tenant",
          clientId: "client",
          clientSecret: "secret",
          subscriptionId: "sub",
        } as Config["azure"],
      }),
      sshExec,
      {
        VSphereClientCtor: ConnectedVSphereClient as unknown as typeof VSphereClient,
        ProxmoxClientCtor: ConnectedProxmoxClient as unknown as typeof ProxmoxClient,
        AWSClientCtor: FailingAWSClient as unknown as typeof AWSClient,
        AzureClientCtor: FailingAzureClient as unknown as typeof AzureClient,
        logger,
      },
    );

    expect(adapter?.isConnected()).toBe(true);
    const toolNames = adapter?.getTools().map((tool) => tool.name) ?? [];
    expect(toolNames).toContain("plan_migration_vmware_to_proxmox");
    expect(toolNames).toContain("plan_migration_proxmox_to_vmware");
    expect(toolNames).not.toContain("plan_migration_vmware_to_aws");
    expect(toolNames).not.toContain("plan_migration_vmware_to_azure");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("AWS migration client unavailable: AWS auth failed"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Azure migration client unavailable: Azure auth failed"),
    );
  });
});
