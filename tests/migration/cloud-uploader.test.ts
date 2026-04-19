import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { uploadDiskFromSSHToS3 } from "../../src/migration/cloud-uploader.js";
import type { AWSClient } from "../../src/providers/aws/client.js";

type MockSSHProcess = EventEmitter & Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "kill" | "once">;

function createMockSSHProcess(): MockSSHProcess {
  const emitter = new EventEmitter() as MockSSHProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    emitter.emit("close", null, "SIGKILL");
    return true;
  });

  Object.assign(emitter, { stdout, stderr, kill });
  return emitter;
}

describe("cloud uploader", () => {
  it("streams disk bytes from SSH into AWS SDK upload", async () => {
    const mockProcess = createMockSSHProcess();
    const spawnProcess = vi.fn(() => mockProcess);

    const uploadStreamToS3 = vi.fn(
      async (
        body: Readable,
        bucket: string,
        key: string,
        totalBytes?: number,
      ): Promise<void> => {
        expect(bucket).toBe("migration-bucket");
        expect(key).toBe("vclaw-migration/vm-1/disk.vmdk");
        expect(totalBytes).toBe(10);

        const chunks: Buffer[] = [];
        for await (const chunk of body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        expect(Buffer.concat(chunks).toString("utf8")).toBe("disk-bytes");
      },
    );

    const uploadPromise = uploadDiskFromSSHToS3({
      awsClient: { uploadStreamToS3 } as unknown as AWSClient,
      sourceHost: "192.168.86.50",
      sourceUser: "root",
      sourcePath: "/tmp/disk.vmdk",
      bucket: "migration-bucket",
      key: "vclaw-migration/vm-1/disk.vmdk",
      totalBytes: 10,
      spawnProcess,
    });

    mockProcess.stdout.write("disk-");
    mockProcess.stdout.end("bytes");
    mockProcess.emit("close", 0, null);

    await uploadPromise;

    expect(spawnProcess).toHaveBeenCalledWith(
      "192.168.86.50",
      "root",
      "/tmp/disk.vmdk",
    );
    expect(uploadStreamToS3).toHaveBeenCalledTimes(1);
  });

  it("throws when the SSH stream exits with non-zero status", async () => {
    const mockProcess = createMockSSHProcess();
    const spawnProcess = vi.fn(() => mockProcess);

    const uploadStreamToS3 = vi.fn(async (body: Readable): Promise<void> => {
      for await (const _chunk of body) {
        // Drain stream.
      }
    });

    const uploadPromise = uploadDiskFromSSHToS3({
      awsClient: { uploadStreamToS3 } as unknown as AWSClient,
      sourceHost: "192.168.86.50",
      sourceUser: "root",
      sourcePath: "/tmp/disk.vmdk",
      bucket: "migration-bucket",
      key: "vclaw-migration/vm-1/disk.vmdk",
      spawnProcess,
    });

    mockProcess.stderr.end("Permission denied");
    mockProcess.stdout.end();
    mockProcess.emit("close", 255, null);

    await expect(uploadPromise).rejects.toThrow("SSH disk stream failed");
  });
});
