import { NextRequest, NextResponse } from "next/server";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase-server";

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
  return NextResponse.json({ ok: true });
}
