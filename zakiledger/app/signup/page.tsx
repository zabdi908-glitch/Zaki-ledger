"use client";

import { useState } from "react";
import { banner, button, card, color, font, input as inputStyleFor, seal } from "@/lib/theme";

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
      const data = await res.json().catch(() => ({}));
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
      <div style={card({ width: "100%", maxWidth: 380, padding: 32 })}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
          <span style={seal(36)}>ZL</span>
          <div style={{ fontSize: 17, fontWeight: 600, color: color.ink, fontFamily: font.display }}>
            Zaki Ledger
          </div>
        </div>

        <h1 style={{ fontSize: 26, margin: "0 0 20px", color: color.ink, fontFamily: font.display, fontWeight: 600 }}>
          Create account
        </h1>

        <form onSubmit={onSubmit}>
          <label style={labelStyle}>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              style={{ ...inputStyleFor(), marginTop: 6 }}
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
              style={{ ...inputStyleFor(), marginTop: 6 }}
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
              style={{ ...inputStyleFor(), marginTop: 6 }}
            />
          </label>

          {error && <p style={banner("bad")}>{error}</p>}

          <button
            type="submit"
            style={busy ? { ...button("primary"), width: "100%", marginTop: 6, opacity: 0.6 } : { ...button("primary"), width: "100%", marginTop: 6 }}
            disabled={busy}
          >
            {busy ? "Creating account…" : "Sign up"}
          </button>
        </form>

        <p style={{ marginTop: 20, fontSize: 13, color: color.inkSoft }}>
          Already have an account?{" "}
          <a href="/login" style={{ color: color.ink, fontWeight: 700 }}>
            Log in
          </a>
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
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: color.inkSoft,
  marginBottom: 16,
};
