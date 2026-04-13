// ============================================================
// vClaw — VMware vSphere 8.0 REST API Types
// Typed interfaces matching the vSphere Automation REST API
// ============================================================

// ── VM Types ────────────────────────────────────────────────

export type VmPowerState = "POWERED_ON" | "POWERED_OFF" | "SUSPENDED";

export interface VmSummary {
  vm: string;
  name: string;
  power_state: VmPowerState;
  cpu_count?: number;
  memory_size_MiB?: number;
}

export interface VmHardware {
  upgrade_policy: string;
  upgrade_status: string;
  version: string;
}

export interface VmInfo {
  name: string;
  power_state: VmPowerState;
  cpu: {
    count: number;
    cores_per_socket: number;
    hot_add_enabled: boolean;
    hot_remove_enabled: boolean;
  };
  memory: {
    size_MiB: number;
    hot_add_enabled: boolean;
  };
  hardware: VmHardware;
  guest_OS: GuestOS;
  disks: Record<string, VmDiskInfo>;
  nics: Record<string, VmNicInfo>;
  boot: {
    type: string;
    delay?: number;
    enter_setup_mode?: boolean;
  };
  boot_devices?: { type: string }[];
  cdroms?: Record<string, VmCdromInfo>;
}

export interface VmDiskInfo {
  label: string;
  type: string;
  capacity?: number;
  backing: {
    type: string;
    vmdk_file?: string;
  };
}

export interface VmNicInfo {
  label: string;
  type: string;
  mac_address: string;
  mac_type: string;
  state: string;
  backing: {
    type: string;
    network?: string;
    network_name?: string;
  };
  start_connected: boolean;
}

export interface VmCdromInfo {
  label: string;
  type: string;
  allow_guest_control: boolean;
  backing: {
    type: string;
    iso_file?: string;
  };
  state: string;
  start_connected: boolean;
}

// ── Host Types ──────────────────────────────────────────────

export type HostConnectionState = "CONNECTED" | "DISCONNECTED" | "NOT_RESPONDING";

export type HostPowerState = "POWERED_ON" | "POWERED_OFF" | "STANDBY";

export interface HostSummary {
  host: string;
  name: string;
  connection_state: HostConnectionState;
  power_state?: HostPowerState;
}

export interface HostInfo {
  name: string;
  connection_state: HostConnectionState;
  power_state: HostPowerState;
  cpu?: {
    num_cpu_packages?: number;
    num_cpu_cores?: number;
    num_cpu_threads?: number;
    cpu_mhz?: number;
    overall_cpu_usage?: number;
  };
  memory?: {
    total_memory?: number;
    memory_usage?: number;
  };
}

// ── Datastore Types ─────────────────────────────────────────

export type DatastoreType = "VMFS" | "NFS" | "NFS41" | "CIFS" | "VSAN" | "VFFS" | "VVOL";

export interface DatastoreSummary {
  datastore: string;
  name: string;
  type: DatastoreType;
  free_space?: number;
  capacity?: number;
}

export interface DatastoreInfo {
  name: string;
  type: DatastoreType;
  accessible: boolean;
  free_space: number;
  capacity: number;
  thin_provisioning_supported: boolean;
}

// ── Network Types ───────────────────────────────────────────

export type NetworkType =
  | "STANDARD_PORTGROUP"
  | "DISTRIBUTED_PORTGROUP"
  | "OPAQUE_NETWORK"
  | "NSX_NETWORK";

export interface NetworkSummary {
  network: string;
  name: string;
  type: NetworkType;
}

// ── Cluster Types ───────────────────────────────────────────

export interface ClusterSummary {
  cluster: string;
  name: string;
  ha_enabled: boolean;
  drs_enabled: boolean;
}

export interface ClusterInfo {
  name: string;
  resource_pool: string;
}

// ── Resource Pool Types ─────────────────────────────────────

export interface ResourcePoolSummary {
  resource_pool: string;
  name: string;
}

// ── Snapshot Types ──────────────────────────────────────────

export interface SnapshotSummary {
  snapshot: string;
  name: string;
  description: string;
  create_time?: string;
  power_state?: VmPowerState;
  parent?: string;
}

export interface SnapshotInfo {
  snapshots: SnapshotSummary[];
}

// ── Guest Types ─────────────────────────────────────────────

export type GuestOS =
  | "WINDOWS_9"
  | "WINDOWS_9_64"
  | "WINDOWS_9_SERVER_64"
  | "WINDOWS_11_64"
  | "RHEL_8_64"
  | "RHEL_9_64"
  | "UBUNTU_64"
  | "CENTOS_8_64"
  | "OTHER_LINUX_64"
  | "OTHER_64"
  | string;

export interface GuestInfo {
  os_family?: string;
  full_name?: string;
  host_name?: string;
  ip_address?: string;
  name?: GuestOS;
  dns_values?: {
    domain_name?: string;
    search_domains?: string[];
  };
  dns?: {
    ip_addresses?: string[];
  };
}

// ── Folder Types ───────────────────────────────────────────

export type FolderType = "VIRTUAL_MACHINE" | "DATACENTER" | "DATASTORE" | "HOST" | "NETWORK";

export interface FolderSummary {
  folder: string;
  name: string;
  type: FolderType;
}

// ── VM Create Spec ──────────────────────────────────────────

export interface VmCreateSpec {
  name: string;
  guest_OS: GuestOS;
  placement?: {
    folder?: string;
    resource_pool?: string;
    host?: string;
    cluster?: string;
    datastore?: string;
  };
  cpu?: {
    count?: number;
    cores_per_socket?: number;
    hot_add_enabled?: boolean;
    hot_remove_enabled?: boolean;
  };
  memory?: {
    size_MiB?: number;
    hot_add_enabled?: boolean;
  };
  disks?: {
    type?: string;
    new_vmdk?: {
      capacity?: number;
      name?: string;
    };
    backing?: {
      type: string;
    };
  }[];
  nics?: {
    type?: string;
    backing?: {
      type: string;
      network?: string;
    };
    start_connected?: boolean;
    allow_guest_control?: boolean;
  }[];
  boot?: {
    type?: string;
    delay?: number;
    enter_setup_mode?: boolean;
  };
  boot_devices?: {
    type: string;
  }[];
}
