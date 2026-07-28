import { NextResponse } from "next/server";
import { xeroConnectionStatus } from "@/lib/xero";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/auth/xero/status
 * The live connection status: not just "a token is stored" but "the token was
 * just proven to work" — see xeroConnectionStatus(). Never returns the token
 * itself, only whether it's usable and the organisation it's connected to.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const status = await xeroConnectionStatus(user.id);
  return NextResponse.json(status);
}
