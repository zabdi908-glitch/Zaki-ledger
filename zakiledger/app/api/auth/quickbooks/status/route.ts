import { NextResponse } from "next/server";
import { quickBooksConnectionStatus } from "@/lib/quickbooks";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/auth/quickbooks/status
 * The live connection status: not just "a token is stored" but "the token was
 * just proven to work" — see quickBooksConnectionStatus(). Never returns the
 * token itself, only whether it's usable and the company it's connected to.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const status = await quickBooksConnectionStatus(user.id);
  return NextResponse.json(status);
}
