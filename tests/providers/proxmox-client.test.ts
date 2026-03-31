import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequest = vi.fn();

vi.mock("node:https", () => ({
  default: {
    request: (...args: unknown[]) => mockRequest(...args),
  },
}));

import { ProxmoxClient, type ProxmoxClientConfig } from "../../src/providers/proxmox/client.js";

type ResponseSpec = {
  type: "response";
  statusCode: number;
  body: unknown;
  statusMessage?: string;
};

type TimeoutSpec = {
  type: "timeout";
};

type RequestErrorSpec = {
  type: "request_error";
  message: string;
};

type RequestSpec = ResponseSpec | TimeoutSpec | RequestErrorSpec;

type RequestRecord = {
  options: Record<string, unknown>;
  writes: string[];
  req: {
    on: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
};

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

  setTimeout(() => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    if (payload.length > 0) {
      res.emit("data", Buffer.from(payload));
    }
    res.emit("end");
  }, 0);

  return res;
}

function setupMockRequestSequence(specs: RequestSpec[], records: RequestRecord[]) {
  let idx = 0;
  mockRequest.mockImplementation((options: Record<string, unknown>, callback: (res: unknown) => void) => {
    const spec = specs[Math.min(idx, specs.length - 1)];
    idx += 1;

    const reqListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    let timeoutHandler: (() => void) | undefined;
    const writes: string[] = [];

    const req = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!reqListeners[event]) reqListeners[event] = [];
        reqListeners[event].push(handler);
        return req;
      }),
      setTimeout: vi.fn((_ms: number, handler: () => void) => {
        timeoutHandler = handler;
        return req;
      }),
      write: vi.fn((data: unknown) => {
        writes.push(String(data));
      }),
      end: vi.fn(() => {
        if (spec.type === "request_error") {
          setTimeout(() => {
            for (const handler of reqListeners.error ?? []) {
              handler(new Error(spec.message));
            }
          }, 0);
          return;
        }

        if (spec.type === "timeout" && timeoutHandler) {
          setTimeout(() => timeoutHandler?.(), 0);
        }
      }),
      destroy: vi.fn(),
    };

    records.push({ options, writes, req });

    if (spec.type === "response") {
      callback(createMockResponse(spec.statusCode, spec.body, spec.statusMessage));
    }

    return req;
  });
}

