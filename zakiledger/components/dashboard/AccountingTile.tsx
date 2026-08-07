import { quickBooksConnectionStatus } from "@/lib/quickbooks";
import { xeroConnectionStatus } from "@/lib/xero";
import { shellColor } from "@/lib/shell-theme";
import { getSessionUser } from "@/lib/auth";

export default async function AccountingTile() {
  const user = await getSessionUser();
  const userId = user?.id ?? "demo-user";

  const [qbo, xero] = await Promise.all([
    quickBooksConnectionStatus(userId).catch(() => ({ connected: false })),
    xeroConnectionStatus(userId).catch(() => ({ connected: false })),
  ]);

  const connected = qbo.connected || xero.connected;

  return (
    <div style={{ background: shellColor.paper, border: `1px solid ${shellColor.cardBorder}`, borderRadius: 10, padding: 20 }}>
      <div style={{ fontSize: 13, color: shellColor.inkSoft, marginBottom: 8 }}>Accounting</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: connected ? "oklch(50% 0.14 155)" : shellColor.inkFaint, marginTop: 4 }}>
        {connected ? "Connected ✓" : "Not connected"}
      </div>
    </div>
  );
}