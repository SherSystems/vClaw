import { describe, it, expect, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isPublicPath,
  isMutatingMethod,
  getSession,
  requireAuth,
  requireAdmin,
} from "../../src/frontends/dashboard/auth.js";
import {
  SESSION_COOKIE_NAME,
  signSession,
  resetSessionSecretCache,
} from "../../src/auth/session.js";

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

interface FakeResponse extends ServerResponse {
  statusCode: number;
  body: string;
}

function fakeRes(): FakeResponse {
  const headers: Record<string, string | number> = {};
  let statusCode = 200;
  let body = "";
  const res = {
    headers,
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    get body() {
      return body;
    },
    writeHead(s: number, h?: Record<string, string | number>) {
      statusCode = s;
      Object.assign(headers, h ?? {});
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
    },
  } as unknown as FakeResponse;
  return res;
}

describe("dashboard auth middleware", () => {
  beforeEach(() => {
    process.env.RHODES_SESSION_SECRET = "test-secret-for-middleware-tests-32bytes";
    resetSessionSecretCache();
  });

  it("isPublicPath allow-lists root, auth endpoints, healthz, and static assets", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/api/healthz")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/api/auth/logout")).toBe(true);
    expect(isPublicPath("/api/auth/whoami")).toBe(true);
    expect(isPublicPath("/brand/rhodes-mark-white.svg")).toBe(true);
    expect(isPublicPath("/assets/index-abc.js")).toBe(true);
    expect(isPublicPath("/something.css")).toBe(true);
  });

  it("isPublicPath rejects API routes", () => {
    expect(isPublicPath("/api/incidents")).toBe(false);
    expect(isPublicPath("/api/agent/command")).toBe(false);
    expect(isPublicPath("/api/cluster")).toBe(false);
  });

  it("isMutatingMethod matches POST/PUT/PATCH/DELETE", () => {
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
    expect(isMutatingMethod("OPTIONS")).toBe(false);
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("PUT")).toBe(true);
    expect(isMutatingMethod("PATCH")).toBe(true);
    expect(isMutatingMethod("DELETE")).toBe(true);
  });

  it("getSession returns null when no cookie present", () => {
    expect(getSession(fakeReq({}))).toBeNull();
  });

  it("getSession returns session for valid token", () => {
    const token = signSession({ username: "alice", role: "admin" });
    const req = fakeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
    const session = getSession(req);
    expect(session).not.toBeNull();
    expect(session!.username).toBe("alice");
    expect(session!.role).toBe("admin");
  });

  it("getSession returns null for tampered token", () => {
    const token = signSession({ username: "alice", role: "admin" });
    const tampered = token.slice(0, -3) + "xxx";
    const req = fakeReq({ cookie: `${SESSION_COOKIE_NAME}=${tampered}` });
    expect(getSession(req)).toBeNull();
  });

  it("requireAuth returns 'public' for allow-listed paths", () => {
    const res = fakeRes();
    expect(requireAuth(fakeReq(), res, "/api/healthz")).toBe("public");
  });

  it("requireAuth blocks unauthenticated request with 401", () => {
    const res = fakeRes();
    const result = requireAuth(fakeReq(), res, "/api/incidents");
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("unauthorized");
  });

  it("requireAuth passes when a valid session cookie is present", () => {
    const token = signSession({ username: "viewer", role: "viewer" });
    const res = fakeRes();
    const result = requireAuth(
      fakeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` }),
      res,
      "/api/incidents",
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe("public");
    if (result && result !== "public") {
      expect(result.role).toBe("viewer");
    }
  });

  it("requireAdmin blocks a viewer session with 403", () => {
    const token = signSession({ username: "v", role: "viewer" });
    const res = fakeRes();
    const result = requireAdmin(
      fakeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` }),
      res,
    );
    expect(result).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("forbidden");
    expect(res.body).toContain("admin");
  });

  it("requireAdmin allows an admin session", () => {
    const token = signSession({ username: "a", role: "admin" });
    const res = fakeRes();
    const result = requireAdmin(
      fakeReq({ cookie: `${SESSION_COOKIE_NAME}=${token}` }),
      res,
    );
    expect(result).not.toBeNull();
    expect(result!.role).toBe("admin");
  });

  it("requireAdmin blocks no-cookie with 401", () => {
    const res = fakeRes();
    const result = requireAdmin(fakeReq(), res);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});
