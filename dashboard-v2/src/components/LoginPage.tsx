// ============================================================
// LoginPage — RHODES Dashboard
// Full-page login + bootstrap flow. Renders when useAuth().isAuthenticated
// is false. Closes security D-3 (HIGH).
// ============================================================

import { useEffect, useState, type FormEvent } from "react";
import { probeBootstrap, useAuth } from "../hooks/useAuth";

export function LoginPage() {
  const { signIn, bootstrap } = useAuth();
  const [bootstrapRequired, setBootstrapRequired] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    probeBootstrap().then((req) => {
      if (!cancelled) setBootstrapRequired(req);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const isBootstrap = bootstrapRequired === true;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim()) {
      setError("Username required.");
      return;
    }
    if (password.length === 0) {
      setError("Password required.");
      return;
    }
    if (isBootstrap) {
      if (password.length < 8) {
        setError("Password must be 8+ characters.");
        return;
      }
      if (password !== confirm) {
        setError("Passwords do not match.");
        return;
      }
    }
    setSubmitting(true);
    try {
      if (isBootstrap) {
        await bootstrap(username.trim(), password);
      } else {
        await signIn(username.trim(), password);
      }
    } catch (err) {
      const msg = (err as Error).message || "Sign-in failed.";
      if (msg === "invalid_credentials") setError("Username or password is incorrect.");
      else if (msg === "rate_limited") setError("Too many attempts. Try again in a few minutes.");
      else if (msg === "already_bootstrapped") setError("Setup already complete. Please sign in.");
      else setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rhodes-login-page">
      <div className="rhodes-login-card">
        <div className="rhodes-login-brand">
          <img
            src="/brand/rhodes-mark-white.svg"
            alt="RHODES"
            className="rhodes-login-mark"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <div className="rhodes-login-wordmark">RHODES</div>
          <div className="rhodes-login-tagline">
            {isBootstrap ? "First-run setup" : "Sign in to continue"}
          </div>
        </div>

        <form className="rhodes-login-form" onSubmit={onSubmit} autoComplete="on">
          <label className="rhodes-login-label">
            <span>Username</span>
            <input
              type="text"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              disabled={submitting}
            />
          </label>

          <label className="rhodes-login-label">
            <span>Password</span>
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isBootstrap ? "new-password" : "current-password"}
              required
              disabled={submitting}
              minLength={isBootstrap ? 8 : undefined}
            />
          </label>

          {isBootstrap && (
            <label className="rhodes-login-label">
              <span>Confirm password</span>
              <input
                type="password"
                name="confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                disabled={submitting}
                minLength={8}
              />
            </label>
          )}

          {error && (
            <div className="rhodes-login-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="rhodes-login-submit" disabled={submitting}>
            {submitting ? "Working…" : isBootstrap ? "Create admin" : "Sign in"}
          </button>

          {isBootstrap && (
            <p className="rhodes-login-help">
              This is the first time anyone has signed in to this RHODES deployment.
              The account you create will be the initial <strong>admin</strong>.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

export default LoginPage;
