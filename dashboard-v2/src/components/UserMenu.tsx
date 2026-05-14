// ============================================================
// UserMenu — RHODES Dashboard
// Small username display + sign-out for the header. Reads role +
// username from the auth store. Returns null when unauthenticated.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useAuth } from "../hooks/useAuth";
import AdminBadge from "./AdminBadge";

export function UserMenu() {
  const user = useStore((s) => s.authUser);
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!user) return null;

  return (
    <div className="rhodes-user-menu" ref={containerRef}>
      <button
        type="button"
        className="rhodes-user-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <AdminBadge />
        <span className="rhodes-user-menu-name">{user.username}</span>
        <span aria-hidden="true" className="rhodes-user-menu-caret">
          ▾
        </span>
      </button>
      {open && (
        <div role="menu" className="rhodes-user-menu-popover">
          <div className="rhodes-user-menu-meta">
            <div className="rhodes-user-menu-meta-row">
              <span className="rhodes-user-menu-meta-key">USER</span>
              <span className="rhodes-user-menu-meta-val">{user.username}</span>
            </div>
            <div className="rhodes-user-menu-meta-row">
              <span className="rhodes-user-menu-meta-key">ROLE</span>
              <span className="rhodes-user-menu-meta-val">{user.role}</span>
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="rhodes-user-menu-item"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default UserMenu;
