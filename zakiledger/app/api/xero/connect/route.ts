import { NextResponse } from "next/server";
import { callbackUrl } from "@/lib/config";
import { isXeroConfigured, xeroAuthorizeUrl } from "@/lib/xero";
import { requireUser } from "@/lib/auth";

/**
 * POST/GET /api/xero/connect
 * Starts the Xero OAuth flow: generates a CSRF `state`, stashes it in an
 * httpOnly cookie, and redirects the browser to Xero's authorize URL.
 *
 * In demo mode (no XERO_CLIENT_ID) there's nothing to connect to, so we return a
 * friendly 200 explaining that — consistent with the rest of the app degrading
 * gracefully when keys are absent, rather than erroring.
 */
async function start(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isXeroConfigured()) {
    return NextResponse.json({
      connected: false,
      demo: true,
      message:
        "Xero is not configured. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET to enable the connection.",
    });
  }

  const redirectUri = callbackUrl("/api/xero/callback");
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(xeroAuthorizeUrl(redirectUri, state));
  res.cookies.set("xero_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete the flow
  });
  return res;
}

export async function GET() {
  return start();
}

export async function POST() {
  return start();
}
