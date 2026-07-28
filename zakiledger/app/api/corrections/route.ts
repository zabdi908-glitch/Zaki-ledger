import { NextResponse } from "next/server";
import { recentCorrections } from "@/lib/store";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/corrections
 * Returns the correction ledger (most recent first) — the audit trail AND the
 * training data. Works in demo/in-memory mode and against Supabase alike.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const corrections = await recentCorrections(user.id, 100);
    // recentCorrections is chronological (oldest→newest); show newest first.
    return NextResponse.json({ corrections: corrections.reverse() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load corrections.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
