// ============================================================
// vClaw — QA Canary Provisioner
// Registers Azure Microsoft.Storage provider, provisions
// Azure (eastus / Standard_B1s) and AWS (us-east-2 / t3.nano)
// canary VMs for SHEA-45 QA matrix testing.
// ============================================================

import "dotenv/config";
import { ClientSecretCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { NetworkManagementClient } from "@azure/arm-network";
import { ResourceManagementClient } from "@azure/arm-resources";
import {
  EC2Client,
  RunInstancesCommand,
  CreateTagsCommand,
  DescribeImagesCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupEgressCommand,
  DescribeVpcsCommand,
} from "@aws-sdk/client-ec2";

const AZURE_SUBSCRIPTION = "23e4afd3-0c4d-4b76-b460-e43f196052fd";
const AZURE_RG = "vclaw-qa";
const AZURE_LOCATION = "eastus";
const AZURE_VM_NAME = "vclaw-qa-canary";
const AZURE_VM_SIZE = "Standard_B1s";

const AWS_REGION = "us-east-2";
const AWS_INSTANCE_TYPE = "t3.nano";
const AWS_INSTANCE_NAME = "vclaw-qa-canary";

// ── Azure helpers ────────────────────────────────────────────

async function registerProvider(
  resources: ResourceManagementClient,
  ns: string,
): Promise<void> {
  const current = await resources.providers.get(ns);
  if (current.registrationState === "Registered") {
    console.log(`  ✓ ${ns} already registered`);
    return;
  }
  console.log(`  Registering ${ns}...`);
  await resources.providers.register(ns);
  let state = "Registering";
  let attempts = 0;
  while (state !== "Registered" && attempts < 36) {
    await sleep(5000);
    const provider = await resources.providers.get(ns);
    state = provider.registrationState ?? state;
    attempts++;
  }
  if (state !== "Registered") {
    throw new Error(`${ns} registration timed out (state: ${state})`);
  }
  console.log(`  ✓ ${ns} registered`);
}

async function registerAzureProviders(
  resources: ResourceManagementClient,
): Promise<void> {
  console.log("Registering required Azure resource providers...");
  for (const ns of [
    "Microsoft.Storage",
    "Microsoft.Network",
    "Microsoft.Compute",
  ]) {
    await registerProvider(resources, ns);
  }
  console.log();
}

async function provisionAzureCanary(
  compute: ComputeManagementClient,
  network: NetworkManagementClient,
  resources: ResourceManagementClient,
): Promise<string> {
  console.log(`Ensuring resource group: ${AZURE_RG} (${AZURE_LOCATION})...`);
  await resources.resourceGroups.createOrUpdate(AZURE_RG, {
    location: AZURE_LOCATION,
    tags: { purpose: "vclaw-qa" },
  });
  console.log("  ✓ Resource group ready\n");

  // VNet + subnet
  const vnetName = `${AZURE_RG}-vnet`;
  const subnetName = "default";
  console.log(`Ensuring VNet: ${vnetName}...`);
  const vnetPoller = await network.virtualNetworks.beginCreateOrUpdate(AZURE_RG, vnetName, {
    location: AZURE_LOCATION,
    addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
    subnets: [{ name: subnetName, addressPrefix: "10.0.0.0/24" }],
    tags: { purpose: "vclaw-qa" },
  });
  const vnet = await vnetPoller.pollUntilDone();
  const subnet = vnet.subnets?.[0];
  if (!subnet?.id) throw new Error("Failed to create subnet");
  console.log("  ✓ VNet + subnet ready\n");

  // NIC
  const nicName = `${AZURE_VM_NAME}-nic`;
  console.log(`Creating NIC: ${nicName}...`);
  const nicPoller = await network.networkInterfaces.beginCreateOrUpdate(AZURE_RG, nicName, {
    location: AZURE_LOCATION,
    ipConfigurations: [
      {
        name: "ipconfig1",
        subnet: { id: subnet.id },
        privateIPAllocationMethod: "Dynamic",
      },
    ],
    tags: { purpose: "vclaw-qa" },
  });
  const nic = await nicPoller.pollUntilDone();
  if (!nic.id) throw new Error("Failed to create NIC");
  console.log("  ✓ NIC ready\n");

  // VM — Ubuntu 22.04 LTS, password auth, no public IP (QA only)
  const adminPassword = `VclawQA!${Math.random().toString(36).slice(2, 10)}`;
  // Try sizes in order: some may be capacity-constrained in eastus
  const sizesToTry = ["Standard_B1s", "Standard_B1ms", "Standard_B2s", "Standard_D2s_v3"];
  let vm: any = null;
  let usedSize = AZURE_VM_SIZE;
  for (const size of sizesToTry) {
    try {
      console.log(`Creating VM: ${AZURE_VM_NAME} (${size})...`);
      usedSize = size;
      const vmPoller = await compute.virtualMachines.beginCreateOrUpdate(
        AZURE_RG,
        AZURE_VM_NAME,
        {
          location: AZURE_LOCATION,
          hardwareProfile: { vmSize: size },
          storageProfile: {
            imageReference: {
              publisher: "Canonical",
              offer: "0001-com-ubuntu-server-jammy",
              sku: "22_04-lts-gen2",
              version: "latest",
            },
            osDisk: {
              createOption: "FromImage",
              diskSizeGB: 30,
              managedDisk: { storageAccountType: "Standard_LRS" },
              deleteOption: "Delete",
            },
          },
          osProfile: {
            computerName: AZURE_VM_NAME,
            adminUsername: "vclaw",
            adminPassword,
          },
          networkProfile: {
            networkInterfaces: [{ id: nic.id, primary: true, deleteOption: "Delete" }],
          },
          tags: { purpose: "vclaw-qa" },
        },
      );
      vm = await vmPoller.pollUntilDone();
      break;
    } catch (err: any) {
      if (err.message?.includes("not available") || err.code === "SkuNotAvailable") {
        console.log(`  ↳ ${size} unavailable, trying next...`);
        continue;
      }
      throw err;
    }
  }
  if (!vm) throw new Error("All VM sizes exhausted — none available in eastus");

  const vmId = vm.id ?? "";
  console.log(`  ✓ Azure VM created: ${vm.name} (${usedSize}) → ${vmId}\n`);
  return vmId;
}

// ── AWS helpers ──────────────────────────────────────────────

async function provisionAWSCanary(ec2: EC2Client): Promise<string> {
  // Find latest Amazon Linux 2023 AMI (free tier, minimal)
  console.log("Finding latest Amazon Linux 2023 AMI in us-east-2...");
  const amiResp = await ec2.send(
    new DescribeImagesCommand({
      Owners: ["amazon"],
      Filters: [
        { Name: "name", Values: ["al2023-ami-2023.*-kernel-*-x86_64"] },
        { Name: "state", Values: ["available"] },
        { Name: "architecture", Values: ["x86_64"] },
      ],
    }),
  );
  const amis = (amiResp.Images ?? []).sort((a, b) =>
    (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""),
  );
  if (amis.length === 0) throw new Error("No Amazon Linux 2023 AMI found in us-east-2");
  const amiId = amis[0].ImageId!;
  console.log(`  ✓ AMI: ${amiId} (${amis[0].Name})\n`);

  // Find default VPC
  console.log("Finding default VPC...");
  const vpcResp = await ec2.send(
    new DescribeVpcsCommand({ Filters: [{ Name: "isDefault", Values: ["true"] }] }),
  );
  const defaultVpc = vpcResp.Vpcs?.[0];
  if (!defaultVpc?.VpcId) throw new Error("No default VPC found in us-east-2");
  console.log(`  ✓ Default VPC: ${defaultVpc.VpcId}\n`);

  // Find a subnet in the default VPC
  console.log("Finding subnet...");
  const subnetResp = await ec2.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: "vpc-id", Values: [defaultVpc.VpcId] }],
    }),
  );
  const subnet = subnetResp.Subnets?.[0];
  if (!subnet?.SubnetId) throw new Error("No subnet found in default VPC");
  console.log(`  ✓ Subnet: ${subnet.SubnetId}\n`);

  // Create a minimal security group (no inbound, outbound only)
  const sgName = "vclaw-qa-canary-sg";
  let sgId: string;
  console.log(`Creating security group: ${sgName}...`);
  try {
    const sgResp = await ec2.send(
      new CreateSecurityGroupCommand({
        GroupName: sgName,
        Description: "vclaw QA canary - no inbound",
        VpcId: defaultVpc.VpcId,
      }),
    );
    sgId = sgResp.GroupId!;
    await ec2.send(
      new CreateTagsCommand({
        Resources: [sgId],
        Tags: [
          { Key: "Name", Value: sgName },
          { Key: "purpose", Value: "vclaw-qa" },
        ],
      }),
    );
    console.log(`  ✓ Security group: ${sgId}\n`);
  } catch (err: any) {
    if (err.Code === "InvalidGroup.Duplicate") {
      const existing = await ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: "group-name", Values: [sgName] },
            { Name: "vpc-id", Values: [defaultVpc.VpcId!] },
          ],
        }),
      );
      sgId = existing.SecurityGroups?.[0]?.GroupId ?? "";
      console.log(`  ✓ Reusing existing SG: ${sgId}\n`);
    } else {
      throw err;
    }
  }

  // Launch the t3.nano
  console.log(`Launching t3.nano: ${AWS_INSTANCE_NAME}...`);
  const runResp = await ec2.send(
    new RunInstancesCommand({
      ImageId: amiId,
      InstanceType: "t3.nano",
      MinCount: 1,
      MaxCount: 1,
      SubnetId: subnet.SubnetId,
      SecurityGroupIds: [sgId],
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: AWS_INSTANCE_NAME },
            { Key: "purpose", Value: "vclaw-qa" },
          ],
        },
      ],
    }),
  );
  const inst = runResp.Instances?.[0];
  if (!inst?.InstanceId) throw new Error("No instance returned by RunInstances");
  console.log(`  ✓ AWS instance launched: ${inst.InstanceId}\n`);
  return inst.InstanceId;
}

