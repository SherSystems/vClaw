// ============================================================
// useAuth — RHODES Dashboard
// Hydrates the auth slice on mount (calls /api/auth/whoami) and
// exposes sign-in / sign-out actions. Closes security D-3 on
// the client side.
// ============================================================

import { useCallback, useEffect } from "react";
import { useStore, type AuthRole } from "../store";

export interface WhoamiResponse {
  username: string;
  role: AuthRole;
}

export interface BootstrapProbe {
  bootstrap_required: boolean;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(detail.error ?? res.statusText);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json();
}

export interface UseAuthReturn {
  user: { username: string; role: AuthRole } | null;
  role: AuthRole | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isReady: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  bootstrap: (username: string, password: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const authUser = useStore((s) => s.authUser);
  const authReady = useStore((s) => s.authReady);
  const setAuth = useStore((s) => s.setAuth);
  const clearAuth = useStore((s) => s.clearAuth);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchJson<WhoamiResponse>("/api/auth/whoami");
      setAuth(me);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        clearAuth();
      } else {
        // Network / unknown error — still mark ready so login shows.
        clearAuth();
      }
    }
  }, [setAuth, clearAuth]);

  useEffect(() => {
    if (!authReady) {
      void refresh();
    }
  }, [authReady, refresh]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const me = await fetchJson<{ ok: true; role: AuthRole; username: string }>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username, password }),
        },
      );
      setAuth({ username: me.username, role: me.role });
    },
    [setAuth],
  );

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  const bootstrap = useCallback(
    async (username: string, password: string) => {
      const me = await fetchJson<{ ok: true; role: AuthRole; username: string }>(
        "/api/auth/bootstrap",
        {
          method: "POST",
          body: JSON.stringify({ username, password }),
        },
      );
      setAuth({ username: me.username, role: me.role });
    },
    [setAuth],
  );

  return {
    user: authUser,
    role: authUser?.role ?? null,
    isAuthenticated: authUser !== null,
    isAdmin: authUser?.role === "admin",
    isReady: authReady,
    signIn,
    signOut,
    bootstrap,
    refresh,
  };
}

/** Probe the server to decide whether to show the bootstrap or login screen. */
export async function probeBootstrap(): Promise<boolean> {
  try {
    const r = await fetchJson<BootstrapProbe>("/api/auth/bootstrap");
    return r.bootstrap_required;
  } catch {
    return false;
  }
}
