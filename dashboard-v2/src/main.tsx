import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import LoginPage from "./components/LoginPage";
import { useAuth } from "./hooks/useAuth";
import "./styles/index.css";

/**
 * Auth gate. Closes security D-3 (HIGH) — the dashboard now renders the
 * login page until /api/auth/whoami returns a valid session. While the
 * initial whoami call is in flight we render a minimal splash to avoid
 * flashing the login screen for a returning operator.
 */
function Root() {
  const { isAuthenticated, isReady } = useAuth();
  if (!isReady) {
    return (
      <div className="rhodes-auth-splash" aria-live="polite">
        <div className="rhodes-auth-splash-mark">RHODES</div>
      </div>
    );
  }
  if (!isAuthenticated) {
    return <LoginPage />;
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
