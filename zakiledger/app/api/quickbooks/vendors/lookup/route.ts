import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  createQuickBooksVendorLookupService,
  QuickBooksVendorLookupError,
} from "@/lib/quickbooks-vendor-lookup";

const MAX_DISPLAY_NAME_LENGTH = 100;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const QUICKBOOKS_REALM = /^\d{1,32}$/;

function requiredQueryValue(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)?.trim();
  return value || null;
}

/** Exact, authenticated, tenant-scoped QuickBooks Vendor lookup. GET only. */
export async function GET(request: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const clientEntityId = requiredQueryValue(url, "clientEntityId");
  const providerConnectionId = requiredQueryValue(url, "providerConnectionId");
  const realm = requiredQueryValue(url, "realm");
  const displayName = requiredQueryValue(url, "displayName");
  if (!clientEntityId || !providerConnectionId || !realm || !displayName ||
      !UUID.test(clientEntityId) || !UUID.test(providerConnectionId) || !QUICKBOOKS_REALM.test(realm) ||
      displayName.length > MAX_DISPLAY_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(displayName)) {
    return NextResponse.json({ error: "Invalid Vendor lookup parameters" }, { status: 400 });
  }

  try {
    const result = await createQuickBooksVendorLookupService().lookup({
      userId: user.id,
      clientEntityId,
      providerConnectionId,
      realm,
      displayName,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof QuickBooksVendorLookupError) {
      const status = error.code === "FORBIDDEN" ? 403
        : error.code === "DESTINATION_NOT_FOUND" ? 404
        : error.code === "AMBIGUOUS_EXACT_MATCH" ? 409
        : 502;
      return NextResponse.json({ error: error.code }, { status });
    }
    return NextResponse.json({ error: "VENDOR_LOOKUP_UNAVAILABLE" }, { status: 503 });
  }
}
