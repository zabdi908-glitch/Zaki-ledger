"use client";

import { useState } from "react";
import { banner, button, card, color, eyebrow, font, input as inputStyleFor, seal } from "@/lib/theme";

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
      const data = await res.json().catch(() => ({}));
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
      <div style={card({ width: "100%", maxWidth: 380, padding: 32 })}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
          <span style={seal(36)}>ZL</span>
          <div style={{ fontSize: 17, fontWeight: 600, color: color.ink, fontFamily: font.display }}>
            Zaki Ledger
          </div>
        </div>

        <h1 style={{ fontSize: 26, margin: "0 0 20px", color: color.ink, fontFamily: font.display, fontWeight: 600 }}>
          Log in
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
              style={{ ...inputStyleFor(), marginTop: 6 }}
            />
          </label>

          {error && <p style={banner("bad")}>{error}</p>}

          <button
            type="submit"
            style={busy ? { ...button("primary"), width: "100%", marginTop: 6, opacity: 0.6 } : { ...button("primary"), width: "100%", marginTop: 6 }}
            disabled={busy}
          >
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>

        <p style={{ marginTop: 20, fontSize: 13, color: color.inkSoft }}>
          Don&apos;t have an account?{" "}
          <a href="/signup" style={{ color: color.ink, fontWeight: 700 }}>
            Sign up
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
