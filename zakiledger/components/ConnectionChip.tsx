"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { pill, shellColor } from "@/lib/shell-theme";

export type ConnectedProvider = "xero" | "quickbooks" | null | "loading";

/**
 * One answer to "where will this post?", shown on every reconciliation
 * screen. The status endpoints are cheap (a store lookup), so each mount
 * fetches fresh rather than sharing state across pages.
 */
export function useConnectedProvider(): ConnectedProvider {
  const [provider, setProvider] = useState<ConnectedProvider>("loading");
  useEffect(() => {
    Promise.all([
      fetch("/api/auth/xero/status").then((r) => (r.ok ? r.json() : { connected: false })),
      fetch("/api/auth/quickbooks/status").then((r) => (r.ok ? r.json() : { connected: false })),
    ])
      .then(([xero, qbo]) => setProvider(xero.connected ? "xero" : qbo.connected ? "quickbooks" : null))
      .catch(() => setProvider(null));
  }, []);
  return provider;
}

export default function ConnectionChip() {
  const provider = useConnectedProvider();
  if (provider === "loading") return null;
  const label =
    provider === "xero" ? "Connected to Xero" :
    provider === "quickbooks" ? "Connected to QuickBooks" :
    "No accounting connection — CSV import mode";
  const color = provider ? shellColor.high : shellColor.medium;
  const bg = provider ? shellColor.highBg : shellColor.trackBg;
  return (
    <div style={{ margin: "0 0 16px", display: "flex", alignItems: "center", gap: 10 }}>
      <span style={pill(color, bg)}>{label}</span>
      {!provider && (
        <Link href="/settings" style={{ fontSize: 12.5, color: shellColor.inkSoft }}>
          Connect in Settings →
        </Link>
      )}
    </div>
  );
}
