import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, chmodSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "../../src/frontends/dashboard/server.js";
import { UserStore } from "../../src/auth/store.js";
import { hashPassword } from "../../src/auth/password.js";
import {
  SESSION_COOKIE_NAME,
  resetSessionSecretCache,
} from "../../src/auth/session.js";
import { loginRateLimiter } from "../../src/frontends/dashboard/auth.js";

// ── Test scaffolding ─────────────────────────────────────

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

function makeJsonReq(
  path: string,
  method: string,
  body?: Record<string, unknown> | null,
  headers: Record<string, string> = {},
) {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const req: any = {
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
      if (body !== null && body !== undefined) {
        const payload = Buffer.from(JSON.stringify(body));
        for (const cb of listeners.data ?? []) cb(payload);
      }
      for (const cb of listeners.end ?? []) cb();
    },
  };
  return req;
}

function makeRes() {
  const headers: Record<string, string | number | string[]> = {};
  let statusCode: number | undefined;
  let body: unknown;
  let setCookieHeaders: string[] = [];
  return {
    setHeader(name: string, value: string | number | string[]) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, nextHeaders?: Record<string, string | number | string[]>) {
      statusCode = code;
      if (nextHeaders) {
        for (const [name, value] of Object.entries(nextHeaders)) {
          headers[name.toLowerCase()] = value;
          if (name.toLowerCase() === "set-cookie") {
            const arr = Array.isArray(value) ? value : [String(value)];
            setCookieHeaders.push(...arr);
          }
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
    getSetCookie(): string[] {
      return setCookieHeaders;
    },
    getBody(): string | undefined {
      return body == null ? undefined : String(body);
    },
    getJson(): any {
      const raw = this.getBody();
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function extractSessionCookie(setCookies: string[]): string | null {
  for (const c of setCookies) {
    if (c.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      const eq = c.indexOf("=");
      const sc = c.indexOf(";");
      const v = sc === -1 ? c.slice(eq + 1) : c.slice(eq + 1, sc);
      if (v.length === 0) return null;
      return decodeURIComponent(v);
    }
  }
  return null;
}

async function runRequest(
  server: any,
  path: string,
  method: string,
  body?: Record<string, unknown> | null,
  headers?: Record<string, string>,
) {
  const req = makeJsonReq(path, method, body, headers);
  const res = makeRes();
  server.handleRequest(req, res);
  req.flush();
  // Wait until the response has been written — handler is fire-and-forget
  // (handleRequest dispatches async work but is not awaitable). bcrypt
  // verify can take ~150ms, so poll.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (res.getStatusCode() !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return res;
}

// ── Per-test isolation ───────────────────────────────────

let tmpDir: string;
let usersPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "rhodes-auth-ep-"));
  usersPath = join(tmpDir, "users.json");
  process.env.RHODES_AUTH_USERS_FILE = usersPath;
  process.env.RHODES_SESSION_SECRET = "endpoint-tests-secret-32-bytes-min-len-here";
  resetSessionSecretCache();
  // Clear rate-limiter state between tests
  (loginRateLimiter as any).attempts = new Map();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.RHODES_AUTH_USERS_FILE;
});

async function seedUser(username: string, password: string, role: "admin" | "viewer") {
  const store = new UserStore({ path: usersPath });
  const hash = await hashPassword(password);
  store.upsert({
    username,
    bcrypt_hash: hash,
    role,
    created_at: new Date().toISOString(),
  });
}

// ── Tests ────────────────────────────────────────────────

describe("auth endpoints", () => {
  describe("POST /api/auth/login", () => {
    it("issues a session cookie for valid credentials", async () => {
      await seedUser("alice", "supersecret", "admin");
      const server = makeServer();
      const res = await runRequest(server, "/api/auth/login", "POST", {
        username: "alice",
        password: "supersecret",
      });
      expect(res.getStatusCode()).toBe(200);
      const body = res.getJson();
      expect(body.ok).toBe(true);
      expect(body.role).toBe("admin");
      const cookies = res.getSetCookie();
      expect(cookies.some((c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
      expect(cookies.join(";")).toContain("HttpOnly");
      expect(cookies.join(";")).toContain("SameSite=Strict");
    });

    it("returns 401 invalid_credentials for wrong password", async () => {
      await seedUser("alice", "rightpw", "viewer");
      const server = makeServer();
      const res = await runRequest(server, "/api/auth/login", "POST", {
        username: "alice",
        password: "wrongpw",
      });
      expect(res.getStatusCode()).toBe(401);
      expect(res.getJson().error).toBe("invalid_credentials");
    });

    it("returns 401 invalid_credentials for unknown user", async () => {
      const server = makeServer();
      const res = await runRequest(server, "/api/auth/login", "POST", {
        username: "ghost",
        password: "any",
      });
      expect(res.getStatusCode()).toBe(401);
    });

    it("rate-limits after 5 failed attempts (429)", async () => {
      await seedUser("alice", "rightpw", "admin");
      const server = makeServer();
      for (let i = 0; i < 5; i++) {
        const res = await runRequest(server, "/api/auth/login", "POST", {
          username: "alice",
          password: "wrong",
        });
        expect(res.getStatusCode()).toBe(401);
      }
      const res6 = await runRequest(server, "/api/auth/login", "POST", {
        username: "alice",
        password: "rightpw",
      });
      expect(res6.getStatusCode()).toBe(429);
      expect(res6.getJson().error).toBe("rate_limited");
    });
  });

  describe("POST /api/auth/logout", () => {
    it("returns 204 and clears the cookie", async () => {
      const server = makeServer();
      const res = await runRequest(server, "/api/auth/logout", "POST", null);
      expect(res.getStatusCode()).toBe(204);
      const cookies = res.getSetCookie();
      const clearCookie = cookies.find((c: string) =>
        c.startsWith(`${SESSION_COOKIE_NAME}=`),
      );
      expect(clearCookie).toBeDefined();
      expect(clearCookie).toContain("Max-Age=0");
    });
  });

  describe("GET /api/auth/whoami", () => {
    it("returns 401 when no session present", async () => {
      const server = makeServer();
      const res = await runRequest(server, "/api/auth/whoami", "GET");
      expect(res.getStatusCode()).toBe(401);
    });

    it("returns username + role for valid session", async () => {
      await seedUser("alice", "supersecret", "admin");
      const server = makeServer();
      const login = await runRequest(server, "/api/auth/login", "POST", {
        username: "alice",
        password: "supersecret",
      });
      const token = extractSessionCookie(login.getSetCookie());
      expect(token).not.toBeNull();
      const res = await runRequest(server, "/api/auth/whoami", "GET", null, {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      });
      expect(res.getStatusCode()).toBe(200);
      const body = res.getJson();
      expect(body.username).toBe("alice");
      expect(body.role).toBe("admin");
    });
  });

  describe("POST /api/auth/bootstrap", () => {
    it("creates the first admin when no users exist", async () => {
      const server = makeServer();
      const res = await runRequest(server, "/api/auth/bootstrap", "POST", {
        username: "founder",
        password: "longenoughpw",
      });
      expect(res.getStatusCode()).toBe(200);
      const body = res.getJson();
      expect(body.role).toBe("admin");
      // Store has the user persisted
      const store = new UserStore({ path: usersPath });
      expect(store.find("founder")).not.toBeNull();
    });

    it("returns 410 after a user already exists", async () => {
      await seedUser("alice", "supersecret", "admin");
      const server = makeServer();
      const res = await runRequest(server, "/api/auth/bootstrap", "POST", {
        username: "second",
        password: "longenoughpw",
      });
      expect(res.getStatusCode()).toBe(410);
    });

    it("rejects passwords shorter than 8 characters", async () => {
      const server = makeServer();
      const res = await runRequest(server, "/api/auth/bootstrap", "POST", {
        username: "a",
        password: "short",
      });
      expect(res.getStatusCode()).toBe(400);
    });
  });
});
