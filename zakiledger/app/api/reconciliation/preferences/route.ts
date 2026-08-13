import { NextRequest, NextResponse } from "next/server";
import { getMerchantPreferences, setMerchantDefault } from "@/lib/decision-store";
import { requireUser } from "@/lib/auth";
import { isReconciliationWriteFrozen, reconciliationFreezeResponse } from "@/lib/reconciliation-freeze";
import { z } from "zod/v4";

const BodySchema = z.object({
  merchantName: z.string().min(1),
  category: z.string().min(1),
});

/**
 * GET /api/reconciliation/preferences -> { preferences: MerchantPreference[] }
 * POST /api/reconciliation/preferences { merchantName, category } -> sets a default
 *
 * Backs the review page's learned-category resolution (lib/reconciliation-insights.ts)
 * and the one-click "set as default for this merchant" override.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const preferences = await getMerchantPreferences(user.id);
  return NextResponse.json({ preferences });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isReconciliationWriteFrozen()) return reconciliationFreezeResponse();

  try {
    const body = BodySchema.parse(await req.json());
    await setMerchantDefault(user.id, body.merchantName, body.category);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to set merchant default.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
