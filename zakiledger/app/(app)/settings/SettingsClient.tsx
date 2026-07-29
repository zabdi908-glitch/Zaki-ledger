"use client";

import { useEffect, useState } from "react";
import { useShellToast } from "@/components/AppShell";
import { pageSubtitle, pageTitle, shellButton, shellCard, shellColor, shellFigures } from "@/lib/shell-theme";

type ConfiguredStatus = { xero: { configured: boolean }; quickbooks: { configured: boolean }; demo?: boolean };
type LiveStatus = { connected: boolean; accountName?: string } | null;
type Provider = "xero" | "quickbooks";

type AuditRow = { date: string; action: string; user: string; change: string };

const PROVIDER_LABEL: Record<Provider, string> = { xero: "Xero", quickbooks: "QuickBooks" };
const PROVIDER_CONNECT_PATH: Record<Provider, string> = { xero: "/api/xero/connect", quickbooks: "/api/quickbooks/connect" };

/**
 * Settings — Account (real email, no fabricated "plan"), accounting
 * integration (real connect/disconnect, ported from the old app/page.tsx's
 * AccountingConnection — one provider at a time, same as before), Audit log
 * (real corrections + reconciliation approvals merged), Sign out.
 */
export default function SettingsClient({ email }: { email: string }) {
  const showToast = useShellToast();
  const [configured, setConfigured] = useState<ConfiguredStatus | null>(null);
  const [xeroStatus, setXeroStatus] = useState<LiveStatus>(null);
  const [qboStatus, setQboStatus] = useState<LiveStatus>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<Provider | null>(null);
  const [disconnecting, setDisconnecting] = useState<Provider | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  useEffect(() => {
    fetch("/api/connections")
      .then((r) => r.json())
      .then(setConfigured)
      .catch(() => {});
    refreshAccountingStatus();
    loadAudit();
  }, []);

  async function refreshAccountingStatus() {
    const check = async (path: string): Promise<LiveStatus> => {
      try {
        const res = await fetch(path);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    };
    const [xero, qbo] = await Promise.all([check("/api/auth/xero/status"), check("/api/auth/quickbooks/status")]);
    if (xero) setXeroStatus(xero);
    if (qbo) setQboStatus(qbo);
  }

  async function loadAudit() {
    try {
      const [correctionsRes, reconRes] = await Promise.all([fetch("/api/corrections"), fetch("/api/reconciliation/audit")]);
      const correctionsData = correctionsRes.ok ? await correctionsRes.json() : { corrections: [] };
      const reconData = reconRes.ok ? await reconRes.json() : { matches: [] };
      const rows: AuditRow[] = [
        ...correctionsData.corrections.map((c: { createdAt: string; field: string; supplierName: string; aiValue: string; humanValue: string }) => ({
          date: c.createdAt,
          action: "Corrected field",
          user: "You",
          change: `${c.supplierName} — ${c.field}: "${c.aiValue}" → "${c.humanValue}"`,
        })),
        ...reconData.matches.map((m: { approvedAt: string }) => ({
          date: m.approvedAt,
          action: "Approved match",
          user: "You",
          change: "Bank transaction reconciled",
        })),
      ]
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, 12);
      setAudit(rows);
    } catch {
      /* the audit log is a nice-to-have; the rest of Settings works regardless */
    }
  }

  async function disconnect(provider: Provider) {
    setDisconnecting(provider);
    try {
      await fetch(`/api/${provider}/disconnect`, { method: "POST" });
      showToast(`${PROVIDER_LABEL[provider]} disconnected`);
    } finally {
      setDisconnecting(null);
      setConfirmingDisconnect(null);
      await refreshAccountingStatus();
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const statusByProvider: Record<Provider, LiveStatus> = { xero: xeroStatus, quickbooks: qboStatus };
  const connectedProvider = (["xero", "quickbooks"] as Provider[]).find((p) => statusByProvider[p]?.connected) ?? null;

  return (
    <div>
      <h1 style={pageTitle}>Settings</h1>
      <p style={pageSubtitle}>Account, integrations, and audit history</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div style={shellCard({ padding: 24 })}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 16px" }}>Account</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 14 }}>
            <Row label="Email" value={email ?? "—"} />
          </div>
        </div>

        <div style={shellCard({ padding: 24 })}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 16px" }}>Accounting integration</h3>
          {!configured || !xeroStatus || !qboStatus ? (
            <div style={{ fontSize: 13.5, color: shellColor.inkFaint }}>Checking…</div>
          ) : connectedProvider ? (
            confirmingDisconnect === connectedProvider ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <p style={{ margin: 0, fontSize: 13.5, color: shellColor.low }}>
                  Disconnect {PROVIDER_LABEL[connectedProvider]}? Approved invoices will stop posting there until you reconnect.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    style={disconnecting === connectedProvider ? { ...shellButton("dangerOutline"), opacity: 0.6 } : shellButton("dangerOutline")}
                    disabled={disconnecting === connectedProvider}
                    onClick={() => disconnect(connectedProvider)}
                  >
                    {disconnecting === connectedProvider ? "Disconnecting…" : "Yes, disconnect"}
                  </button>
                  <button style={shellButton("outline")} onClick={() => setConfirmingDisconnect(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 700, color: "oklch(45% 0.14 155)", marginBottom: 4 }}>
                    {PROVIDER_LABEL[connectedProvider]} Connected ✓
                    {statusByProvider[connectedProvider]?.accountName ? ` (${statusByProvider[connectedProvider]!.accountName})` : ""}
                  </div>
                </div>
                <button style={shellButton("outline")} onClick={() => setConfirmingDisconnect(connectedProvider)}>
                  Disconnect
                </button>
              </div>
            )
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontWeight: 700, color: shellColor.inkFaint }}>Disconnected</div>
              {(["xero", "quickbooks"] as Provider[]).map((p) =>
                configured[p].configured ? (
                  <a key={p} href={PROVIDER_CONNECT_PATH[p]} style={{ ...shellButton("outline"), textDecoration: "none", textAlign: "left" }}>
                    Connect {PROVIDER_LABEL[p]}
                  </a>
                ) : null,
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ ...shellCard({ padding: 24 }), marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 16px" }}>Audit log</h3>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {audit.map((row, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "1.2fr 1.3fr 1fr 2fr",
                gap: 16,
                padding: "12px 0",
                borderBottom: `1px solid ${shellColor.trackBg}`,
                fontSize: 13.5,
              }}
            >
              <div style={{ ...shellFigures, color: shellColor.inkSoft }}>{new Date(row.date).toLocaleString()}</div>
              <div style={{ fontWeight: 600 }}>{row.action}</div>
              <div style={{ color: shellColor.inkSoft }}>{row.user}</div>
              <div style={{ color: shellColor.inkFainter }}>{row.change}</div>
            </div>
          ))}
          {audit.length === 0 && <div style={{ fontSize: 13.5, color: shellColor.inkFaint, padding: "8px 0" }}>Nothing recorded yet.</div>}
        </div>
      </div>

      <button style={shellButton("dangerOutline")} onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: shellColor.inkSoft }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
