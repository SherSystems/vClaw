#!/usr/bin/env tsx
// ============================================================
// rhodes-user-remove — remove a user from ~/.rhodes/users.json
// Usage: npx tsx scripts/rhodes-user-remove.ts <username>
// ============================================================

import { argv, env, exit } from "node:process";
import { UserStore } from "../src/auth/store.js";

function parseArgs(args: string[]): { username: string; token?: string } {
  let token: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token" && i + 1 < args.length) {
      token = args[i + 1];
      i++;
    } else if (args[i].startsWith("--token=")) {
      token = args[i].slice("--token=".length);
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length < 1) {
    console.error("Usage: rhodes-user-remove <username> [--token <token>]");
    exit(2);
  }
  return { username: positional[0], token };
}

async function main() {
  const { username, token } = parseArgs(argv.slice(2));
  const store = new UserStore();
  if (store.isBootstrapped()) {
    const expected = env.RHODES_BOOTSTRAP_TOKEN ?? token;
    const provided = token ?? env.RHODES_BOOTSTRAP_TOKEN;
    if (!expected || !provided || expected !== provided) {
      console.error(
        "Users exist. Provide --token <token> or set $RHODES_BOOTSTRAP_TOKEN.",
      );
      exit(3);
    }
  }
  const removed = store.remove(username);
  if (!removed) {
    console.error(`No user named "${username}".`);
    exit(1);
  }
  console.log(`User "${username}" removed.`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
