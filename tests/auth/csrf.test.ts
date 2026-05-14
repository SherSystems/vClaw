import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "../../src/frontends/dashboard/server.js";
import { UserStore } from "../../src/auth/store.js";
import { hashPassword } from "../../src/auth/password.js";
import {
  SESSION_COOKIE_NAME,
  resetSessionSecretCache,
  signSession,
} from "../../src/auth/session.js";

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

function makeReq(path: string, method: string, headers: Record<string, string> = {}) {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  return {
    url: path,
    method,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    on(event: string, cb: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return this;
    },
    flush() {
      const payload = Buffer.from(JSON.stringify({}));
      for (const cb of listeners.data ?? []) cb(payload);
      for (const cb of listeners.end ?? []) cb();
    },
  } as any;
}

function makeRes() {
  const headers: Record<string, string | number> = {};
  let statusCode: number | undefined;
  let body: unknown;
  return {
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, nextHeaders?: Record<string, string | number>) {
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
    getBody() {
      return body == null ? undefined : String(body);
    },
    getJson() {
      const raw = this.getBody();
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function runRequest(
  server: any,
  path: string,
  method: string,
  headers?: Record<string, string>,
) {
  const req = makeReq(path, method, headers ?? {});
  const res = makeRes();
  server.handleRequest(req, res);
  req.flush();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (res.getStatusCode() !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return res;
}

let tmpDir: string;
let usersPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "rhodes-auth-csrf-"));
  usersPath = join(tmpDir, "users.json");
  process.env.RHODES_AUTH_USERS_FILE = usersPath;
  process.env.RHODES_SESSION_SECRET = "csrf-test-secret-32-bytes-minimum-length";
  resetSessionSecretCache();
  const store = new UserStore({ path: usersPath });
  // Seed both an admin and a viewer
  store.upsert({
    username: "admin1",
    bcrypt_hash: await hashPassword("doesntmatter"),
    role: "admin",
    created_at: new Date().toISOString(),
  });
  store.upsert({
    username: "viewer1",
    bcrypt_hash: await hashPassword("doesntmatter"),
    role: "viewer",
    created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.RHODES_AUTH_USERS_FILE;
});

describe("API route auth gating", () => {
  it("rejects unauthenticated GET to a protected route with 401", async () => {
    const server = makeServer();
    const res = await runRequest(server, "/api/incidents", "GET");
    expect(res.getStatusCode()).toBe(401);
    expect(res.getJson().error).toBe("unauthorized");
  });

  it("rejects unauthenticated POST to admin route with 401", async () => {
    const server = makeServer();
    const res = await runRequest(server, "/api/agent/command", "POST");
    expect(res.getStatusCode()).toBe(401);
  });

  it("returns 403 for viewer attempting an admin-mutating route", async () => {
    const server = makeServer();
    const token = signSession({ username: "viewer1", role: "viewer" });
    const res = await runRequest(server, "/api/agent/command", "POST", {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    });
    expect(res.getStatusCode()).toBe(403);
    const body = res.getJson();
    expect(body.error).toBe("forbidden");
    expect(body.required_role).toBe("admin");
  });

  it("allows /api/healthz unauthenticated", async () => {
    const server = makeServer();
    const res = await runRequest(server, "/api/healthz", "GET");
    expect(res.getStatusCode()).toBe(200);
  });

  it("allows / unauthenticated (SPA shell decides login UX)", async () => {
    const server = makeServer();
    const res = await runRequest(server, "/", "GET");
    // 200 if React bundle exists, else falls through to template — either way not 401.
    expect(res.getStatusCode()).not.toBe(401);
  });

  it("returns 403 for viewer attempting POST /api/chaos/execute", async () => {
    const server = makeServer();
    const token = signSession({ username: "viewer1", role: "viewer" });
    const res = await runRequest(server, "/api/chaos/execute", "POST", {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it("returns 403 for viewer attempting POST /api/migration/execute", async () => {
    const server = makeServer();
    const token = signSession({ username: "viewer1", role: "viewer" });
    const res = await runRequest(server, "/api/migration/execute", "POST", {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it("returns 403 for viewer attempting DELETE on topology dynamic route", async () => {
    const server = makeServer();
    const token = signSession({ username: "viewer1", role: "viewer" });
    const res = await runRequest(server, "/api/topology/apps/app-1", "DELETE", {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    });
    expect(res.getStatusCode()).toBe(403);
  });
});
