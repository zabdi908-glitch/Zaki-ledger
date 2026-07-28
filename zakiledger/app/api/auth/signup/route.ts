import { NextRequest, NextResponse } from "next/server";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase-server";
import { adoptOrphanedDataIfFirstUser } from "@/lib/auth";

/**
 * POST /api/auth/signup
 * Body: { email, password }
 *
 * Signup logs the user straight in — "Confirm email" must be turned off in the
 * Supabase Auth dashboard settings for that (see README/deployment notes), same
 * as this app's existing philosophy of no unnecessary steps between an action
 * and seeing its result.
 *
 * Right after a successful signup, checks whether this is the very first
 * account this project has ever had and, if so, adopts every pre-auth row that
 * has no owner yet — see lib/auth.ts for why that's safe to automate.
 */
export async function POST(req: NextRequest) {
  const { email, password } = (await req.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const supabase = await createSupabaseRouteHandlerClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data.user) {
    // "Confirm email" is still on in the Supabase dashboard — signUp succeeded
    // but there's no session yet, so the account exists without being logged in.
    return NextResponse.json(
      { error: "Account created, but email confirmation is required before you can log in." },
      { status: 400 },
    );
  }

  await adoptOrphanedDataIfFirstUser(data.user.id);

  return NextResponse.json({ ok: true });
}
