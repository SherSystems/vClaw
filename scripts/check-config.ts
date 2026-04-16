import 'dotenv/config';
import { getConfig } from '../src/config.js';
import { ToolRegistry } from '../src/providers/registry.js';
import { AWSAdapter } from '../src/providers/aws/adapter.js';
import { MigrationAdapter } from '../src/migration/adapter.js';
import { AWSClient } from '../src/providers/aws/client.js';
import { VSphereClient } from '../src/providers/vmware/client.js';
import { ProxmoxClient } from '../src/providers/proxmox/client.js';
import { spawn } from 'node:child_process';
import type { SSHExecResult } from '../src/migration/types.js';

const config = getConfig();

console.log('=== Config Check ===');
console.log('AWS key:', !!config.aws.accessKeyId);
console.log('AWS secret:', !!config.aws.secretAccessKey);
console.log('AWS region:', config.aws.region);
console.log('AWS S3 bucket:', config.aws.s3MigrationBucket);
console.log('VMware host:', config.vmware.host);
console.log('Proxmox token:', !!config.proxmox.tokenId);
console.log('Migration ESXi:', config.migration.esxiHost);
console.log('Migration Proxmox:', config.migration.proxmoxHost);

// Check if migration adapter would register AWS tools
const hasMigrationPrereqs = !!(
  config.proxmox.tokenId && config.proxmox.tokenSecret &&
  config.vmware.host &&
  config.migration.esxiHost && config.migration.proxmoxHost
);
const hasAWS = !!(config.aws.accessKeyId && config.aws.secretAccessKey);

console.log('\n=== Migration Adapter ===');
console.log('Base prereqs met:', hasMigrationPrereqs);
console.log('AWS configured:', hasAWS);
console.log('AWS tools will register:', hasMigrationPrereqs && hasAWS);

if (hasMigrationPrereqs && hasAWS) {
  // Actually create the migration adapter and check tools
  const sshExec = (host: string, user: string, command: string, timeoutMs = 30000): Promise<SSHExecResult> => {
    return new Promise((resolve) => {
      const proc = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', `${user}@${host}`, command], { timeout: timeoutMs });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => { resolve({ stdout, stderr, exitCode: code ?? 1 }); });
      proc.on('error', (err) => { resolve({ stdout, stderr: err.message, exitCode: 1 }); });
    });
  };

  const awsClient = new AWSClient({
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
    region: config.aws.region,
  });

  const vsphereClient = new VSphereClient({
    host: config.vmware.host,
    user: config.vmware.user,
    password: config.vmware.password,
    insecure: config.vmware.insecure,
  });

  const proxmoxClient = new ProxmoxClient({
    host: config.proxmox.host,
    port: config.proxmox.port,
    tokenId: config.proxmox.tokenId,
    tokenSecret: config.proxmox.tokenSecret,
    allowSelfSignedCerts: config.proxmox.allowSelfSignedCerts,
  });

  const migAdapter = new MigrationAdapter({
    vsphereClient,
    proxmoxClient,
    sshExec,
    esxiHost: config.migration.esxiHost,
    esxiUser: config.migration.esxiUser,
    proxmoxHost: config.migration.proxmoxHost,
    proxmoxUser: config.migration.proxmoxUser,
    proxmoxNode: config.migration.proxmoxNode,
    proxmoxStorage: config.migration.proxmoxStorage,
    awsClient,
    awsS3Bucket: config.aws.s3MigrationBucket,
    awsS3Prefix: config.aws.s3MigrationPrefix,
  });

  const tools = migAdapter.getTools();
  console.log('\nRegistered migration tools:', tools.length);
  for (const t of tools) {
    console.log(`  ${t.name} (${t.tier})`);
  }
}
