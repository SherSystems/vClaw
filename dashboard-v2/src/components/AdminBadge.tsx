// ============================================================
// AdminBadge — RHODES Dashboard
// Small mono "ADMIN" pill rendered next to the username when the
// signed-in operator is an admin. Returns null for viewers.
// Per BRAND_BIBLE small-mono-rectangle pattern: Rhodes Blue text on
// rgba(77,163,247,0.12) bg, 3px radius, mono uppercase.
// ============================================================

import { useStore } from "../store";

export function AdminBadge() {
  const role = useStore((s) => s.authUser?.role ?? null);
  if (role !== "admin") return null;
  return (
    <span
      className="rhodes-admin-badge"
      title="Signed in as administrator"
      aria-label="admin"
    >
      <img
        src="/brand/rhodes-mark-white.svg"
        alt=""
        aria-hidden="true"
        className="rhodes-admin-badge-mark"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      ADMIN
    </span>
  );
}

export default AdminBadge;
