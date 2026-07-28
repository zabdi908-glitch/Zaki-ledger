"use client";

import { useState } from "react";

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
      <button onClick={logout} disabled={loggingOut} style={btnStyle}>
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
  padding: "10px 20px",
  borderBottom: "1px solid #e6eaee",
  background: "#fff",
};
const emailStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#8892a0",
};
const btnStyle: React.CSSProperties = {
  padding: "5px 12px",
  background: "#fff",
  color: "#1a2b4a",
  border: "1px solid #d5dbdb",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 12,
};
