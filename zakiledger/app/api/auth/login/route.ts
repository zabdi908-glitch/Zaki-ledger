import { NextRequest, NextResponse } from "next/server";
import {
  clearSupabaseRouteHandlerSession,
  createSupabaseRouteHandlerClient,
} from "@/lib/supabase-server";

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
export async function POST(req: NextRequest) {
  const { email, password } = (await req.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const supabase = await createSupabaseRouteHandlerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });

  // This is intentionally after sign-in, never at signup: the RPC derives the
  // target solely from the authenticated session and is idempotent, so a retry
  // after a transient response failure cannot duplicate a canonical tenant.
  const { error: bootstrapError } = await supabase.rpc("ensure_default_tenant_for_self_v1");
  if (bootstrapError) {
    console.error(`[auth] default canonical tenant bootstrap failed: ${bootstrapError.message}`);

    // signInWithPassword has already persisted a session at this point. Revoke
    // it and always expire its browser cookies before reporting login failure.
    // Local cookie expiry is intentionally attempted even if remote sign-out
    // fails, so the failed response cannot leave a usable browser session.
    try {
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) {
        console.error(`[auth] session revocation after bootstrap failure failed: ${signOutError.message}`);
      }
    } catch (signOutError) {
      console.error("[auth] session revocation after bootstrap failure threw", signOutError);
    }

    try {
      await clearSupabaseRouteHandlerSession();
    } catch (cookieClearError) {
      // Do not claim the login succeeded if response-cookie mutation is
      // unavailable. This is diagnostic-only and never exposes auth details.
      console.error("[auth] session cookie clearing after bootstrap failure failed", cookieClearError);
    }

    return NextResponse.json(
      { error: "Signed in, but account setup could not be completed. Please try again." },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true });
}
