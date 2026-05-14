// ============================================================
// RHODES — Session Token (HS256 JWT, node:crypto)
// 24h expiry, signed with $RHODES_SESSION_SECRET or generated
// secret at ~/.rhodes/session-secret (mode 0600).
// ============================================================

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
  fsyncSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "./store.js";

export const SESSION_COOKIE_NAME = "rhodes_session";
export const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h

export interface SessionPayload {
  username: string;
  role: Role;
  iat: number;
  exp: number;
}

interface JwtHeader {
  alg: "HS256";
  typ: "JWT";
}

// ── Secret resolution ──────────────────────────────────────

function secretPath(): string {
  return join(homedir(), ".rhodes", "session-secret");
}

let cachedSecret: Buffer | null = null;
let warnedGenerated = false;

/**
 * Return the HS256 secret. Resolution order:
 *  1. $RHODES_SESSION_SECRET (preferred; ops-managed)
 *  2. ~/.rhodes/session-secret (generated on first call, mode 0600)
 */
export function getSessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;

  const fromEnv = process.env.RHODES_SESSION_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    cachedSecret = Buffer.from(fromEnv, "utf8");
    return cachedSecret;
  }

  const path = secretPath();
  if (existsSync(path)) {
    const perm = statSync(path).mode & 0o777;
    if (perm & 0o077) {
      throw new Error(
        `[auth/session] Refusing to read ${path}: mode is ${perm.toString(8)}, must be 600`,
      );
    }
    cachedSecret = readFileSync(path);
    return cachedSecret;
  }

  // Generate + persist
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const buf = randomBytes(32);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (!warnedGenerated) {
    // One-line, low-volume — stays for the lifetime of the process.
    console.log("[auth/session] generated new session secret at ~/.rhodes/session-secret");
    warnedGenerated = true;
  }
  cachedSecret = buf;
  return cachedSecret;
}

/** Test/diagnostics hook: forget the cached secret. */
export function resetSessionSecretCache(): void {
  cachedSecret = null;
  warnedGenerated = false;
}

// ── Base64url helpers ──────────────────────────────────────

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(input: string): Buffer {
  const pad = 4 - (input.length % 4);
  const padded = pad === 4 ? input : input + "=".repeat(pad);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ── Sign / verify ──────────────────────────────────────────

export function signSession(
  payload: { username: string; role: Role },
  ttlSeconds = SESSION_TTL_SECONDS,
): string {
  const header: JwtHeader = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const full: SessionPayload = {
    username: payload.username,
    role: payload.role,
    iat: now,
    exp: now + ttlSeconds,
  };
  const headPart = b64url(JSON.stringify(header));
  const payloadPart = b64url(JSON.stringify(full));
  const signingInput = `${headPart}.${payloadPart}`;
  const sig = createHmac("sha256", getSessionSecret())
    .update(signingInput)
    .digest();
  return `${signingInput}.${b64url(sig)}`;
}

export interface VerifyResult {
  ok: boolean;
  payload?: SessionPayload;
  error?: "malformed" | "bad_signature" | "expired" | "bad_payload";
}

export function verifySession(token: string): VerifyResult {
  if (typeof token !== "string" || !token) return { ok: false, error: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed" };
  const [headPart, payloadPart, sigPart] = parts;

  const expected = createHmac("sha256", getSessionSecret())
    .update(`${headPart}.${payloadPart}`)
    .digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(sigPart);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (provided.length !== expected.length) {
    return { ok: false, error: "bad_signature" };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, error: "bad_signature" };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadPart).toString("utf8"));
  } catch {
    return { ok: false, error: "bad_payload" };
  }
  if (
    typeof payload.username !== "string" ||
    (payload.role !== "admin" && payload.role !== "viewer") ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, error: "bad_payload" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return { ok: false, error: "expired" };
  return { ok: true, payload };
}

// ── Cookie helpers ─────────────────────────────────────────

export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      const v = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

export interface CookieOptions {
  /** Use Secure attribute (set when request is over TLS). */
  secure?: boolean;
  /** Override max-age in seconds; defaults to session TTL. */
  maxAge?: number;
}

export function buildSessionCookie(value: string, opts: CookieOptions = {}): string {
  const maxAge = opts.maxAge ?? SESSION_TTL_SECONDS;
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookie(opts: CookieOptions = {}): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
