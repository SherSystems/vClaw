// ============================================================
// vClaw — Migration Module
// Cross-provider VM migration (Phase 1: VMware -> Proxmox)
// ============================================================

export { MigrationOrchestrator } from "./orchestrator.js";
export type { MigrationConfig } from "./orchestrator.js";

export { VMwareExporter } from "./vmware-exporter.js";
export type { VMwareExportResult } from "./vmware-exporter.js";

export { VMwareImporter } from "./vmware-importer.js";
export type { VMwareImportOptions, VMwareImportResult } from "./vmware-importer.js";

export { ProxmoxExporter } from "./proxmox-exporter.js";
export type { ProxmoxExportResult } from "./proxmox-exporter.js";

export { ProxmoxImporter } from "./proxmox-importer.js";
export type { ProxmoxImportOptions, ProxmoxImportResult } from "./proxmox-importer.js";

export { DiskConverter } from "./disk-converter.js";
export type { DiskConvertOptions } from "./disk-converter.js";

export type {
  MigrationPlan,
  MigrationStatus,
  MigrationStep,
  MigrationVMConfig,
  MigrationDisk,
  MigrationNic,
  MigrationProgress,
  DiskFormat,
  SSHExecFn,
  SSHExecResult,
} from "./types.js";
