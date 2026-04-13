// ============================================================
// vClaw — Proxmox VM Exporter
// Reads VM configuration and extracts disks from Proxmox storage
// for cross-provider migration
// ============================================================

import type { ProxmoxClient, ProxmoxVMConfig } from "../providers/proxmox/client.js";
import type { MigrationVMConfig, MigrationDisk, MigrationNic, SSHExecFn } from "./types.js";

export interface ProxmoxExportResult {
  vmConfig: MigrationVMConfig;
  node: string;
  diskDevicePaths: string[]; // e.g. ["/dev/pve/vm-112-disk-0"]
}

export class ProxmoxExporter {
  private readonly client: ProxmoxClient;
  private readonly sshExec: SSHExecFn;

  constructor(client: ProxmoxClient, sshExec: SSHExecFn) {
    this.client = client;
    this.sshExec = sshExec;
  }

  /**
   * Export a VM's configuration and disk locations from Proxmox.
   * Does NOT power off the VM — caller is responsible for that.
   */
  async exportVM(node: string, vmId: number, proxmoxHost: string, proxmoxUser = "root"): Promise<ProxmoxExportResult> {
    // 1. Get VM config from Proxmox API
    const config = await this.client.getVMConfig(node, vmId);

    // 2. Extract disk info — resolve LVM/directory paths
    const disks = await this.extractDisks(config, vmId, proxmoxHost, proxmoxUser);

    // 3. Extract NIC info
    const nics = this.extractNics(config);

    // 4. Determine firmware type
    const firmware = config.bios === "ovmf" ? "efi" as const : "bios" as const;

    // 5. Map Proxmox ostype to VMware guest OS
    const guestOS = this.mapOSType(config.ostype ?? "other");

    const vmConfig: MigrationVMConfig = {
      name: config.name ?? `proxmox-vm-${vmId}`,
      cpuCount: (config.cores ?? 1) * (config.sockets ?? 1),
      coresPerSocket: config.cores ?? 1,
      memoryMiB: config.memory ?? 1024,
      guestOS,
      disks,
      nics,
      firmware,
    };

    const diskDevicePaths = disks.map((d) => d.sourcePath);

    return { vmConfig, node, diskDevicePaths };
  }

  /**
   * Extract disk information from Proxmox VM config.
   * Resolves storage paths to device/file paths on the host.
   */
  private async extractDisks(
    config: ProxmoxVMConfig,
    vmId: number,
    proxmoxHost: string,
    proxmoxUser: string
  ): Promise<MigrationDisk[]> {
    const disks: MigrationDisk[] = [];

    // Scan all possible disk keys: scsi0-31, sata0-5, ide0-3, virtio0-15
    const diskPrefixes = ["scsi", "sata", "ide", "virtio"];
    for (const prefix of diskPrefixes) {
      for (let i = 0; i < 32; i++) {
        const key = `${prefix}${i}`;
        const value = config[key] as string | undefined;
        if (!value || typeof value !== "string") continue;

        // Skip CD-ROM / cloud-init / unused
        if (value.includes("media=cdrom") || value.includes("cloudinit")) continue;

        // Parse storage:volume,options format
        // e.g. "local-lvm:vm-112-disk-0,size=1G"
        const match = value.match(/^([^:]+):([^,]+)/);
        if (!match) continue;

        const [, storage, volume] = match;

        // Extract size from the config string
        const sizeMatch = value.match(/size=(\d+)([GMTK]?)/);
        let capacityBytes = 0;
        if (sizeMatch) {
          const size = parseInt(sizeMatch[1], 10);
          const unit = sizeMatch[2] || "G";
          const multipliers: Record<string, number> = { K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 };
          capacityBytes = size * (multipliers[unit] ?? 1073741824);
        }

        // Resolve the device path on the host
        const devicePath = await this.resolveDevicePath(storage, volume, vmId, proxmoxHost, proxmoxUser);

        disks.push({
          label: `${key} (${storage}:${volume})`,
          capacityBytes,
          sourcePath: devicePath,
          sourceFormat: storage.includes("lvm") ? "raw" : "qcow2",
          targetFormat: "vmdk",
        });
      }
    }

    return disks;
  }