function toFormMap(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

const defaultConfig: ProxmoxClientConfig = {
  host: "pve.lab.local",
  port: 8006,
  tokenId: "root@pam!qa",
  tokenSecret: "token-secret",
  allowSelfSignedCerts: true,
};

describe("ProxmoxClient", () => {
  let client: ProxmoxClient;
  let records: RequestRecord[];

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ProxmoxClient(defaultConfig);
    records = [];
  });

  describe("connect", () => {
    it("authenticates against /version and marks client connected", async () => {
      setupMockRequestSequence(
        [{ type: "response", statusCode: 200, body: { data: { version: "8.1.0" } } }],
        records
      );

      await client.connect();

      expect(client.isConnected()).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(records[0].options.method).toBe("GET");
      expect(records[0].options.path).toBe("/api2/json/version");
      expect(records[0].options.rejectUnauthorized).toBe(false);
      const headers = records[0].options.headers as Record<string, string>;
      expect(headers.Authorization).toBe("PVEAPIToken=root@pam!qa=token-secret");
    });

    it("wraps auth/session failures with endpoint context", async () => {
      setupMockRequestSequence(
        [
          {
            type: "response",
            statusCode: 401,
            statusMessage: "Unauthorized",
            body: { errors: { tokenid: "permission denied" } },
          },
        ],
        records
      );

      await expect(client.connect()).rejects.toThrow("Failed to connect to Proxmox at pve.lab.local:8006");
      await expect(client.connect()).rejects.toThrow("401 Unauthorized");
      expect(client.isConnected()).toBe(false);
    });
  });

  describe("error normalization", () => {
    it("includes structured API errors payload in thrown messages", async () => {
      setupMockRequestSequence(
        [
          {
            type: "response",
            statusCode: 500,
            statusMessage: "Internal Server Error",
            body: { errors: { vmid: "already exists" } },
          },
        ],
        records
      );

      await expect(client.getNodes()).rejects.toThrow("\"vmid\":\"already exists\"");
    });

    it("includes structured data payload when errors field is absent", async () => {
      setupMockRequestSequence(
        [
          {
            type: "response",
            statusCode: 502,
            statusMessage: "Bad Gateway",
            body: { data: { reason: "upstream proxy down" } },
          },
        ],
        records
      );

      await expect(client.getNodes()).rejects.toThrow("\"reason\":\"upstream proxy down\"");
    });

    it("includes plain-text non-JSON responses", async () => {
      setupMockRequestSequence(
        [
          {
            type: "response",
            statusCode: 503,
            statusMessage: "Service Unavailable",
            body: "proxy unavailable",
          },
        ],
        records
      );

      await expect(client.getNodes()).rejects.toThrow("proxy unavailable");
    });
  });

  describe("timeout and request errors", () => {
    it("fails requests that exceed the timeout and destroys the socket", async () => {
      setupMockRequestSequence([{ type: "timeout" }], records);

      await expect(client.getNodes()).rejects.toThrow("Proxmox request timed out: GET /api2/json/nodes");
      expect(records[0].req.destroy).toHaveBeenCalledTimes(1);
    });

    it("normalizes transport-level request failures", async () => {
      setupMockRequestSequence([{ type: "request_error", message: "ECONNREFUSED" }], records);

      await expect(client.getNodes()).rejects.toThrow("Proxmox request failed: ECONNREFUSED");
    });
  });

  describe("fallback and retry paths", () => {
    it("falls back from QEMU to LXC when VM status fetch fails", async () => {
      setupMockRequestSequence(
        [
          {
            type: "response",
            statusCode: 500,
            statusMessage: "Internal Server Error",
            body: { data: "qemu endpoint failed" },
          },
          {
            type: "response",
            statusCode: 200,
            body: {
              data: {
                vmid: 101,
                name: "ct-101",
                status: "running",
                cpus: 2,
                cpu: 0.1,
                mem: 256,
                maxmem: 512,
                disk: 10,
                maxdisk: 20,
                uptime: 30,
                ha: {},
              },
            },
          },
        ],
        records
      );

      const result = await client.getVMStatus("node/a", 101);

      expect(result.name).toBe("ct-101");
      expect(records[0].options.path).toBe("/api2/json/nodes/node%2Fa/qemu/101/status/current");
      expect(records[1].options.path).toBe("/api2/json/nodes/node%2Fa/lxc/101/status/current");
    });

    it("preserves delete guardrails by only sending purge when explicitly enabled", async () => {
      setupMockRequestSequence(
        [
          {
            type: "response",
            statusCode: 500,
            statusMessage: "Internal Server Error",
            body: { data: "qemu delete failed" },
          },
          {
            type: "response",
            statusCode: 200,
            body: { data: "UPID:pve1:delete:ok" },
          },
        ],
        records
      );

      const result = await client.deleteVM("node/a", 100, true);

      expect(result).toContain("UPID:");
      expect(records[0].options.path).toBe("/api2/json/nodes/node%2Fa/qemu/100?purge=1");
      expect(records[1].options.path).toBe("/api2/json/nodes/node%2Fa/lxc/100?purge=1");
    });

    it("does not set purge by default when deleting a VM", async () => {
      setupMockRequestSequence(
        [{ type: "response", statusCode: 200, body: { data: "UPID:pve1:delete:ok" } }],
        records
      );

      await client.deleteVM("pve1", 200);

      expect(records[0].options.path).toBe("/api2/json/nodes/pve1/qemu/200");
    });
  });

  describe("parameter normalization", () => {
    it("converts firewall rule booleans to Proxmox integer flags", async () => {
      setupMockRequestSequence(
        [{ type: "response", statusCode: 200, body: { data: null } }],
        records
      );

      await client.addVMFirewallRule("pve1", 101, {
        type: "in",
        action: "ACCEPT",
        enable: false,
        comment: "lock down",
      });

      const body = toFormMap(records[0].writes[0]);
      expect(body.type).toBe("in");
      expect(body.action).toBe("ACCEPT");
      expect(body.enable).toBe("0");
      expect(body.comment).toBe("lock down");
    });

    it("normalizes migrate booleans and with_local_disks key", async () => {
      setupMockRequestSequence(
        [{ type: "response", statusCode: 200, body: { data: "UPID:pve1:migrate:ok" } }],
        records
      );

      await client.migrateVM({
        node: "pve1",
        vmid: 300,
        target: "pve2",
        online: true,
        force: false,
        with_local_disks: true,
        targetstorage: "local-lvm",
      });

      const body = toFormMap(records[0].writes[0]);
      expect(body.target).toBe("pve2");
      expect(body.online).toBe("1");
      expect(body.force).toBe("0");
      expect(body["with-local-disks"]).toBe("1");
      expect(body.with_local_disks).toBeUndefined();
      expect(body.targetstorage).toBe("local-lvm");
    });
  });

  describe("method wrappers", () => {
    it("merges node-local QEMU and LXC VM listings", async () => {
      setupMockRequestSequence(
        [
          { type: "response", statusCode: 200, body: { data: [{ vmid: 101, name: "vm-101", status: "running" }] } },
          { type: "response", statusCode: 200, body: { data: [{ vmid: 102, name: "ct-102", status: "stopped" }] } },
        ],
        records
      );

      const result = await client.getVMs("pve1");
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("qemu");
      expect(result[0].node).toBe("pve1");
      expect(result[1].type).toBe("lxc");
      expect(records[0].options.path).toBe("/api2/json/nodes/pve1/qemu");
      expect(records[1].options.path).toBe("/api2/json/nodes/pve1/lxc");
    });

    it("skips nodes that fail during all-node VM inventory", async () => {
      setupMockRequestSequence(
        [
          {
            type: "response",
            statusCode: 200,
            body: { data: [{ node: "pve1", status: "online" }, { node: "pve2", status: "online" }] },
          },
          { type: "response", statusCode: 200, body: { data: [{ vmid: 201, name: "vm-201", status: "running" }] } },
          { type: "response", statusCode: 200, body: { data: [] } },
          {
            type: "response",
            statusCode: 500,
            statusMessage: "Internal Server Error",
            body: { data: "node unavailable" },
          },
        ],
        records
      );

      const result = await client.getVMs();
      expect(result).toHaveLength(1);
      expect(result[0].vmid).toBe(201);
      expect(records[3].options.path).toBe("/api2/json/nodes/pve2/qemu");
    });

    it("encodes GET filters for syslog, ISOs, templates, and tasks", async () => {
      setupMockRequestSequence(
        [
          { type: "response", statusCode: 200, body: { data: [] } },
          { type: "response", statusCode: 200, body: { data: [] } },
          { type: "response", statusCode: 200, body: { data: [] } },
          { type: "response", statusCode: 200, body: { data: [] } },
        ],
        records
      );

      await client.getNodeSyslog("pve1", {
        start: 5,
        limit: 10,
        since: "2026-01-01 00:00:00",
        until: "2026-01-01 01:00:00",
        service: "pvedaemon",
      });
      await client.getISOs("pve1", "local-lvm");
      await client.getTemplates("pve1", "local-lvm");
      await client.getTasks("pve1", 25);

      expect(records[0].options.path).toContain("/api2/json/nodes/pve1/syslog?");
      expect(records[0].options.path).toContain("start=5");
      expect(records[0].options.path).toContain("limit=10");
      expect(records[0].options.path).toContain("service=pvedaemon");
      expect(records[1].options.path).toBe("/api2/json/nodes/pve1/storage/local-lvm/content?content=iso");
      expect(records[2].options.path).toBe("/api2/json/nodes/pve1/storage/local-lvm/content?content=vztmpl");
      expect(records[3].options.path).toBe("/api2/json/nodes/pve1/tasks?limit=25");
    });

    it("encodes POST/PUT form bodies for create/resize/snapshot operations", async () => {
      setupMockRequestSequence(
        [
          { type: "response", statusCode: 200, body: { data: "UPID:create-vm" } },
          { type: "response", statusCode: 200, body: { data: "UPID:create-ct" } },
          { type: "response", statusCode: 200, body: { data: "UPID:snapshot" } },
          { type: "response", statusCode: 200, body: { data: null } },
        ],
        records
      );

      await client.createVM({ node: "pve1", vmid: 1000, name: "vm-1000", memory: 4096, start: true });
      await client.createCT({ node: "pve1", vmid: 2000, ostemplate: "local:vztmpl/debian.tar.zst", unprivileged: true });
      await client.createSnapshot("pve1", 1000, "before-upgrade", "snapshot", true);
      await client.resizeDisk("pve1", 1000, "scsi0", "+20G");

      expect(toFormMap(records[0].writes[0])).toMatchObject({ vmid: "1000", name: "vm-1000", memory: "4096", start: "true" });
      expect(toFormMap(records[1].writes[0])).toMatchObject({ vmid: "2000", ostemplate: "local:vztmpl/debian.tar.zst", unprivileged: "true" });
      expect(toFormMap(records[2].writes[0])).toMatchObject({ snapname: "before-upgrade", description: "snapshot", vmstate: "1" });
      expect(toFormMap(records[3].writes[0])).toMatchObject({ disk: "scsi0", size: "+20G" });
    });

    it("routes storage and node endpoint lookups correctly", async () => {
      setupMockRequestSequence(
        [
          { type: "response", statusCode: 200, body: { data: [] } },
          { type: "response", statusCode: 200, body: { data: [] } },
          { type: "response", statusCode: 200, body: { data: [] } },
          { type: "response", statusCode: 200, body: { data: [] } },
        ],
        records
      );

      await client.getStorage();
      await client.getStorage("pve1");
      await client.getNodeStats("pve/1");
      await client.getNetworkInterfaces("pve/1");

      expect(records[0].options.path).toBe("/api2/json/storage");
      expect(records[1].options.path).toBe("/api2/json/nodes/pve1/storage");
      expect(records[2].options.path).toBe("/api2/json/nodes/pve%2F1/status");
      expect(records[3].options.path).toBe("/api2/json/nodes/pve%2F1/network");
    });

    it("falls back from QEMU to LXC for config, snapshots, firewall, and update paths", async () => {
      setupMockRequestSequence(
        [
          { type: "response", statusCode: 500, statusMessage: "Internal Server Error", body: { data: "qemu config failed" } },
          { type: "response", statusCode: 200, body: { data: { memory: 1024 } } },
          { type: "response", statusCode: 500, statusMessage: "Internal Server Error", body: { data: "qemu snapshot list failed" } },
          { type: "response", statusCode: 200, body: { data: [] } },
          { type: "response", statusCode: 500, statusMessage: "Internal Server Error", body: { data: "qemu snapshot rollback failed" } },
          { type: "response", statusCode: 200, body: { data: "UPID:rollback" } },
          { type: "response", statusCode: 500, statusMessage: "Internal Server Error", body: { data: "qemu snapshot delete failed" } },
          { type: "response", statusCode: 200, body: { data: "UPID:delete-snap" } },
          { type: "response", statusCode: 500, statusMessage: "Internal Server Error", body: { data: "qemu firewall list failed" } },
          { type: "response", statusCode: 200, body: { data: [] } },
          { type: "response", statusCode: 500, statusMessage: "Internal Server Error", body: { data: "qemu firewall add failed" } },
          { type: "response", statusCode: 200, body: { data: null } },
          { type: "response", statusCode: 500, statusMessage: "Internal Server Error", body: { data: "qemu update failed" } },
          { type: "response", statusCode: 200, body: { data: null } },
          { type: "response", statusCode: 500, statusMessage: "Internal Server Error", body: { data: "qemu shutdown failed" } },
          { type: "response", statusCode: 200, body: { data: "UPID:shutdown" } },
        ],
        records
      );

      await client.getVMConfig("pve1", 500);
      await client.listSnapshots("pve1", 500);
      await client.rollbackSnapshot("pve1", 500, "snap-a");
      await client.deleteSnapshot("pve1", 500, "snap-a");
      await client.getVMFirewallRules("pve1", 500);
      await client.addVMFirewallRule("pve1", 500, { type: "in", action: "ACCEPT" });
      await client.updateVMConfig("pve1", 500, { memory: 4096 });
      await client.shutdownVM("pve1", 500, 45);

      expect(records[0].options.path).toBe("/api2/json/nodes/pve1/qemu/500/config");
      expect(records[1].options.path).toBe("/api2/json/nodes/pve1/lxc/500/config");
      expect(records[2].options.path).toBe("/api2/json/nodes/pve1/qemu/500/snapshot");
      expect(records[3].options.path).toBe("/api2/json/nodes/pve1/lxc/500/snapshot");
      expect(records[10].options.path).toBe("/api2/json/nodes/pve1/qemu/500/firewall/rules");
      expect(records[11].options.path).toBe("/api2/json/nodes/pve1/lxc/500/firewall/rules");
      expect(records[14].options.path).toBe("/api2/json/nodes/pve1/qemu/500/status/shutdown");
      expect(records[15].options.path).toBe("/api2/json/nodes/pve1/lxc/500/status/shutdown");
    });
  });

  describe("task polling", () => {
    it("retries task status polling until task is stopped", async () => {
      setupMockRequestSequence(
        [
          {
            type: "response",
            statusCode: 200,
            body: {
              data: {
                status: "running",
                type: "qmstart",
                id: "100",
                user: "root@pam",
                node: "pve1",
                pid: 1,
                starttime: 1,
              },
            },
          },
          {
            type: "response",
            statusCode: 200,
            body: {
              data: {
                status: "stopped",
                exitstatus: "OK",
                type: "qmstart",
                id: "100",
                user: "root@pam",
                node: "pve1",
                pid: 1,
                starttime: 1,
              },
            },
          },
        ],
        records
      );

      const result = await client.waitForTask("pve1", "UPID:task", 500, 1);
      expect(result.status).toBe("stopped");
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
  });
});
