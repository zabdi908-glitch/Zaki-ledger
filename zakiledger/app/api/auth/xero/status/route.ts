import { NextResponse } from "next/server";
import { xeroConnectionStatus } from "@/lib/xero";

/**
 * GET /api/auth/xero/status
 * The live connection status: not just "a token is stored" but "the token was
 * just proven to work" — see xeroConnectionStatus(). Never returns the token
 * itself, only whether it's usable and the organisation it's connected to.
 */
export async function GET() {
  const status = await xeroConnectionStatus();
  return NextResponse.json(status);
}
