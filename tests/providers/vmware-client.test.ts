import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// Mock the https module before importing client
const mockRequest = vi.fn();
vi.mock("node:https", () => ({
  default: {
    request: (...args: unknown[]) => mockRequest(...args),
  },
}));

import { VSphereClient, type VSphereClientConfig } from "../../src/providers/vmware/client.js";

// ── Test Helpers ────────────────────────────────────────────

function createMockResponse(statusCode: number, body: unknown, statusMessage = "OK") {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const res = {
    statusCode,
    statusMessage,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
      return res;
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of listeners[event] ?? []) handler(...args);
    },
  };
  // Simulate async data+end
  setTimeout(() => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    res.emit("data", Buffer.from(data));
    res.emit("end");
  }, 0);
  return res;
}

function setupMockRequest(statusCode: number, body: unknown, statusMessage = "OK") {
  mockRequest.mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
    const res = createMockResponse(statusCode, body, statusMessage);
    callback(res);
    return {
      on: vi.fn(),
      setTimeout: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
  });
}

const defaultConfig: VSphereClientConfig = {
  host: "vcenter.lab.local",
  user: "administrator@vsphere.local",
  password: "VMware1!",
  insecure: true,
};

// ── Tests ────────────────────────────────────────────────────

describe("VSphereClient", () => {
  let client: VSphereClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new VSphereClient(defaultConfig);
  });

  // ── Session Management ──────────────────────────────────

  describe("createSession", () => {
    it("sends POST /api/session with Basic auth", async () => {
      setupMockRequest(200, { value: "session-token-abc123" });

      const token = await client.createSession();

      expect(token).toBe("session-token-abc123");
      expect(mockRequest).toHaveBeenCalledTimes(1);
      const opts = mockRequest.mock.calls[0][0];
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe("/api/session");
      const encoded = Buffer.from("administrator@vsphere.local:VMware1!").toString("base64");
      expect(opts.headers["Authorization"]).toBe(`Basic ${encoded}`);
    });

    it("stores the session token for subsequent requests", async () => {
      setupMockRequest(200, { value: "session-token-abc123" });
      await client.createSession();
      expect(client.isConnected()).toBe(true);
    });

    it("throws on auth failure", async () => {
      setupMockRequest(401, { value: { messages: [{ default_message: "Unauthorized" }] } }, "Unauthorized");
      await expect(client.createSession()).rejects.toThrow("vSphere API error: 401");
    });
  });

  describe("deleteSession", () => {
    it("sends DELETE /api/session and clears token", async () => {
      setupMockRequest(200, { value: "session-token-abc123" });
      await client.createSession();

      setupMockRequest(200, "");
      await client.deleteSession();
      expect(client.isConnected()).toBe(false);
    });

    it("does nothing if no session exists", async () => {
      await client.deleteSession();
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe("session caching", () => {
    it("uses cached session token for API calls", async () => {
      setupMockRequest(200, { value: "session-token-abc123" });
      await client.createSession();

      setupMockRequest(200, { value: [] });
      await client.listVMs();

      const listCallOpts = mockRequest.mock.calls[1][0];
      expect(listCallOpts.headers["vmware-api-session-id"]).toBe("session-token-abc123");
      expect(listCallOpts.headers["Authorization"]).toBeUndefined();
    });
  });

  describe("session refresh on 401", () => {
    it("refreshes session and retries on 401", async () => {
      // First: create session
      setupMockRequest(200, { value: "token-1" });
      await client.createSession();

      // Sequence: 401 -> new session -> retry succeeds
      let callCount = 0;
      mockRequest.mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
        callCount++;
        let statusCode: number;
        let body: unknown;

        if (callCount === 2) {
          // First listVMs call → 401
          statusCode = 401;
          body = { value: "session expired" };
        } else if (callCount === 3) {
          // createSession retry
          statusCode = 200;
          body = { value: "token-2" };
        } else {
          // listVMs retry succeeds
          statusCode = 200;
          body = { value: [{ vm: "vm-1", name: "test", power_state: "POWERED_ON" }] };
        }

        const res = createMockResponse(statusCode, body);
        callback(res);
        return {
          on: vi.fn(),
          setTimeout: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          destroy: vi.fn(),
        };
      });

      const vms = await client.listVMs();
      expect(vms).toHaveLength(1);
      expect(vms[0].name).toBe("test");
    });
  });

  // ── VM Operations ───────────────────────────────────────

  describe("listVMs", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns list of VMs", async () => {
      const mockVMs = [
        { vm: "vm-42", name: "web-01", power_state: "POWERED_ON", cpu_count: 4, memory_size_MiB: 8192 },
        { vm: "vm-43", name: "db-01", power_state: "POWERED_OFF", cpu_count: 8, memory_size_MiB: 16384 },
      ];
      setupMockRequest(200, { value: mockVMs });

      const result = await client.listVMs();
      expect(result).toHaveLength(2);
      expect(result[0].vm).toBe("vm-42");
      expect(result[1].power_state).toBe("POWERED_OFF");
    });

    it("supports filter parameters", async () => {
      setupMockRequest(200, { value: [] });
      await client.listVMs({ "filter.power_states": "POWERED_ON" });

      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toContain("filter.power_states=POWERED_ON");
    });

    it("sends GET /api/vcenter/vm", async () => {
      setupMockRequest(200, { value: [] });
      await client.listVMs();
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.method).toBe("GET");
      expect(opts.path).toBe("/api/vcenter/vm");
    });
  });

  describe("getVM", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns VM details", async () => {
      const mockVM = {
        name: "web-01",
        power_state: "POWERED_ON",
        cpu: { count: 4, cores_per_socket: 2, hot_add_enabled: true, hot_remove_enabled: false },
        memory: { size_MiB: 8192, hot_add_enabled: false },
        hardware: { upgrade_policy: "NEVER", upgrade_status: "NONE", version: "VMX_21" },
        guest_OS: "UBUNTU_64",
        disks: {},
        nics: {},
        boot: { type: "BIOS" },
      };
      setupMockRequest(200, { value: mockVM });

      const result = await client.getVM("vm-42");
      expect(result.name).toBe("web-01");
      expect(result.cpu.count).toBe(4);
    });

    it("sends GET /api/vcenter/vm/{vmId}", async () => {
      setupMockRequest(200, { value: { name: "test" } });
      await client.getVM("vm-42");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toBe("/api/vcenter/vm/vm-42");
    });
  });

  describe("power operations", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("vmPowerOn sends POST with action=start", async () => {
      setupMockRequest(200, "");
      await client.vmPowerOn("vm-42");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe("/api/vcenter/vm/vm-42/power?action=start");
    });

    it("vmPowerOff sends POST with action=stop", async () => {
      setupMockRequest(200, "");
      await client.vmPowerOff("vm-42");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe("/api/vcenter/vm/vm-42/power?action=stop");
    });

    it("vmReset sends POST with action=reset", async () => {
      setupMockRequest(200, "");
      await client.vmReset("vm-42");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toBe("/api/vcenter/vm/vm-42/power?action=reset");
    });

    it("vmSuspend sends POST with action=suspend", async () => {
      setupMockRequest(200, "");
      await client.vmSuspend("vm-42");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toBe("/api/vcenter/vm/vm-42/power?action=suspend");
    });
  });

  // ── Host Operations ─────────────────────────────────────

  describe("listHosts", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns list of hosts", async () => {
      const mockHosts = [
        { host: "host-10", name: "esxi-01.lab.local", connection_state: "CONNECTED", power_state: "POWERED_ON" },
      ];
      setupMockRequest(200, { value: mockHosts });
      const result = await client.listHosts();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("esxi-01.lab.local");
    });

    it("sends GET /api/vcenter/host", async () => {
      setupMockRequest(200, { value: [] });
      await client.listHosts();
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toBe("/api/vcenter/host");
    });
  });

  describe("getHost", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns host details", async () => {
      setupMockRequest(200, {
        value: { name: "esxi-01.lab.local", connection_state: "CONNECTED", power_state: "POWERED_ON" },
      });
      const result = await client.getHost("host-10");
      expect(result.name).toBe("esxi-01.lab.local");
    });
  });

  // ── Datastore Operations ────────────────────────────────

  describe("listDatastores", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns list of datastores", async () => {
      const mockDS = [
        { datastore: "datastore-15", name: "localDS", type: "VMFS", free_space: 500000000000, capacity: 1000000000000 },
      ];
      setupMockRequest(200, { value: mockDS });
      const result = await client.listDatastores();
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("VMFS");
    });
  });

  describe("getDatastore", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns datastore details", async () => {
      setupMockRequest(200, {
        value: {
          name: "localDS",
          type: "VMFS",
          accessible: true,
          free_space: 500000000000,
          capacity: 1000000000000,
          thin_provisioning_supported: true,
        },
      });
      const result = await client.getDatastore("datastore-15");
      expect(result.accessible).toBe(true);
      expect(result.capacity).toBe(1000000000000);
    });
  });

  // ── Network Operations ──────────────────────────────────

  describe("listNetworks", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns list of networks", async () => {
      const mockNets = [
        { network: "network-20", name: "VM Network", type: "STANDARD_PORTGROUP" },
        { network: "dvportgroup-100", name: "DV-Prod", type: "DISTRIBUTED_PORTGROUP" },
      ];
      setupMockRequest(200, { value: mockNets });
      const result = await client.listNetworks();
      expect(result).toHaveLength(2);
      expect(result[1].type).toBe("DISTRIBUTED_PORTGROUP");
    });
  });

  // ── Cluster Operations ──────────────────────────────────

  describe("listClusters", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns list of clusters", async () => {
      setupMockRequest(200, {
        value: [{ cluster: "domain-c8", name: "Production", ha_enabled: true, drs_enabled: true }],
      });
      const result = await client.listClusters();
      expect(result).toHaveLength(1);
      expect(result[0].ha_enabled).toBe(true);
    });

    it("sends GET /api/vcenter/cluster", async () => {
      setupMockRequest(200, { value: [] });
      await client.listClusters();
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toBe("/api/vcenter/cluster");
    });
  });

  describe("getCluster", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns cluster details", async () => {
      setupMockRequest(200, { value: { name: "Production", resource_pool: "resgroup-10" } });
      const result = await client.getCluster("domain-c8");
      expect(result.resource_pool).toBe("resgroup-10");
    });
  });

  // ── Resource Pool Operations ────────────────────────────

  describe("listResourcePools", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns list of resource pools", async () => {
      setupMockRequest(200, {
        value: [{ resource_pool: "resgroup-10", name: "Resources" }],
      });
      const result = await client.listResourcePools();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Resources");
    });

    it("sends GET /api/vcenter/resource-pool", async () => {
      setupMockRequest(200, { value: [] });
      await client.listResourcePools();
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toBe("/api/vcenter/resource-pool");
    });
  });

  // ── Guest Info ──────────────────────────────────────────

  describe("getVMGuest", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns guest identity info", async () => {
      setupMockRequest(200, {
        value: {
          os_family: "LINUX",
          full_name: "Ubuntu Linux (64-bit)",
          host_name: "web-01",
          ip_address: "10.0.0.42",
          name: "UBUNTU_64",
        },
      });
      const result = await client.getVMGuest("vm-42");
      expect(result.ip_address).toBe("10.0.0.42");
      expect(result.os_family).toBe("LINUX");
    });

    it("sends GET /api/vcenter/vm/{id}/guest/identity", async () => {
      setupMockRequest(200, { value: {} });
      await client.getVMGuest("vm-42");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toBe("/api/vcenter/vm/vm-42/guest/identity");
    });
  });

  // ── Snapshot Operations ─────────────────────────────────

  describe("listSnapshots", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("returns list of snapshots", async () => {
      setupMockRequest(200, {
        value: {
          items: [
            { snapshot: "snap-1", name: "before-upgrade", description: "Pre-upgrade snapshot" },
          ],
        },
      });
      const result = await client.listSnapshots("vm-42");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("before-upgrade");
    });

    it("returns empty array when no snapshots", async () => {
      setupMockRequest(200, { value: {} });
      const result = await client.listSnapshots("vm-42");
      expect(result).toEqual([]);
    });
  });

  describe("createSnapshot", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("creates a snapshot and returns its ID", async () => {
      setupMockRequest(200, { value: "snapshot-123" });
      const result = await client.createSnapshot("vm-42", "test-snap", "Test snapshot", true);
      expect(result).toBe("snapshot-123");

      const opts = mockRequest.mock.calls[1][0];
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe("/api/vcenter/vm/vm-42/snapshots");
    });

    it("sends correct body with name, description, and memory", async () => {
      let writtenData = "";
      mockRequest.mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
        const res = createMockResponse(200, { value: "snap-1" });
        callback(res);
        return {
          on: vi.fn(),
          setTimeout: vi.fn(),
          write: vi.fn((d: string) => { writtenData = d; }),
          end: vi.fn(),
          destroy: vi.fn(),
        };
      });
      await client.createSnapshot("vm-42", "snap1", "desc", true);
      const body = JSON.parse(writtenData);
      expect(body.name).toBe("snap1");
      expect(body.description).toBe("desc");
      expect(body.memory).toBe(true);
    });
  });

  describe("deleteSnapshot", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("sends DELETE to correct path", async () => {
      setupMockRequest(200, "");
      await client.deleteSnapshot("vm-42", "snap-1");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.method).toBe("DELETE");
      expect(opts.path).toBe("/api/vcenter/vm/vm-42/snapshots/snap-1");
    });
  });

  describe("revertSnapshot", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("sends POST with action=revert", async () => {
      setupMockRequest(200, "");
      await client.revertSnapshot("vm-42", "snap-1");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe("/api/vcenter/vm/vm-42/snapshots/snap-1?action=revert");
    });
  });

  // ── VM CRUD ─────────────────────────────────────────────

  describe("createVM", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("creates a VM and returns its ID", async () => {
      setupMockRequest(200, { value: "vm-100" });
      const result = await client.createVM({
        name: "new-vm",
        guest_OS: "OTHER_LINUX_64",
      });
      expect(result).toBe("vm-100");

      const opts = mockRequest.mock.calls[1][0];
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe("/api/vcenter/vm");
    });

    it("sends spec wrapped in { spec: ... }", async () => {
      let writtenData = "";
      mockRequest.mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
        const res = createMockResponse(200, { value: "vm-100" });
        callback(res);
        return {
          on: vi.fn(),
          setTimeout: vi.fn(),
          write: vi.fn((d: string) => { writtenData = d; }),
          end: vi.fn(),
          destroy: vi.fn(),
        };
      });
      await client.createVM({ name: "test", guest_OS: "UBUNTU_64" });
      const body = JSON.parse(writtenData);
      expect(body.spec).toBeDefined();
      expect(body.spec.name).toBe("test");
    });
  });

  describe("deleteVM", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("sends DELETE to correct path", async () => {
      setupMockRequest(200, "");
      await client.deleteVM("vm-42");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.method).toBe("DELETE");
      expect(opts.path).toBe("/api/vcenter/vm/vm-42");
    });
  });

  // ── Error Handling ──────────────────────────────────────

  describe("error handling", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("throws on 404", async () => {
      setupMockRequest(404, { value: { messages: [{ default_message: "Not Found" }] } }, "Not Found");
      await expect(client.getVM("vm-999")).rejects.toThrow("vSphere API error: 404");
    });

    it("throws on 500", async () => {
      setupMockRequest(500, "Internal Server Error", "Internal Server Error");
      await expect(client.listVMs()).rejects.toThrow("vSphere API error: 500");
    });

    it("throws on connection error", async () => {
      mockRequest.mockImplementation((_opts: unknown, _callback: unknown) => {
        const reqListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const req = {
          on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (!reqListeners[event]) reqListeners[event] = [];
            reqListeners[event].push(handler);
            return req;
          }),
          setTimeout: vi.fn(),
          write: vi.fn(),
          end: vi.fn(() => {
            // Trigger error
            setTimeout(() => {
              for (const handler of reqListeners["error"] ?? []) {
                handler(new Error("ECONNREFUSED"));
              }
            }, 0);
          }),
          destroy: vi.fn(),
        };
        return req;
      });
      await expect(client.listVMs()).rejects.toThrow("vSphere request failed: ECONNREFUSED");
    });

    it("includes error messages from vSphere API response", async () => {
      setupMockRequest(400, {
        value: { messages: [{ default_message: "Invalid parameter" }] },
      }, "Bad Request");
      await expect(client.getVM("bad")).rejects.toThrow("Invalid parameter");
    });
  });

  // ── isConnected ─────────────────────────────────────────

  describe("isConnected", () => {
    it("returns false before session is created", () => {
      expect(client.isConnected()).toBe(false);
    });

    it("returns true after session is created", async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
      expect(client.isConnected()).toBe(true);
    });

    it("returns false after session is deleted", async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
      setupMockRequest(200, "");
      await client.deleteSession();
      expect(client.isConnected()).toBe(false);
    });
  });

  // ── URL encoding ────────────────────────────────────────

  describe("URL encoding", () => {
    beforeEach(async () => {
      setupMockRequest(200, { value: "token" });
      await client.createSession();
    });

    it("encodes special characters in VM IDs", async () => {
      setupMockRequest(200, { value: { name: "test" } });
      await client.getVM("vm-42/test");
      const opts = mockRequest.mock.calls[1][0];
      expect(opts.path).toBe("/api/vcenter/vm/vm-42%2Ftest");
    });
  });
});