  /**
   * Resolve a Proxmox storage:volume to a device/file path on the host.
   */
  private async resolveDevicePath(
    storage: string,
    volume: string,
    _vmId: number,
    proxmoxHost: string,
    proxmoxUser: string
  ): Promise<string> {
    // For LVM-based storage: /dev/{vg-name}/{volume}
    // Common VG names: pve (default), ceph, etc.
    if (storage.includes("lvm") || storage === "local-lvm") {
      // Try to find the LV path
      const result = await this.sshExec(
        proxmoxHost,
        proxmoxUser,
        `lvs --noheadings -o lv_path --select lv_name=${volume} 2>/dev/null || echo "/dev/pve/${volume}"`,
        10_000
      );
      return result.stdout.trim() || `/dev/pve/${volume}`;
    }

    // For directory-based storage: /var/lib/vz/images/{vmid}/{volume}
    // Try pvesm path to resolve
    const result = await this.sshExec(
      proxmoxHost,
      proxmoxUser,
      `pvesm path ${storage}:${volume} 2>/dev/null`,
      10_000
    );

    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }

    // Fallback: assume directory storage
    return `/var/lib/vz/images/${volume}`;
  }

  /**
   * Extract NIC information from Proxmox VM config.
   */
  private extractNics(config: ProxmoxVMConfig): MigrationNic[] {
    const nics: MigrationNic[] = [];

    for (let i = 0; i < 8; i++) {
      const key = `net${i}`;
      const value = config[key] as string | undefined;
      if (!value || typeof value !== "string") continue;

      // Parse: "virtio=BC:24:11:F7:A4:00,bridge=vmbr0"
      const typeMatch = value.match(/^(\w+)=([0-9A-Fa-f:]+)/);
      const bridgeMatch = value.match(/bridge=(\w+)/);

      nics.push({
        label: key,
        macAddress: typeMatch?.[2] ?? "00:00:00:00:00:00",
        networkName: bridgeMatch?.[1] ?? "vmbr0",
        adapterType: typeMatch?.[1] ?? "virtio",
      });
    }

    return nics;
  }

  /**
   * Convert a Proxmox disk (LVM raw or qcow2) to vmdk format.
   * Runs on the Proxmox host.
   */
  async convertDiskToVmdk(
    proxmoxHost: string,
    proxmoxUser: string,
    sourcePath: string,
    targetPath: string,
    sourceFormat: string,
    timeoutMs = 600_000
  ): Promise<void> {
    const cmd = [
      "qemu-img", "convert",
      "-f", sourceFormat,
      "-O", "vmdk",
      "-o", "subformat=streamOptimized",
      JSON.stringify(sourcePath),
      JSON.stringify(targetPath),
    ].join(" ");

    const result = await this.sshExec(proxmoxHost, proxmoxUser, cmd, timeoutMs);

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to convert disk to vmdk: ${result.stderr || result.stdout}`
      );
    }
  }

  /**
   * Map Proxmox ostype to VMware guest OS identifier.
   */
  private mapOSType(ostype: string): string {
    const map: Record<string, string> = {
      l26: "OTHER_LINUX_64",
      l24: "OTHER_LINUX_64",
      win11: "WINDOWS_11_64",
      win10: "WINDOWS_9_64",
      win8: "WINDOWS_9_64",
      win7: "WINDOWS_9_64",
      wvista: "WINDOWS_9_64",
      wxp: "WINDOWS_9_64",
      w2k22: "WINDOWS_9_SERVER_64",
      w2k19: "WINDOWS_9_SERVER_64",
      w2k16: "WINDOWS_9_SERVER_64",
      w2k12: "WINDOWS_9_SERVER_64",
      solaris: "OTHER_64",
      other: "OTHER_64",
    };

    return map[ostype] ?? "OTHER_64";
  }
}
