"use client";

import { useState } from "react";
import { button, color, font } from "@/lib/theme";

/**
 * "you@example.com · Logout" — the only shared chrome in the app, rendered by
 * app/layout.tsx only when a session exists. A client component because
 * logout is an action (POST + redirect); the email itself is passed in from
 * the server component that already resolved the session.
 */
export default function AccountBar({ email }: { email: string }) {
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <div style={barStyle}>
      <span style={emailStyle}>{email}</span>
      <button
        onClick={logout}
        disabled={loggingOut}
        style={loggingOut ? { ...button("ghost", "sm"), opacity: 0.6 } : button("ghost", "sm")}
      >
        {loggingOut ? "Logging out…" : "Logout"}
      </button>
    </div>
  );
}

const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 12,
  padding: "10px 24px",
  borderBottom: `1px solid ${color.paperLine}`,
  background: color.paper,
};
const emailStyle: React.CSSProperties = {
  fontSize: 13,
  color: color.inkSoft,
  fontFamily: font.mono,
};
