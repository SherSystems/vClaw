// ============================================================
// RHODES — SSH Adapter hello-world driver
//
// Loads config, instantiates an SshAdapter against a target named
// "self" pointing at 127.0.0.1 (user = $USER), and runs `uptime`.
//
// This is purely a smoke test. We never bake credentials in: if your
// agent has no SSH key for localhost it'll fail and we print the
// SshExecResult so you can see exactly why.
//
// Usage:  npx tsx scripts/ssh-hello.ts
// ============================================================

import "dotenv/config";
import { SshAdapter } from "../src/providers/ssh/adapter.js";

async function main() {
  const user = process.env.USER || process.env.LOGNAME || "root";

  const adapter = new SshAdapter({
    targets: [
      {
        id: "self",
        host: "127.0.0.1",
        user,
        description: "Localhost smoke target",
      },
    ],
    strict_host_key_checking: false, // homelab: dev convenience
    default_timeout_s: 5,
  });

  await adapter.connect();

  console.log("=== ssh-hello ===");
  console.log(`target user = ${user}`);

  // 1. Sanity: list targets — read-tier, no governance gate needed.
  const list = await adapter.execute("ssh_list_targets", {});
  console.log("ssh_list_targets:", JSON.stringify(list.data, null, 2));

  // 2. Dry-run a destructive command to demonstrate fail-closed behaviour.
  const dry = await adapter.execute("ssh_dry_run", { command: "rm -rf /" });
  console.log("ssh_dry_run('rm -rf /') ->", JSON.stringify(dry.data, null, 2));

  // 3. Actually shell out via `uptime`.
  const result = await adapter.execute("ssh_exec", {
    target_id: "self",
    command: "uptime",
  });
  console.log("ssh_exec('uptime') ->", JSON.stringify(result, null, 2));

  await adapter.disconnect();

  // Don't fail the script either way — the goal is to print the result.
  if (!result.success) {
    console.warn("\n[note] ssh_exec failed. This is OK if you don't have SSH keys set up for localhost.");
    console.warn("To make it succeed: `ssh-copy-id $USER@127.0.0.1` (or set up keys some other way).");
  }
}

main().catch((err) => {
  console.error("ssh-hello errored:", err);
  process.exit(1);
});
