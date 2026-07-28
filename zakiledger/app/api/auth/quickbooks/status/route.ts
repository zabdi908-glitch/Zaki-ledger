import { NextResponse } from "next/server";
import { quickBooksConnectionStatus } from "@/lib/quickbooks";

/**
 * GET /api/auth/quickbooks/status
 * The live connection status: not just "a token is stored" but "the token was
 * just proven to work" — see quickBooksConnectionStatus(). Never returns the
 * token itself, only whether it's usable and the company it's connected to.
 */
export async function GET() {
  const status = await quickBooksConnectionStatus();
  return NextResponse.json(status);
}
