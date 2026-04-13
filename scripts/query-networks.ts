#!/usr/bin/env tsx
import { config } from "dotenv";
import { VSphereClient } from "../src/providers/vmware/client.js";
config();

async function main() {
  const c = new VSphereClient({
    host: process.env.VMWARE_HOST!,
    user: process.env.VMWARE_USER!,
    password: process.env.VMWARE_PASSWORD!,
    insecure: true,
  });
  await c.createSession();
  const networks = await c.listNetworks();
  console.log("Networks:", JSON.stringify(networks, null, 2));
  await c.deleteSession();
}
main().catch(console.error);
