#!/usr/bin/env tsx
// ============================================================
// vClaw — Live Migration Smoke Test (Phase 2: Proxmox -> VMware)
// Migrates Proxmox VM 112 (Migration-TestVM) back to vSphere
// ============================================================

import { config } from "dotenv";
import { spawn } from "node:child_process";
import { VSphereClient } from "../src/providers/vmware/client.js";
import { ProxmoxClient } from "../src/providers/proxmox/client.js";
import { MigrationOrchestrator } from "../src/migration/orchestrator.js";
import type { SSHExecResult } from "../src/migration/types.js";

config();

// ── SSH Helper ─────────────────────────────────────────────

function sshExec(host: string, user: string, command: string, timeoutMs = 30_000): Promise<SSHExecResult> {
  return new Promise((resolve) => {
    const args = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      `${user}@${host}`,
      command,
    ];

    const proc = spawn("ssh", args, { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const log = (msg: string) => console.log(`[migration-p2] ${msg}`);
  const VMID = 112; // The VM we migrated to Proxmox in Phase 1

  // Connect to both providers
  const vsphere = new VSphereClient({
    host: process.env.VMWARE_HOST!,
    user: process.env.VMWARE_USER!,
    password: process.env.VMWARE_PASSWORD!,
    insecure: true,
  });

  const proxmox = new ProxmoxClient({
    host: process.env.PROXMOX_HOST!,
    port: Number(process.env.PROXMOX_PORT ?? 8006),
    tokenId: process.env.PROXMOX_TOKEN_ID!,
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
    allowSelfSignedCerts: true,
  });

  log("Connecting to vSphere...");
  await vsphere.createSession();
  log("Connected to vSphere ✓");

  log("Connecting to Proxmox...");
  await proxmox.connect();
  log("Connected to Proxmox ✓");

  // Verify source VM exists on Proxmox
  const vmConfig = await proxmox.getVMConfig("pranavlab", VMID);
  log(`Source VM: ${vmConfig.name} (VMID ${VMID})`);
  log(`  CPU: ${vmConfig.cores} cores, RAM: ${vmConfig.memory} MiB`);
  log(`  Disk: ${vmConfig.scsi0}`);

  // Create orchestrator
  const orchestrator = new MigrationOrchestrator({
    vsphereClient: vsphere,
    proxmoxClient: proxmox,
    sshExec,
    esxiHost: process.env.MIGRATION_ESXI_HOST!,
    esxiUser: process.env.MIGRATION_ESXI_USER || "root",
    proxmoxHost: process.env.MIGRATION_PROXMOX_HOST!,
    proxmoxUser: process.env.MIGRATION_PROXMOX_USER || "root",
    proxmoxNode: process.env.MIGRATION_PROXMOX_NODE!,
    proxmoxStorage: process.env.MIGRATION_PROXMOX_STORAGE || "local-lvm",
    onProgress: (step, detail) => {
      log(`  [${step}] ${detail}`);
    },
  });

  try {
    // Dry run first
    log("\nRunning migration plan (dry run)...");
    const plan = await orchestrator.planProxmoxToVMware(VMID);
    log(`Plan: migrate "${plan.source.vmName}" -> vSphere (${plan.target.storage})`);
    log(`  CPU: ${plan.vmConfig.cpuCount}, RAM: ${plan.vmConfig.memoryMiB} MiB`);
    log(`  Disks: ${plan.vmConfig.disks.length}, NICs: ${plan.vmConfig.nics.length}`);
    log(`  Steps: ${plan.steps.map(s => s.name).join(" -> ")}`);

    // Execute the migration
    log("\nExecuting Proxmox -> VMware migration...");
    const result = await orchestrator.migrateProxmoxToVMware(VMID);

    log("\n=== Migration Complete ===");
    log(`Status: ${result.status}`);
    log(`Source: Proxmox VM ${result.source.vmId} (${result.source.vmName})`);
    log(`Target: vSphere VM on ${result.target.storage}`);
    log("Steps:");
    for (const step of result.steps) {
      log(`  ${step.status === "completed" ? "✓" : "✗"} ${step.name}${step.detail ? ` — ${step.detail}` : ""}`);
    }
  } catch (err) {
    log(`\nMigration failed: ${err}`);
    process.exit(1);
  }

  // Cleanup
  await vsphere.deleteSession();
  log("\nDone! Full round-trip: VMware -> Proxmox -> VMware ✓");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
