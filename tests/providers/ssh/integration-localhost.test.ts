// ============================================================
// Optional integration test — actually shells into localhost.
// SKIPPED unless SKIP_SSH_INTEGRATION is unset AND ssh works.
// ============================================================

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { SshAdapter } from "../../../src/providers/ssh/adapter.js";

const SKIP = process.env.SKIP_SSH_INTEGRATION !== "" && process.env.SKIP_SSH_INTEGRATION !== "0";

// Probe: can we actually `ssh -o BatchMode=yes localhost echo ok`?
// If not, skip everything below.
function canSsh(): boolean {
  try {
    const r = spawnSync(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=2",
        "localhost",
        "echo ok",
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    return r.status === 0 && r.stdout.trim() === "ok";
  } catch {
    return false;
  }
}

describe.skipIf(SKIP || !canSsh())("SSH integration (localhost)", () => {
  it("runs `uptime` against localhost via the adapter", async () => {
    const user = process.env.USER || "root";
    const adapter = new SshAdapter({
      targets: [{ id: "self", host: "localhost", user }],
      strict_host_key_checking: false,
      default_timeout_s: 5,
    });
    await adapter.connect();
    const result = await adapter.execute("ssh_exec", {
      target_id: "self",
      command: "uptime",
    });
    expect(result.success).toBe(true);
    const data = result.data as { exit_code: number; stdout: string };
    expect(data.exit_code).toBe(0);
    expect(data.stdout.length).toBeGreaterThan(0);
  });
});
