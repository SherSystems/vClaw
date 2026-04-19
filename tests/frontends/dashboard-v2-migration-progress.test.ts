import { afterEach, describe, expect, it } from "vitest";
import { applySseEvent } from "../../dashboard-v2/src/hooks/useSSE";
import { useStore } from "../../dashboard-v2/src/store";
import type { MigrationDirection, MigrationPlan } from "../../dashboard-v2/src/types";

const initialStore = useStore.getState();

function resetStore() {
  useStore.setState({
    ...initialStore,
    events: [],
    toasts: [],
    migrationHistory: [],
    migrationRuns: {},
    migrationRunOrder: [],
    activeMigration: null,
  });
}

function makePlan(id: string, direction: MigrationDirection, vmId: string): MigrationPlan {
  return {
    id,
    direction,
    status: "pending",
    source: {
      provider: "proxmox",
      vmId,
      vmName: "vm-a",
      host: "source-host",
    },
    target: {
      provider: "aws",
      node: "us-east-1a",
      host: "ec2.amazonaws.com",
      storage: "gp3",
    },
    vmConfig: {
      name: "vm-a",
      cpuCount: 2,
      coresPerSocket: 1,
      memoryMiB: 2048,
      guestOS: "linux",
      firmware: "bios",
      disks: [{ label: "disk0", capacityBytes: 20 * 1024 * 1024 * 1024 }],
      nics: [{ label: "nic0" }],
    },
    steps: [{ name: "upload_to_s3", status: "pending" }],
    startedAt: "2026-04-19T02:00:00.000Z",
  };
}

describe("dashboard-v2 migration progress store", () => {
  afterEach(() => {
    resetStore();
  });

  it("tracks progress events and promotes local run to backend migration id", () => {
    const localRunId = useStore.getState().beginMigrationRun({
      direction: "proxmox_to_aws",
      vmId: "101",
      vmName: "api-1",
    });

    useStore.getState().applyMigrationEvent(
      "MigrationProgress",
      {
        direction: "proxmox_to_aws",
        vm_id: "101",
        stage: "upload_to_s3",
        progressPct: 12,
        message: "Uploading disk",
      },
      "2026-04-19T02:01:00.000Z",
    );

    const runBeforeRegister = useStore.getState().migrationRuns[localRunId];
    expect(runBeforeRegister).toBeDefined();
    expect(runBeforeRegister.progressPct).toBe(12);
    expect(runBeforeRegister.stage).toBe("upload_to_s3");
    expect(runBeforeRegister.etaSample?.progressPct).toBe(12);

    useStore.getState().registerMigrationRun(
      makePlan("mig-001", "proxmox_to_aws", "101"),
      {
        localRunId,
        direction: "proxmox_to_aws",
        vmId: "101",
        vmName: "api-1",
      },
    );

    const state = useStore.getState();
    expect(state.migrationRuns[localRunId]).toBeUndefined();
    expect(state.migrationRuns["mig-001"]).toBeDefined();
    expect(state.migrationRuns["mig-001"].progressPct).toBe(12);
    expect(state.migrationRunOrder[0]).toBe("mig-001");
  });

  it("captures completion resource identifiers from migration events", () => {
    useStore.getState().applyMigrationEvent(
      "migration_progress",
      {
        migrationId: "mig-002",
        stage: "convert",
        progressPct: 18,
      },
      "2026-04-19T02:10:00.000Z",
    );

    applySseEvent(
      {
        type: "MigrationCompleted",
        timestamp: "2026-04-19T02:20:00.000Z",
        data: {
          migrationId: "mig-002",
          amiId: "ami-1234567890",
          instanceId: "i-0123456789",
        },
      },
      useStore.getState(),
    );

    const run = useStore.getState().migrationRuns["mig-002"];
    expect(run.status).toBe("completed");
    expect(run.progressPct).toBe(100);
    expect(run.amiId).toBe("ami-1234567890");
    expect(run.instanceId).toBe("i-0123456789");
  });
});
