#!/usr/bin/env tsx
// ============================================================
// rhodes-user-list — list users in ~/.rhodes/users.json
// Hashes are NEVER printed.
// ============================================================

import { exit } from "node:process";
import { UserStore } from "../src/auth/store.js";

function main() {
  const store = new UserStore();
  if (!store.isBootstrapped()) {
    console.log("(no users configured)");
    return;
  }
  const users = store.list();
  const widthName = Math.max(8, ...users.map((u) => u.username.length));
  console.log(`${"USERNAME".padEnd(widthName)}  ROLE     CREATED`);
  for (const u of users) {
    console.log(`${u.username.padEnd(widthName)}  ${u.role.padEnd(7)}  ${u.created_at}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err);
  exit(1);
}
