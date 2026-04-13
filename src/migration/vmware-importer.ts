// ============================================================
// vClaw — VMware VM Importer
// Creates a VM on vSphere and uploads a vmdk to the ESXi datastore
// ============================================================

import type { VSphereClient } from "../providers/vmware/client.js";
import type { MigrationVMConfig, SSHExecFn } from "./types.js";

export interface VMwareImportOptions {
  config: MigrationVMConfig;
  vmdkPath: string; // path to vmdk on Proxmox (or staging host)
  esxiHost: string;
  esxiUser?: string;
  datastoreId: string;
  datastoreName: string;
  hostId: string;
  folderId: string;
  networkId?: string;
}

export interface VMwareImportResult {
  vmId: string;
  hostId: string;
  datastoreName: string;
}

export class VMwareImporter {
  private readonly client: VSphereClient;
  private readonly sshExec: SSHExecFn;

  constructor(client: VSphereClient, sshExec: SSHExecFn) {
    this.client = client;
    this.sshExec = sshExec;
  }

  /**
   * Import a VM into VMware vSphere from a vmdk disk image.
   * 1. Upload vmdk to ESXi datastore via SCP
   * 2. Create VM on vSphere with matching config
   *
   * Note: vSphere REST API createVM auto-creates a blank disk.
   * We create the VM without disks, upload our vmdk, then register it.
   */
  async importVM(
    opts: VMwareImportOptions,
    proxmoxHost: string,
    proxmoxUser = "root"
  ): Promise<VMwareImportResult> {
    const esxiUser = opts.esxiUser ?? "root";
    const vmName = opts.config.name;

    // 1. Create VM via vSphere REST API (empty disks array to prevent default)
    //    This lets vSphere create the VM directory on the datastore
    const vmId = await this.client.createVM({
      name: vmName,
      guest_OS: opts.config.guestOS,
      placement: {
        folder: opts.folderId,
        host: opts.hostId,
        datastore: opts.datastoreId,
      },
      cpu: {
        count: opts.config.cpuCount,
        cores_per_socket: opts.config.coresPerSocket,
      },
      memory: {
        size_MiB: opts.config.memoryMiB,
      },
      boot: {
        type: opts.config.firmware === "efi" ? "EFI" : "BIOS",
      },
      disks: [],
      nics: opts.networkId
        ? [
            {
              type: "VMXNET3",
              backing: {
                type: "STANDARD_PORTGROUP",
                network: opts.networkId,
              },
              start_connected: true,
            },
          ]
        : undefined,
    });

    // 2. Find the actual VM directory on ESXi (vSphere may suffix _1, _2, etc.)
    const findCmd = `find /vmfs/volumes/${opts.datastoreName}/ -maxdepth 1 -name '${vmName}*' -type d | sort | tail -1`;
    const innerFind = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${esxiUser}@${opts.esxiHost} ${JSON.stringify(findCmd)}`;
    const findResult = await this.sshExec(proxmoxHost, proxmoxUser, innerFind, 15_000);
    const vmDir = findResult.stdout.trim() || `/vmfs/volumes/${opts.datastoreName}/${vmName}`;

    // Extract the actual directory name for datastore bracket path
    const vmDirName = vmDir.split("/").pop()!;

    // 3. Transfer vmdk from Proxmox to ESXi VM directory
    const targetVmdk = `${vmDir}/${vmName}-upload.vmdk`;
    await this.transferVmdk(
      proxmoxHost,
      proxmoxUser,
      opts.vmdkPath,
      opts.esxiHost,
      esxiUser,
      targetVmdk,
      600_000
    );

    // 4. Convert the streamOptimized vmdk to a flat vmdk using vmkfstools
    const flatVmdk = `${vmDir}/${vmName}-imported.vmdk`;
    await this.sshExecOnESXi(
      opts.esxiHost,
      esxiUser,
      proxmoxHost,
      proxmoxUser,
      `vmkfstools -i ${JSON.stringify(targetVmdk)} -d thin ${JSON.stringify(flatVmdk)}`,
      600_000
    );

    // 5. Remove the uploaded streamOptimized vmdk
    await this.sshExecOnESXi(
      opts.esxiHost,
      esxiUser,
      proxmoxHost,
      proxmoxUser,
      `rm -f ${JSON.stringify(targetVmdk)}`
    );

    // 6. Add the converted disk to the VM using vim-cmd
    //    Use filesystem path (not datastore bracket notation) to avoid quoting issues through SSH
    await this.addExistingDisk(vmId, flatVmdk, vmName, opts.esxiHost, esxiUser, proxmoxHost, proxmoxUser);

    return {
      vmId,
      hostId: opts.hostId,
      datastoreName: opts.datastoreName,
    };
  }

  /**
   * Get the default VM folder, ESXi host, and datastore for import.
   */
  async resolveDefaults(): Promise<{ folderId: string; hostId: string; datastoreId: string; datastoreName: string; networkId: string }> {
    const [folders, hosts, datastores, networks] = await Promise.all([
      this.client.listFolders("VIRTUAL_MACHINE"),
      this.client.listHosts(),
      this.client.listDatastores(),
      this.client.listNetworks(),
    ]);

    const folder = folders.find((f) => f.name === "vm") ?? folders[0];
    if (!folder) throw new Error("No VM folder found in vSphere");

    const host = hosts.find((h) => h.connection_state === "CONNECTED");
    if (!host) throw new Error("No connected ESXi host found");

    // Pick the datastore with the most free space, preferring simple names
    // (avoid names with spaces/parens which cause ESXi path issues)
    const ds = datastores
      .filter((d) => d.free_space !== undefined)
      .sort((a, b) => {
        // Prefer names without special characters
        const aSimple = /^[a-zA-Z0-9_-]+$/.test(a.name) ? 1 : 0;
        const bSimple = /^[a-zA-Z0-9_-]+$/.test(b.name) ? 1 : 0;
        if (aSimple !== bSimple) return bSimple - aSimple;
        return (b.free_space ?? 0) - (a.free_space ?? 0);
      })[0];
    if (!ds) throw new Error("No datastore found");

    const network = networks[0];
    if (!network) throw new Error("No network found");

    return {
      folderId: folder.folder,
      hostId: host.host,
      datastoreId: ds.datastore,
      datastoreName: ds.name,
      networkId: network.network,
    };
  }

  /**
   * SCP vmdk from Proxmox to ESXi datastore.
   * Runs SCP on Proxmox, pushing to ESXi.
   */
  private async transferVmdk(
    proxmoxHost: string,
    proxmoxUser: string,
    vmdkPath: string,
    esxiHost: string,
    esxiUser: string,
    targetPath: string,
    timeoutMs = 600_000
  ): Promise<void> {
    const cmd = [
      "scp",
      "-o StrictHostKeyChecking=no",
      "-o UserKnownHostsFile=/dev/null",
      JSON.stringify(vmdkPath),
      `${esxiUser}@${esxiHost}:${JSON.stringify(targetPath)}`,
    ].join(" ");

    const result = await this.sshExec(proxmoxHost, proxmoxUser, cmd, timeoutMs);

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to transfer vmdk to ESXi: ${result.stderr || result.stdout}`
      );
    }
  }

  /**
   * Add an existing vmdk as a SCSI disk to a VM via the ESXi command line.
   * The vSphere REST API's disk create endpoint doesn't support existing vmdks well,
   * so we use vim-cmd on ESXi to add the disk directly to the VMX file.
   */
  private async addExistingDisk(
    vmId: string,
    datastorePath: string,
    vmName: string,
    esxiHost: string,
    esxiUser: string,
    proxmoxHost: string,
    proxmoxUser: string
  ): Promise<void> {
    // vim-cmd uses ESXi-internal VMIDs, not vSphere's vm-XX IDs.
    // Look up the ESXi VMID by VM name.
    const listCmd = `vim-cmd vmsvc/getallvms 2>/dev/null`;
    const innerList = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${esxiUser}@${esxiHost} ${JSON.stringify(listCmd)}`;
    const listResult = await this.sshExec(proxmoxHost, proxmoxUser, innerList, 15_000);

    // Parse: "18     Migration-TestVM   [datastore1] ..."
    const lines = listResult.stdout.split("\n").filter((l) => l.trim());
    const vmLine = lines.find((l) => {
      const parts = l.trim().split(/\s{2,}/);
      return parts[1]?.trim() === vmName;
    });

    if (!vmLine) {
      throw new Error(`Could not find ESXi VMID for VM "${vmName}" (vSphere: ${vmId})`);
    }

    const esxiVmId = vmLine.trim().split(/\s+/)[0];
    // controller 0, unit 0 = first SCSI disk
    const cmd = `vim-cmd vmsvc/device.diskaddexisting ${esxiVmId} ${datastorePath} 0 0`;
    await this.sshExecOnESXi(esxiHost, esxiUser, proxmoxHost, proxmoxUser, cmd);
  }

  /**
   * Execute a command on ESXi via Proxmox as a jump host.
   * Since ESXi may not be directly reachable, we SSH to Proxmox
   * which then SSHes to ESXi.
   */
  private async sshExecOnESXi(
    esxiHost: string,
    esxiUser: string,
    proxmoxHost: string,
    proxmoxUser: string,
    command: string,
    timeoutMs = 30_000
  ): Promise<void> {
    const innerCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${esxiUser}@${esxiHost} ${JSON.stringify(command)}`;
    const result = await this.sshExec(proxmoxHost, proxmoxUser, innerCmd, timeoutMs);

    if (result.exitCode !== 0) {
      throw new Error(
        `ESXi command failed on ${esxiHost}: ${result.stderr || result.stdout}`
      );
    }
  }

  /**
   * Convert a vSphere datastore path to ESXi filesystem path.
   * If the path is already absolute, just return it.
   */
  private datastorePathToFs(datastorePath: string, datastoreName: string): string {
    const match = datastorePath.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (match) {
      return `/vmfs/volumes/${match[1]}/${match[2]}`;
    }
    // If it's already an absolute path, return as-is
    if (datastorePath.startsWith("/")) return datastorePath;
    // Fallback
    return `/vmfs/volumes/${datastoreName}/${datastorePath}`;
  }
}
