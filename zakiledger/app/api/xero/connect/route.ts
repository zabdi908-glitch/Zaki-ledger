import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/oauth-store";
import { isXeroConfigured, xeroAuthorizeUrl } from "@/lib/xero";

/**
 * POST/GET /api/xero/connect
 * Starts the Xero OAuth flow: generates a CSRF `state`, stashes it in an
 * httpOnly cookie, and redirects the browser to Xero's authorize URL.
 *
 * In demo mode (no XERO_CLIENT_ID) there's nothing to connect to, so we return a
 * friendly 200 explaining that — consistent with the rest of the app degrading
 * gracefully when keys are absent, rather than erroring.
 */
function start(req: NextRequest): NextResponse {
  if (!isXeroConfigured()) {
    return NextResponse.json({
      connected: false,
      demo: true,
      message:
        "Xero is not configured. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET to enable the connection.",
    });
  }

  const redirectUri = `${appBaseUrl(req)}/api/xero/callback`;
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

export async function GET(req: NextRequest) {
  return start(req);
}

export async function POST(req: NextRequest) {
  return start(req);
}
