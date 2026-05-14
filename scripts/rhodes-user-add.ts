#!/usr/bin/env tsx
// ============================================================
// rhodes-user-add — add or update a user in ~/.rhodes/users.json
// Usage: npx tsx scripts/rhodes-user-add.ts <username> <role>
// Prompts for password via stdin (no echo).
// ============================================================

import { stdin, stdout, exit, argv, env } from "node:process";
import readline from "node:readline";
import { UserStore, RoleSchema } from "../src/auth/store.js";
import { hashPassword } from "../src/auth/password.js";

interface ParsedArgs {
  username: string;
  role: string;
  token?: string;
}

function parseArgs(args: string[]): ParsedArgs {
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
  if (positional.length < 2) {
    console.error("Usage: rhodes-user-add <username> <role> [--token <token>]");
    exit(2);
  }
  return { username: positional[0], role: positional[1], token };
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    // Hide input by intercepting the writer.
    const originalWrite = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      // Allow the initial prompt through; mask everything else.
      if (s.includes(prompt)) {
        originalWrite.call(rl, s);
      } else {
        originalWrite.call(rl, "");
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const { username, role, token } = parseArgs(argv.slice(2));
  const parsedRole = RoleSchema.safeParse(role);
  if (!parsedRole.success) {
    console.error(`Invalid role "${role}". Must be one of: admin, viewer`);
    exit(2);
  }

  const store = new UserStore();
  const bootstrap = !store.isBootstrapped();
  if (!bootstrap) {
    const expected = env.RHODES_BOOTSTRAP_TOKEN ?? token;
    const provided = token ?? env.RHODES_BOOTSTRAP_TOKEN;
    if (!expected || !provided || expected !== provided) {
      console.error(
        "Users already exist. Provide an admin bootstrap token via --token <token>\n" +
          "or set $RHODES_BOOTSTRAP_TOKEN. (For the first user, this is not required.)",
      );
      exit(3);
    }
  }

  const pw1 = await promptHidden("Password: ");
  if (pw1.length < 8) {
    console.error("Password must be at least 8 characters.");
    exit(2);
  }
  const pw2 = await promptHidden("Confirm:  ");
  if (pw1 !== pw2) {
    console.error("Passwords did not match.");
    exit(2);
  }

  const hash = await hashPassword(pw1);
  store.upsert({
    username,
    bcrypt_hash: hash,
    role: parsedRole.data,
    created_at: new Date().toISOString(),
  });

  console.log(`User "${username}" (${parsedRole.data}) added to ${store.filePath}`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
