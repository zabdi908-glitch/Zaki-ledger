import { NextResponse } from "next/server";
import { callbackUrl } from "@/lib/config";
import { isQuickBooksConfigured, quickbooksAuthorizeUrl } from "@/lib/quickbooks";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/quickbooks/connect
 * Starts the QuickBooks Online OAuth flow: generates a CSRF `state`, stashes it
 * in an httpOnly cookie, and redirects to Intuit's authorize URL.
 *
 * In demo mode (no QUICKBOOKS_CLIENT_ID) there's nothing to connect to, so we
 * return a friendly 200 rather than erroring.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isQuickBooksConfigured()) {
    return NextResponse.json({
      connected: false,
      demo: true,
      message:
        "QuickBooks is not configured. Set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET to enable the connection.",
    });
  }

  const redirectUri = callbackUrl("/api/quickbooks/callback");
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(quickbooksAuthorizeUrl(redirectUri, state));
  res.cookies.set("quickbooks_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete the flow
  });
  return res;
}
