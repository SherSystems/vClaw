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

  const sessionId = (c as unknown as { sessionId: string }).sessionId;
  const baseUrl = `https://${process.env.VMWARE_HOST}`;

  // Try various endpoints to get host metrics
  const endpoints = [
    "/api/vcenter/host",
    "/api/vcenter/host?hosts=host-11",
    "/api/stats/rsrc/hosts",
    "/api/appliance/system/version",
  ];

  for (const ep of endpoints) {
    const url = `${baseUrl}${ep}`;
    console.log(`\n${ep}`);
    try {
      const resp = await fetch(url, {
        headers: { "vmware-api-session-id": sessionId },
      });
      console.log(`  ${resp.status}`);
      if (resp.ok) {
        const data = await resp.json();
        console.log(`  `, JSON.stringify(data).slice(0, 300));
      }
    } catch (e: unknown) {
      console.log(`  Error:`, (e as Error).message);
    }
  }

  // Check vCenter version
  const versionUrl = `${baseUrl}/api/appliance/system/version`;
  try {
    const resp = await fetch(versionUrl, {
      headers: { "vmware-api-session-id": sessionId },
    });
    if (resp.ok) {
      const ver = await resp.json();
      console.log("\nvCenter version:", JSON.stringify(ver));
    }
  } catch {}

  // Try SOAP-style query for host system properties via MOB
  // The proper approach: use /sdk/vim25 SOAP but that's complex
  // Try the /api/vcenter/host?hosts=host-11 with filter
  const filterUrl = `${baseUrl}/api/vcenter/host?filter.hosts=host-11`;
  console.log(`\nFiltered: ${filterUrl}`);
  try {
    const resp = await fetch(filterUrl, {
      headers: { "vmware-api-session-id": sessionId },
    });
    console.log(`  ${resp.status}`);
    if (resp.ok) {
      const data = await resp.json();
      console.log(`  `, JSON.stringify(data, null, 2));
    }
  } catch (e: unknown) {
    console.log(`  Error:`, (e as Error).message);
  }

  await c.deleteSession();
}
main().catch(console.error);