// ── Entry point ──────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const {
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
  } = process.env;

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error("Missing AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET");
  }
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error("Missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY");
  }

  // ── Azure clients ──────────────────────────────────────────
  const credential = new ClientSecretCredential(
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
  );
  const compute = new ComputeManagementClient(credential, AZURE_SUBSCRIPTION);
  const network = new NetworkManagementClient(credential, AZURE_SUBSCRIPTION);
  const resources = new ResourceManagementClient(credential, AZURE_SUBSCRIPTION);

  // ── AWS client ─────────────────────────────────────────────
  const ec2 = new EC2Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
  });

  // Step 1 — Register required Azure providers
  await registerAzureProviders(resources);

  // Step 2 — Provision Azure canary
  const azureVmId = await provisionAzureCanary(compute, network, resources);

  // Step 3 — Provision AWS canary
  const awsInstanceId = await provisionAWSCanary(ec2);

  // Summary
  console.log("=".repeat(60));
  console.log("QA CANARY SUMMARY");
  console.log("=".repeat(60));
  console.log(`Azure VM ID  : ${azureVmId}`);
  console.log(`Azure VM name: ${AZURE_VM_NAME}`);
  console.log(`Azure RG     : ${AZURE_RG} (${AZURE_LOCATION})`);
  console.log(`AWS instance : ${awsInstanceId}`);
  console.log(`AWS region   : ${AWS_REGION}`);
  console.log("=".repeat(60));

  return { azureVmId, azureVmName: AZURE_VM_NAME, awsInstanceId };
}

main().catch((err) => {
  console.error("✗ Provisioning failed:", err.message ?? err);
  process.exit(1);
});
