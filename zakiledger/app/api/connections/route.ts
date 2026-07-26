import { NextResponse } from "next/server";
import { isXeroConfigured, isXeroConnected } from "@/lib/xero";
import { isQuickBooksConfigured, isQuickBooksConnected } from "@/lib/quickbooks";

/**
 * GET /api/connections
 * Read-only connection status for the accounting integrations, so the UI can
 * show a "Connect …" button vs. a "connected" indicator. Never returns tokens —
 * just whether each platform is configured (client id present) and connected (a
 * stored token exists).
 */
export async function GET() {
  const [xero, quickbooks] = await Promise.all([isXeroConnected(), isQuickBooksConnected()]);
  return NextResponse.json({
    xero: { configured: isXeroConfigured(), connected: xero },
    quickbooks: { configured: isQuickBooksConfigured(), connected: quickbooks },
  });
}
