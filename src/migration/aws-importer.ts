// ============================================================
// vClaw — AWS EC2 VM Importer
// Uploads disk to S3, imports as AMI, and launches EC2 instance
// ============================================================

import type { AWSClient } from "../providers/aws/client.js";
import { uploadDiskFromSSHToS3 } from "./cloud-uploader.js";
import type { MigrationVMConfig } from "./types.js";

// ── Interfaces ──────────────────────────────────────────────

export interface AWSImportConfig {
  vmConfig: MigrationVMConfig;
  diskPath: string; // local path to vmdk/raw disk on staging host
  diskFormat: "vmdk" | "raw" | "vhd";
  importMode?: "auto" | "snapshot" | "image";
  fallbackToImportImage?: boolean;
  instanceType?: string; // auto-determined from vmConfig if not specified
  subnetId?: string;
  securityGroupIds?: string[];
  keyName?: string;
  onUploadProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface AWSImportResult {
  amiId: string;
  instanceId: string;
  instanceType: string;
  privateIp?: string;
}

// ── Instance Type Lookup Table ──────────────────────────────

interface InstanceSpec {
  type: string;
  vCPU: number;
  memoryMiB: number;
}

const INSTANCE_TABLE: InstanceSpec[] = [
  { type: "c5.large", vCPU: 2, memoryMiB: 4096 },
  { type: "t3.large", vCPU: 2, memoryMiB: 8192 },
  { type: "m5.large", vCPU: 2, memoryMiB: 8192 },
  { type: "c5.xlarge", vCPU: 4, memoryMiB: 8192 },
  { type: "m5.xlarge", vCPU: 4, memoryMiB: 16384 },
  { type: "r5.large", vCPU: 2, memoryMiB: 16384 },
  { type: "c5.2xlarge", vCPU: 8, memoryMiB: 16384 },
  { type: "m5.2xlarge", vCPU: 8, memoryMiB: 32768 },
  { type: "r5.xlarge", vCPU: 4, memoryMiB: 32768 },
  { type: "m5.4xlarge", vCPU: 16, memoryMiB: 65536 },
];

// ── Importer ────────────────────────────────────────────────

export class AWSImporter {
  private readonly client: AWSClient;
  private readonly s3Bucket: string;
  private readonly s3Prefix: string;

  constructor(client: AWSClient, s3Bucket: string, s3Prefix: string) {
    this.client = client;
    this.s3Bucket = s3Bucket;
    this.s3Prefix = s3Prefix;
  }

