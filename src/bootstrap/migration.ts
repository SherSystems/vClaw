import type { Config } from "../config.js";
import { AWSClient } from "../providers/aws/client.js";
import { AzureClient } from "../providers/azure/client.js";
import { ProxmoxClient } from "../providers/proxmox/client.js";
import { VSphereClient } from "../providers/vmware/client.js";
import { MigrationAdapter } from "../migration/adapter.js";
import type { SSHExecFn } from "../migration/types.js";

interface Logger {
  warn: (...args: unknown[]) => void;
}

export interface MigrationBootstrapDeps {
  VSphereClientCtor?: typeof VSphereClient;
  ProxmoxClientCtor?: typeof ProxmoxClient;
  AWSClientCtor?: typeof AWSClient;
  AzureClientCtor?: typeof AzureClient;
  logger?: Logger;
}

function hasCoreMigrationConfig(config: Config): boolean {
  return Boolean(
    config.proxmox.tokenId &&
      config.proxmox.tokenSecret &&
      config.vmware.host &&
      config.migration.esxiHost &&
      config.migration.proxmoxHost,
  );
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function connectOptionalClient<T extends { connect(): Promise<void>; disconnect(): void }>(
  label: string,
  createClient: () => T,
  logger: Logger,
): Promise<T | undefined> {
  let client: T | undefined;
  try {
    client = createClient();
    await client.connect();
    return client;
  } catch (err) {
    if (client) {
      try {
        client.disconnect();
      } catch {
        // Best effort cleanup. The original connection error is more useful.
      }
    }
    logger.warn(`[bootstrap] ${label} migration client unavailable: ${formatError(err)}`);
    return undefined;
  }
}

export async function createMigrationAdapter(
  config: Config,
  sshExec: SSHExecFn,
  deps: MigrationBootstrapDeps = {},
): Promise<MigrationAdapter | undefined> {
  if (!hasCoreMigrationConfig(config)) return undefined;

  const VSphereClientCtor = deps.VSphereClientCtor ?? VSphereClient;
  const ProxmoxClientCtor = deps.ProxmoxClientCtor ?? ProxmoxClient;
  const AWSClientCtor = deps.AWSClientCtor ?? AWSClient;
  const AzureClientCtor = deps.AzureClientCtor ?? AzureClient;
  const logger = deps.logger ?? console;

  let migVsphere: VSphereClient | undefined;
  let migProxmox: ProxmoxClient | undefined;

  try {
    migVsphere = new VSphereClientCtor({
      host: config.vmware.host,
      user: config.vmware.user,
      password: config.vmware.password,
      insecure: config.vmware.insecure,
    });
    await migVsphere.createSession();

    migProxmox = new ProxmoxClientCtor({
      host: config.proxmox.host,
      port: config.proxmox.port,
      tokenId: config.proxmox.tokenId,
      tokenSecret: config.proxmox.tokenSecret,
      allowSelfSignedCerts: config.proxmox.allowSelfSignedCerts,
    });
    await migProxmox.connect();
  } catch (err) {
    if (migVsphere) {
      await migVsphere.deleteSession().catch(() => undefined);
    }
    if (migProxmox) {
      migProxmox.disconnect();
    }
    logger.warn(`[bootstrap] Migration adapter disabled: ${formatError(err)}`);
    return undefined;
  }

  let awsClient: AWSClient | undefined;
  if (config.aws.accessKeyId && config.aws.secretAccessKey) {
    awsClient = await connectOptionalClient(
      "AWS",
      () =>
        new AWSClientCtor({
          accessKeyId: config.aws.accessKeyId,
          secretAccessKey: config.aws.secretAccessKey,
          region: config.aws.region,
          sessionToken: config.aws.sessionToken || undefined,
        }),
      logger,
    );
  }

  let azureClient: AzureClient | undefined;
  if (
    config.azure.tenantId &&
    config.azure.clientId &&
    config.azure.clientSecret &&
    config.azure.subscriptionId
  ) {
    azureClient = await connectOptionalClient(
      "Azure",
      () =>
        new AzureClientCtor({
          tenantId: config.azure.tenantId,
          clientId: config.azure.clientId,
          clientSecret: config.azure.clientSecret,
          subscriptionId: config.azure.subscriptionId,
          defaultLocation: config.azure.defaultLocation,
        }),
      logger,
    );
  }

  const migrationAdapter = new MigrationAdapter({
    vsphereClient: migVsphere,
    proxmoxClient: migProxmox,
    sshExec,
    esxiHost: config.migration.esxiHost,
    esxiUser: config.migration.esxiUser,
    proxmoxHost: config.migration.proxmoxHost,
    proxmoxUser: config.migration.proxmoxUser,
    proxmoxNode: config.migration.proxmoxNode,
    proxmoxStorage: config.migration.proxmoxStorage,
    awsClient,
    azureClient,
    awsS3Bucket: config.aws.s3MigrationBucket,
    awsS3Prefix: config.aws.s3MigrationPrefix,
  });
  await migrationAdapter.connect();
  return migrationAdapter;
}
