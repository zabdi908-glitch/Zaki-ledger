"use client";

import { useState } from "react";

/**
 * Only ever redirect somewhere inside this app. `next` comes straight from the
 * URL — middleware only ever sets it to a pathname, but nothing stops a
 * crafted link (`/login?next=https://evil.example`) from using a real login
 * to send the browser to an attacker's page right after it. A single leading
 * slash (and not two — `//evil.example` is browser-speak for "same scheme,
 * different host") is what makes a path same-origin.
 */
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

/**
 * Email + password login. Plain fetch to /api/auth/login (not a client-side
 * Supabase call) — same convention as the rest of this app, which talks to its
 * own API routes rather than calling third-party SDKs from the browser.
 *
 * Redirects to whatever page the middleware bounced the user FROM (`?next=`),
 * so a direct link to /pending while logged out lands back on /pending after
 * signing in, not always on the home page.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Login failed.");
        return;
      }
      window.location.href = safeNext(new URLSearchParams(window.location.search).get("next"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={mainStyle}>
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <span style={markStyle}>ZL</span>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#1a2b4a" }}>Zaki Ledger</div>
        </div>

        <h1 style={{ fontSize: 20, margin: "0 0 16px", color: "#1a2b4a" }}>Log in</h1>

        <form onSubmit={onSubmit}>
          <label style={labelStyle}>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={inputStyle}
            />
          </label>

          {error && <p style={errorStyle}>{error}</p>}

          <button type="submit" style={busy ? { ...btnStyle, opacity: 0.6 } : btnStyle} disabled={busy}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>

        <p style={{ marginTop: 16, fontSize: 13, color: "#8892a0" }}>
          Don&apos;t have an account? <a href="/signup" style={linkStyle}>Sign up</a>
        </p>
      </div>
    </main>
  );
}

const mainStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px",
};
const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 360,
  padding: 28,
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  border: "1px solid #eef1f4",
};
const markStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: "#1a2b4a",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 700,
  fontSize: 13,
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#556",
  marginBottom: 14,
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 6,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #d5dbdb",
  fontSize: 14,
  fontFamily: "inherit",
  boxSizing: "border-box",
};
const btnStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 22px",
  background: "#1a2b4a",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 15,
  marginTop: 4,
};
const errorStyle: React.CSSProperties = {
  margin: "0 0 14px",
  padding: "10px 14px",
  background: "#fdecea",
  border: "1px solid #e6b0aa",
  borderRadius: 8,
  color: "#c0392b",
  fontSize: 13,
};
const linkStyle: React.CSSProperties = { color: "#1a2b4a", fontWeight: 600 };
