"use client";

import { useState } from "react";

/**
 * Email + password signup. Logs the user straight in on success — no
 * "check your email" step, which requires "Confirm email" to be turned off in
 * the Supabase Auth dashboard settings (see deployment notes). Email
 * verification is a deliberately deferred nice-to-have, not an oversight.
 */
export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Signup failed.");
        return;
      }
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Signup failed.");
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

        <h1 style={{ fontSize: 20, margin: "0 0 16px", color: "#1a2b4a" }}>Create account</h1>

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
              minLength={6}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={6}
              style={inputStyle}
            />
          </label>

          {error && <p style={errorStyle}>{error}</p>}

          <button type="submit" style={busy ? { ...btnStyle, opacity: 0.6 } : btnStyle} disabled={busy}>
            {busy ? "Creating account…" : "Sign up"}
          </button>
        </form>

        <p style={{ marginTop: 16, fontSize: 13, color: "#8892a0" }}>
          Already have an account? <a href="/login" style={linkStyle}>Log in</a>
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