  /**
   * Import a VM into AWS EC2 from a disk image on a staging host.
   * 1. Stream disk from staging host over SSH and upload to S3 via AWS SDK
   * 2. Import image from S3 using AWS VM Import/Export
   * 3. Wait for import task to complete (AMI creation)
   * 4. Launch EC2 instance from the imported AMI
   */
  async importVM(
    config: AWSImportConfig,
    stagingHost: string,
    stagingUser: string
  ): Promise<AWSImportResult> {
    const { vmConfig, diskPath, diskFormat } = config;
    const planId = vmConfig.name.replace(/[^a-zA-Z0-9_-]/g, "-");
    const filename = diskPath.split("/").pop() ?? "disk.vmdk";
    const s3Key = `${this.s3Prefix}${planId}/${filename}`;

    // 1. Upload disk to S3 via staging host
    console.log(`[aws-importer] Uploading disk to s3://${this.s3Bucket}/${s3Key}`);
    await this.uploadDiskToS3(
      stagingHost,
      stagingUser,
      diskPath,
      s3Key,
      config.onUploadProgress,
    );

    // 2. Import image from S3 (snapshot-first for raw by default)
    const importMode = config.importMode ?? "auto";
    const fallbackToImportImage = config.fallbackToImportImage ?? true;
    const preferSnapshotImport = importMode === "snapshot" ||
      (importMode === "auto" && diskFormat === "raw");
    const importDescription = `vClaw import: ${vmConfig.name}`;

    let amiId: string;
    if (preferSnapshotImport) {
      try {
        console.log(
          `[aws-importer] Starting ImportSnapshot for ${vmConfig.name} (${diskFormat.toUpperCase()})`
        );
        const snapshotTaskId = await this.client.importSnapshot({
          s3Bucket: this.s3Bucket,
          s3Key,
          format: diskFormat,
          description: importDescription,
        });

        console.log(
          `[aws-importer] Waiting for snapshot import task ${snapshotTaskId} to complete...`
        );
        const snapshotId = await this.waitForImportSnapshot(snapshotTaskId, 3 * 60 * 60 * 1000);
        const imageName = `${planId}-${Date.now()}`;
        console.log(
          `[aws-importer] Registering AMI from snapshot ${snapshotId} as ${imageName}`
        );
        amiId = await this.client.registerImageFromSnapshot({
          snapshotId,
          name: imageName,
          description: importDescription,
          architecture: "x86_64",
          rootDeviceName: "/dev/sda1",
          virtualizationType: "hvm",
          enaSupport: true,
          bootMode: "uefi-preferred",
        });
      } catch (error) {
        if (!fallbackToImportImage || importMode === "snapshot") {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[aws-importer] ImportSnapshot path failed (${message}). Falling back to ImportImage.`
        );
        amiId = await this.importViaImageTask(s3Key, diskFormat, importDescription);
      }
    } else {
      amiId = await this.importViaImageTask(s3Key, diskFormat, importDescription);
    }

    // 3. Launch instance from imported AMI
    const instanceType = config.instanceType ?? this.recommendInstanceType(vmConfig);
    console.log(
      `[aws-importer] Launching instance from ${amiId} as ${instanceType}`
    );

    const instance = await this.client.launchInstance({
      amiId,
      instanceType,
      subnetId: config.subnetId,
      securityGroupIds: config.securityGroupIds,
      keyName: config.keyName,
      name: vmConfig.name,
    });

    console.log(
      `[aws-importer] Instance ${instance.instanceId} launched successfully`
    );

    return {
      amiId,
      instanceId: instance.instanceId,
      instanceType,
      privateIp: instance.privateIp,
    };
  }

  private async importViaImageTask(
    s3Key: string,
    diskFormat: AWSImportConfig["diskFormat"],
    description: string
  ): Promise<string> {
    console.log(
      `[aws-importer] Starting ImportImage for ${description} (${diskFormat.toUpperCase()})`
    );
    const taskId = await this.client.importImage({
      s3Bucket: this.s3Bucket,
      s3Key,
      format: diskFormat,
      description,
    });

    console.log(`[aws-importer] Waiting for import task ${taskId} to complete...`);
    return this.waitForImportImage(taskId, description, 3 * 60 * 60 * 1000);
  }

  /**
   * Recommend an EC2 instance type based on VM CPU and memory requirements.
   * Finds the smallest instance where vCPU >= cpuCount and RAM >= memoryMiB.
   * Defaults to m5.large if nothing fits well.
   */
  recommendInstanceType(vmConfig: MigrationVMConfig): string {
    // Sort by total resource (vCPU + memory) ascending to find smallest fit
    const sorted = [...INSTANCE_TABLE].sort(
      (a, b) => a.memoryMiB + a.vCPU * 1024 - (b.memoryMiB + b.vCPU * 1024)
    );

    for (const spec of sorted) {
      if (spec.vCPU >= vmConfig.cpuCount && spec.memoryMiB >= vmConfig.memoryMiB) {
        return spec.type;
      }
    }

    // Nothing fits — return the largest available or default
    return "m5.large";
  }

  /**
   * Poll an import image task until completion.
   * AWS VM Import/Export tasks can take 30-60+ minutes for large disks.
   * @returns The AMI ID of the imported image.
   */
  async waitForImportImage(
    taskId: string,
    description: string,
    timeoutMs = 3 * 60 * 60 * 1000
  ): Promise<string> {
    const pollIntervalMs = 30_000; // 30 seconds
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const tasks = await this.client.describeImportTasks([taskId]);
      const task = tasks.find((t) => t.importTaskId === taskId);

      if (!task) {
        throw new Error(`Import task ${taskId} not found`);
      }

      const status = task.status.toLowerCase();
      const progress = task.progress ?? "unknown";
      console.log(
        `[aws-importer] Import task ${taskId}: status=${task.status}, progress=${progress}%`
      );

      if (status === "completed") {
        if (task.imageId) {
          return task.imageId;
        }

        const allImages = await this.client.describeImages();
        const imported = allImages
          .filter((img) => img.description === description)
          .sort((a, b) => Date.parse(b.creationDate) - Date.parse(a.creationDate))[0];
        if (imported) {
          return imported.imageId;
        }

        throw new Error(
          `Import task ${taskId} completed but could not locate the resulting AMI`
        );
      }

      if (status === "deleted" || status === "deleting") {
        throw new Error(
          `Import task ${taskId} was cancelled: ${task.statusMessage ?? "unknown reason"}`
        );
      }

      if (task.statusMessage?.toLowerCase().includes("error")) {
        throw new Error(
          `Import task ${taskId} failed: ${task.statusMessage}`
        );
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Import task ${taskId} timed out after ${Math.round(timeoutMs / 60_000)} minutes`
    );
  }

  async waitForImportSnapshot(
    taskId: string,
    timeoutMs = 3 * 60 * 60 * 1000
  ): Promise<string> {
    const pollIntervalMs = 30_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const tasks = await this.client.describeImportSnapshotTasks([taskId]);
      const task = tasks.find((t) => t.importTaskId === taskId);

      if (!task) {
        throw new Error(`Import snapshot task ${taskId} not found`);
      }

      const status = task.status.toLowerCase();
      const progress = task.progress ?? "unknown";
      console.log(
        `[aws-importer] Import snapshot task ${taskId}: status=${task.status}, progress=${progress}%`
      );

      if (status === "completed") {
        if (!task.snapshotId) {
          throw new Error(
            `Import snapshot task ${taskId} completed but no snapshotId returned`
          );
        }
        return task.snapshotId;
      }

      if (status === "deleted" || status === "deleting") {
        throw new Error(
          `Import snapshot task ${taskId} was cancelled: ${task.statusMessage ?? "unknown reason"}`
        );
      }

      if (task.statusMessage?.toLowerCase().includes("error")) {
        throw new Error(
          `Import snapshot task ${taskId} failed: ${task.statusMessage}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Import snapshot task ${taskId} timed out after ${Math.round(timeoutMs / 60_000)} minutes`
    );
  }

  /**
   * Upload a disk image from a staging host to S3 by streaming it over SSH
   * and sending directly with the AWS SDK on the vClaw host.
   */
  async uploadDiskToS3(
    stagingHost: string,
    stagingUser: string,
    diskPath: string,
    s3Key: string,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void,
  ): Promise<void> {
    const s3Uri = `s3://${this.s3Bucket}/${s3Key}`;
    await uploadDiskFromSSHToS3({
      awsClient: this.client,
      sourceHost: stagingHost,
      sourceUser: stagingUser,
      sourcePath: diskPath,
      bucket: this.s3Bucket,
      key: s3Key,
      onProgress,
    });

    // Verify the object landed in S3
    const head = await this.client.headObject(this.s3Bucket, s3Key);
    if (!head.exists) {
      throw new Error(
        `Disk upload to s3://${this.s3Bucket}/${s3Key} succeeded but object not found`
      );
    }

    console.log(
      `[aws-importer] Disk uploaded to S3: ${s3Uri} (${Math.round(head.size / 1024 / 1024)} MiB)`
    );
  }
}
