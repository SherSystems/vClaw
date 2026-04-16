import 'dotenv/config';
import { VSphereClient } from '../src/providers/vmware/client.js';
import { AWSClient } from '../src/providers/aws/client.js';
import { WorkloadAnalyzer } from '../src/migration/workload-analyzer.js';

async function run() {
  // Connect to VMware
  const vsphere = new VSphereClient({
    host: process.env.VMWARE_HOST!,
    user: process.env.VMWARE_USER!,
    password: process.env.VMWARE_PASSWORD!,
    insecure: true,
  });
  await vsphere.createSession();

  // List VMware VMs
  const vms = await vsphere.listVMs();
  console.log('\n=== VMware VMs ===');
  for (const vm of vms) {
    console.log(`  ${vm.vm} | ${vm.name} | ${vm.power_state}`);
  }

  // Connect to AWS
  const aws = new AWSClient({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    region: process.env.AWS_REGION!,
  });
  await aws.connect();

  // List EC2 instances
  const instances = await aws.listInstances();
  console.log('\n=== AWS EC2 Instances ===');
  for (const inst of instances) {
    console.log(`  ${inst.instanceId} | ${inst.name} | ${inst.state} | ${inst.instanceType} | ${inst.publicIp || 'no public IP'}`);
  }

  // Analyze a VMware VM for AWS migration
  if (vms.length > 0) {
    const testVm = vms[0];
    console.log(`\n=== Workload Analysis: ${testVm.name} → AWS ===`);
    const vmInfo = await vsphere.getVM(testVm.vm);

    const vmConfig = {
      name: vmInfo.name,
      cpuCount: vmInfo.cpu.count,
      coresPerSocket: vmInfo.cpu.cores_per_socket,
      memoryMiB: vmInfo.memory.size_MiB,
      guestOS: vmInfo.guest_OS,
      disks: Object.values(vmInfo.disks ?? {}).map((d: any) => ({
        label: d.label || 'disk',
        capacityBytes: d.capacity || 0,
        sourcePath: '',
        sourceFormat: 'vmdk' as const,
        targetFormat: 'vmdk' as const,
      })),
      nics: Object.values(vmInfo.nics ?? {}).map((n: any) => ({
        label: n.label || 'nic',
        macAddress: n.mac_address || '',
        networkName: n.backing?.network_name || '',
        adapterType: n.type || 'vmxnet3',
      })),
      firmware: (vmInfo.boot?.type === 'EFI' ? 'efi' : 'bios') as 'efi' | 'bios',
    };

    const analysis = WorkloadAnalyzer.analyzeVMwareForAWS(vmConfig);
    console.log(`  Source: ${analysis.source.vmName} (${vmConfig.cpuCount} vCPU, ${vmConfig.memoryMiB} MiB RAM)`);
    console.log(`  Recommended EC2: ${analysis.target.recommended.instanceType}`);
    console.log(`  Estimated cost: $${analysis.costEstimate?.monthlyUSD?.toFixed(2)}/month`);
    console.log(`  Storage: ${analysis.storage.currentGB.toFixed(1)} GB → EBS ${analysis.storage.estimatedTargetGB.toFixed(1)} GB`);
    console.log(`  Migration time: ~${analysis.migrationTimeEstimateMinutes} minutes`);
    if (analysis.risks.length > 0) {
      console.log(`  Risks:`);
      for (const risk of analysis.risks) {
        console.log(`    - ${risk}`);
      }
    }
    if (analysis.target.alternatives.length > 0) {
      console.log(`  Alternatives:`);
      for (const alt of analysis.target.alternatives) {
        console.log(`    - ${alt.instanceType} ($${alt.estimatedMonthlyCost?.toFixed(2)}/mo)`);
      }
    }
  }

  console.log('\n✓ All integrations working!');
}

run().catch(e => console.error('ERROR:', e.message));
