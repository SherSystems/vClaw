import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { AnonymousCredential, PageBlobClient } from "@azure/storage-blob";

import type { AWSClient } from "../providers/aws/client.js";

const DEFAULT_UPLOAD_TIMEOUT_MS = 7_200_000; // 2 hours
const MAX_PAGE_BLOB_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB, 512-byte aligned

export type SpawnSSHDiskReadProcess = (
  sourceHost: string,
  sourceUser: string,
  sourcePath: string,
) => SSHDiskReadProcess;

export interface UploadDiskFromSSHToS3Options {
  awsClient: AWSClient;
  sourceHost: string;
  sourceUser: string;
  sourcePath: string;
  bucket: string;
  key: string;
  timeoutMs?: number;
  totalBytes?: number;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  spawnProcess?: SpawnSSHDiskReadProcess;
}

export interface UploadDiskFromSSHToAzurePageBlobOptions {
  sourceHost: string;
  sourceUser: string;
  sourcePath: string;
  destinationUrlWithSas: string;
  diskSizeBytes: number;
  timeoutMs?: number;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  spawnProcess?: SpawnSSHDiskReadProcess;
}

interface SSHDiskReadHandle {
  stream: Readable;
  waitForExit: () => Promise<void>;
  cancel: () => void;
}

interface SSHDiskReadProcess {
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: {
    (event: "error", listener: (error: Error) => void): unknown;
    (
      event: "close",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
  };
}

function defaultSpawnSSHDiskReadProcess(
  sourceHost: string,
  sourceUser: string,
  sourcePath: string,
): SSHDiskReadProcess {
  return spawn(
    "ssh",
    [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      `${sourceUser}@${sourceHost}`,
      "--",
      "cat",
      sourcePath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function openDiskReadStreamOverSSH(
  sourceHost: string,
  sourceUser: string,
  sourcePath: string,
  timeoutMs: number,
  spawnProcess?: SpawnSSHDiskReadProcess,
): SSHDiskReadHandle {
  const process = (spawnProcess ?? defaultSpawnSSHDiskReadProcess)(
    sourceHost,
    sourceUser,
    sourcePath,
  );
  const stream = process.stdout as Readable;
  let timedOut = false;
  let stderr = "";
  let settled = false;
  let settle: (() => void) | null = null;
  let settleErr: ((error: Error) => void) | null = null;

  const exitPromise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    settleErr = reject;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    process.kill("SIGKILL");
  }, timeoutMs);

  process.stderr.once("error", () => {
    // Ignore stderr stream read errors and rely on process close/error.
  });

  process.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
    if (stderr.length > 32_768) {
      stderr = stderr.slice(stderr.length - 32_768);
    }
  });

  process.once("error", (error: Error) => {
    if (settled || !settleErr) return;
    settled = true;
    clearTimeout(timer);
    settleErr(new Error(`Failed to start SSH disk stream: ${error.message}`));
  });

  process.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled || !settle || !settleErr) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut) {
      settleErr(
        new Error(
          `SSH disk stream timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
        ),
      );
      return;
    }

    if (code === 0) {
      settle();
      return;
    }

    const reason = stderr.trim() || signal || `exit code ${code ?? "unknown"}`;
    settleErr(new Error(`SSH disk stream failed: ${reason}`));
  });

  return {
    stream,
    waitForExit: () => exitPromise,
    cancel: () => {
      process.kill("SIGKILL");
    },
  };
}

export async function uploadDiskFromSSHToS3(
  options: UploadDiskFromSSHToS3Options,
): Promise<void> {
  const sshReader = openDiskReadStreamOverSSH(
    options.sourceHost,
    options.sourceUser,
    options.sourcePath,
    options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    options.spawnProcess,
  );

  try {
    await Promise.all([
      options.awsClient.uploadStreamToS3(
        sshReader.stream,
        options.bucket,
        options.key,
        options.totalBytes,
        options.onProgress,
      ),
      sshReader.waitForExit(),
    ]);
  } catch (error) {
    sshReader.cancel();
    throw error;
  }
}

export async function uploadDiskFromSSHToAzurePageBlob(
  options: UploadDiskFromSSHToAzurePageBlobOptions,
): Promise<void> {
  if (!Number.isFinite(options.diskSizeBytes) || options.diskSizeBytes <= 0) {
    throw new Error("diskSizeBytes must be a positive number");
  }
  if (options.diskSizeBytes % 512 !== 0) {
    throw new Error("diskSizeBytes must be 512-byte aligned for Azure page blobs");
  }

  const pageBlobClient = new PageBlobClient(
    options.destinationUrlWithSas,
    new AnonymousCredential(),
  );
  await pageBlobClient.create(options.diskSizeBytes);

  const sshReader = openDiskReadStreamOverSSH(
    options.sourceHost,
    options.sourceUser,
    options.sourcePath,
    options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    options.spawnProcess,
  );

  let uploadedBytes = 0;
  let pending = new Uint8Array(0);

  try {
    for await (const chunk of sshReader.stream) {
      const chunkBuffer = Buffer.isBuffer(chunk)
        ? chunk
        : (typeof chunk === "string"
            ? Buffer.from(chunk)
            : (chunk instanceof Uint8Array
                ? Buffer.from(chunk)
                : null));
      if (!chunkBuffer) {
        throw new Error("Unsupported SSH stream chunk type");
      }
      if (pending.length > 0) {
        const merged = new Uint8Array(pending.length + chunkBuffer.length);
        merged.set(pending, 0);
        merged.set(chunkBuffer, pending.length);
        pending = merged;
      } else {
        pending = new Uint8Array(chunkBuffer);
      }

      const alignedLength = pending.length - (pending.length % 512);
      if (alignedLength === 0) {
        continue;
      }

      let cursor = 0;
      while (cursor < alignedLength) {
        const remaining = alignedLength - cursor;
        const uploadLength = Math.min(remaining, MAX_PAGE_BLOB_CHUNK_BYTES);
        const payload = pending.subarray(cursor, cursor + uploadLength);
        await pageBlobClient.uploadPages(payload, uploadedBytes, uploadLength);
        uploadedBytes += uploadLength;
        cursor += uploadLength;
        options.onProgress?.(uploadedBytes, options.diskSizeBytes);
      }

      pending = pending.subarray(alignedLength);
    }

    if (pending.length > 0) {
      throw new Error(
        `SSH stream ended with ${pending.length} trailing bytes that are not 512-byte aligned`,
      );
    }

    await sshReader.waitForExit();

    if (uploadedBytes !== options.diskSizeBytes) {
      throw new Error(
        `Uploaded ${uploadedBytes} bytes, expected ${options.diskSizeBytes} bytes`,
      );
    }
  } catch (error) {
    sshReader.cancel();
    throw error;
  }
}
