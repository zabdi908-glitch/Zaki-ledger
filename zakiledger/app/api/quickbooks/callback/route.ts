import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl, callbackUrl } from "@/lib/config";
import { saveConnection } from "@/lib/oauth-store";
import { exchangeQuickBooksCode, isQuickBooksConfigured } from "@/lib/quickbooks";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/quickbooks/callback
 * Intuit redirects here with `code`, `state`, and `realmId` (the company id). We
 * verify state against the cookie, exchange the code for tokens, and store the
 * tokens together with the realmId — which every subsequent API call needs.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isQuickBooksConfigured()) {
    return NextResponse.json({ error: "QuickBooks is not configured." }, { status: 400 });
  }

  const url = req.nextUrl;
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.json(
      { error: `QuickBooks authorization failed: ${error}` },
      { status: 400 },
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  const expectedState = req.cookies.get("quickbooks_oauth_state")?.value;

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code." }, { status: 400 });
  }
  if (!realmId) {
    return NextResponse.json({ error: "Missing realmId (company id)." }, { status: 400 });
  }
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  try {
    const redirectUri = callbackUrl("/api/quickbooks/callback");
    const tokens = await exchangeQuickBooksCode(code, redirectUri);
    await saveConnection(user.id, "quickbooks", tokens, realmId);

    const res = NextResponse.redirect(`${appBaseUrl()}/?connected=quickbooks`);
    res.cookies.delete("quickbooks_oauth_state");
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "QuickBooks connection failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
