import { describe, expect, it, vi } from "vitest";
import { DashboardServer } from "../../src/frontends/dashboard/server";

function makeServer() {
  const eventBus = {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    getHistory: vi.fn(() => []),
  } as any;

  const toolRegistry = {
    getClusterState: vi.fn(),
    getMultiClusterState: vi.fn(),
  } as any;

  const audit = {
    queryEntries: vi.fn(() => []),
    getStats: vi.fn(() => ({})),
    exportEntries: vi.fn(() => "[]"),
  } as any;

  return new DashboardServer(0, {} as any, toolRegistry, eventBus, audit) as any;
}

function makeReq(path: string) {
  return { url: path, method: "GET" } as any;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let body: unknown;

  return {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, nextHeaders?: Record<string, string>) {
      statusCode = code;
      if (nextHeaders) {
        for (const [name, value] of Object.entries(nextHeaders)) {
          headers[name.toLowerCase()] = value;
        }
      }
    },
    end(chunk?: unknown) {
      body = chunk;
    },
    getStatusCode() {
      return statusCode;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    getBody() {
      return body;
    },
  };
}

describe("Dashboard server static routing", () => {
  it("serves root-level static assets from dashboard-v2 dist", () => {
    const server = makeServer();
    const res = makeRes();

    server.handleRequest(makeReq("/vclaw-logo.png"), res);

    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("image/png");
    expect(Buffer.isBuffer(res.getBody())).toBe(true);
  });

  it("rejects path traversal attempts instead of falling back to SPA", () => {
    const server = makeServer();
    const res = makeRes();

    server.handleRequest(makeReq("/..%2Fpackage.json"), res);

    expect(res.getStatusCode()).toBe(404);
    expect(res.getHeader("content-type")).toContain("application/json");
    expect(String(res.getBody())).toContain("Not found");
  });

  it("allows azure provider for migration VM listing", async () => {
    const server = makeServer();
    server.migrationAdapter = { execute: vi.fn() } as any;
    server.toolRegistry.getMultiClusterState.mockResolvedValue({
      providers: [
        {
          type: "azure",
          state: {
            vms: [
              {
                id: "vm-az-1",
                name: "api-azure-1",
                status: "running",
                cpu_cores: 4,
                ram_mb: 8192,
                disk_gb: 128,
              },
            ],
          },
        },
      ],
    });
    const res = makeRes();

    await server.handleMigrationVMs(
      res,
      new URL("http://localhost/api/migration/vms?provider=azure"),
    );

    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader("content-type")).toContain("application/json");

    const payload = JSON.parse(String(res.getBody()));
    expect(payload.vms).toEqual([
      {
        id: "vm-az-1",
        name: "api-azure-1",
        provider: "azure",
        status: "running",
        cpu: 4,
        memoryMiB: 8192,
        diskGB: 128,
      },
    ]);
  });

  it("rejects unsupported migration VM providers", async () => {
    const server = makeServer();
    server.migrationAdapter = { execute: vi.fn() } as any;
    const res = makeRes();

    await server.handleMigrationVMs(
      res,
      new URL("http://localhost/api/migration/vms?provider=digitalocean"),
    );

    expect(res.getStatusCode()).toBe(400);
    expect(res.getHeader("content-type")).toContain("application/json");
    expect(String(res.getBody())).toContain("Invalid provider");
  });
});
