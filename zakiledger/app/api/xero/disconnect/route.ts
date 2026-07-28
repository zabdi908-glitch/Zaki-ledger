import { NextResponse } from "next/server";
import { deleteConnection } from "@/lib/oauth-store";

/**
 * POST /api/xero/disconnect
 * Forgets the stored Xero tokens so the accounting section falls back to the
 * radio-button choice screen. Approved invoices simply stop posting anywhere
 * until a platform is reconnected — nothing else in the app depends on this.
 */
export async function POST() {
  await deleteConnection("xero");
  return NextResponse.json({ disconnected: true });
}
