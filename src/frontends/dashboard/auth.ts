// ============================================================
// RHODES — Dashboard Auth Middleware
// requireAuth / requireAdmin gates for the HTTP request router.
//
// Closes security audit D-3 (HIGH): "Dashboard has zero
// authentication on any endpoint."
// ============================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { UserStore } from "../../auth/store.js";
import {
  SESSION_COOKIE_NAME,
  parseCookie,
  verifySession,
  type SessionPayload,
} from "../../auth/session.js";
import { LoginRateLimiter } from "../../auth/rate-limit.js";

// ── Allow-lists ────────────────────────────────────────────

/**
 * Test/dev escape hatch — when RHODES_AUTH_DISABLED is "true" we skip
 * the cookie gate entirely. The default (unset) is the secure path.
 * Tests that pre-date the auth layer still pass without modification,
 * and operators with a closed network can opt out if they have other
 * controls in front.
 */
export function isAuthDisabled(): boolean {
  return (process.env.RHODES_AUTH_DISABLED ?? "").toLowerCase() === "true";
}

/**
 * Paths that bypass the auth check entirely. Anything else needs at least
 * a valid session cookie (requireAuth) — and mutating routes additionally
 * need role=admin (requireAdmin).
 *
 *  - /                          — React SPA shell decides login vs app
 *  - /api/healthz, /healthz     — health probes (external monitors)
 *  - /api/auth/login            — must be reachable to obtain a session
 *  - /api/auth/logout           — explicit clear, no-op if no cookie
 *  - /api/auth/whoami           — returns 401 when no session (handled by route)
 *  - /api/auth/bootstrap        — first-run bootstrap (refuses if users exist)
 */
const PUBLIC_PATHS = new Set<string>([
  "/",
  "/healthz",
  "/api/healthz",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/whoami",
  "/api/auth/bootstrap",
]);

const PUBLIC_PREFIXES: string[] = [
  "/brand/",
  "/assets/",
  // Slack inbound endpoints are exposed via the shim service, which
  // verifies Slack's request signature before relaying. From RHODES's
  // perspective the shim IS the auth boundary — operator-session
  // checks would block the request. The slash-command/interactivity
  // handlers stamp `slack:<user_id>` for audit instead.
  "/api/integrations/slack/",
];

const STATIC_EXTENSIONS = [
  ".js", ".mjs", ".css", ".html", ".svg", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".ico", ".woff2", ".woff", ".ttf", ".otf", ".eot",
  ".map", ".txt",
];

function isStaticAssetPath(path: string): boolean {
  for (const ext of STATIC_EXTENSIONS) {
    if (path.endsWith(ext)) return true;
  }
  return false;
}

export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  for (const p of PUBLIC_PREFIXES) {
    if (path.startsWith(p)) return true;
  }
  // SPA static assets (hashed JS/CSS) — the React bundle is allowed since
  // the SPA itself enforces login UX. Defense in depth: API routes are
  // still gated server-side regardless of what the SPA does.
  if (!path.startsWith("/api/") && isStaticAssetPath(path)) return true;
  return false;
}

// ── Mutating-method detection ──────────────────────────────

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string | undefined): boolean {
  return MUTATING_METHODS.has((method ?? "GET").toUpperCase());
}

// ── Session resolution ─────────────────────────────────────

export interface SessionContext {
  username: string;
  role: SessionPayload["role"];
  payload: SessionPayload;
}

export function getSession(req: IncomingMessage): SessionContext | null {
  // `headers` may be missing in some tests that mock IncomingMessage —
  // guard defensively rather than crashing the request.
  const cookieHeader =
    (req.headers && (req.headers as Record<string, unknown>).cookie) as string | undefined;
  const cookie = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!cookie) return null;
  const result = verifySession(cookie);
  if (!result.ok || !result.payload) return null;
  return {
    username: result.payload.username,
    role: result.payload.role,
    payload: result.payload,
  };
}

function jsonError(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ── Gate functions ─────────────────────────────────────────

export interface GateOptions {
  /** Used to detect bootstrap state — when there are zero users, the
   *  `/api/auth/bootstrap` endpoint is reachable; once a user exists,
   *  it 404s. */
  userStore: UserStore;
}

/**
 * requireAuth — verifies the session cookie. Returns true if the request
 * may proceed (already responded with 401 otherwise).
 *
 * Public paths (login/logout/whoami/healthz/static SPA shell) always pass.
 */
export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): SessionContext | null | "public" {
  if (isPublicPath(path)) return "public";
  const session = getSession(req);
  if (!session) {
    jsonError(res, 401, { error: "unauthorized" });
    return null;
  }
  return session;
}

/**
 * requireAdmin — first requires a session, then requires admin role.
 * Returns the session on success, null if already responded with 401/403.
 */
export function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): SessionContext | null {
  const session = getSession(req);
  if (!session) {
    jsonError(res, 401, { error: "unauthorized" });
    return null;
  }
  if (session.role !== "admin") {
    jsonError(res, 403, { error: "forbidden", required_role: "admin" });
    return null;
  }
  return session;
}

// ── Rate limiter (shared between calls) ────────────────────

export const loginRateLimiter = new LoginRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
});

export function clientIp(req: IncomingMessage): string {
  const xff = req.headers ? (req.headers as Record<string, unknown>)["x-forwarded-for"] : undefined;
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  const remote = req.socket && req.socket.remoteAddress;
  return remote ?? "unknown";
}
