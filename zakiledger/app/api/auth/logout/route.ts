import { NextResponse } from "next/server";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase-server";

/** POST /api/auth/logout — clears the session cookies. */
export async function POST() {
  const supabase = await createSupabaseRouteHandlerClient();
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
