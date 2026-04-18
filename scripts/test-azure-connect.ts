import { AzureClient } from "../src/providers/azure/client.js";
import { AzureAdapter } from "../src/providers/azure/adapter.js";
import { getConfig } from "../src/config.js";

async function main() {
  const config = getConfig();
  const { tenantId, clientId, clientSecret, subscriptionId, defaultLocation } = config.azure;

  if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
    console.error("Missing Azure env vars. Got:", {
      tenantId: Boolean(tenantId),
      clientId: Boolean(clientId),
      clientSecret: Boolean(clientSecret),
      subscriptionId: Boolean(subscriptionId),
    });
    process.exit(1);
  }

  console.log(`Subscription: ${subscriptionId}`);
  console.log(`Tenant:       ${tenantId}`);
  console.log(`Default loc:  ${defaultLocation}`);

  const client = new AzureClient({ tenantId, clientId, clientSecret, subscriptionId, defaultLocation });
  console.log("\nConnecting...");
  await client.connect();
  console.log("✓ Connected");

  console.log("\nListing resource groups:");
  const rgs = await client.listResourceGroups();
  if (rgs.length === 0) {
    console.log("(none yet — new subscription)");
  } else {
    for (const rg of rgs) {
      console.log(`  - ${rg.name} (${rg.location}) [${rg.provisioningState}]`);
    }
  }

  console.log("\nListing VMs:");
  const vms = await client.listVMs();
  if (vms.length === 0) {
    console.log("(none — expected for a fresh subscription)");
  } else {
    for (const vm of vms) {
      console.log(`  - ${vm.name} in ${vm.resourceGroup}/${vm.location} (${vm.vmSize})`);
    }
  }

  console.log("\nGetting adapter cluster state:");
  const adapter = new AzureAdapter({ tenantId, clientId, clientSecret, subscriptionId, defaultLocation });
  await adapter.connect();
  const state = await adapter.getClusterState();
  console.log(`  adapter=${state.adapter}, nodes=${state.nodes.length}, vms=${state.vms.length}, storage=${state.storage.length}`);

  console.log("\n✓ Azure provider works end-to-end with real creds.");
}

main().catch((err) => {
  console.error("✗ Azure connection test failed:", err.message);
  console.error(err);
  process.exit(1);
});
