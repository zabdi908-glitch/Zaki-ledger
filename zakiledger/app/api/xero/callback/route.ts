import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl, callbackUrl } from "@/lib/config";
import { saveConnection } from "@/lib/oauth-store";
import { exchangeXeroCode, fetchXeroTenantId, isXeroConfigured } from "@/lib/xero";

/**
 * GET /api/xero/callback
 * Xero redirects here with `code` and `state`. We verify the state against the
 * cookie set in /connect, exchange the code for access + refresh tokens, then
 * call /connections to capture the tenantId and store everything.
 */
export async function GET(req: NextRequest) {
  if (!isXeroConfigured()) {
    return NextResponse.json({ error: "Xero is not configured." }, { status: 400 });
  }

  const url = req.nextUrl;
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.json({ error: `Xero authorization failed: ${error}` }, { status: 400 });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = req.cookies.get("xero_oauth_state")?.value;

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code." }, { status: 400 });
  }
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  try {
    const redirectUri = callbackUrl("/api/xero/callback");
    const tokens = await exchangeXeroCode(code, redirectUri);
    const tenantId = await fetchXeroTenantId(tokens.accessToken);
    await saveConnection("xero", tokens, tenantId);

    // Land the user back on the app with a success flag; clear the state cookie.
    const res = NextResponse.redirect(`${appBaseUrl()}/?connected=xero`);
    res.cookies.delete("xero_oauth_state");
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Xero connection failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
