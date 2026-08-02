import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { classifyMerchant, type MerchantAiCategory } from "@/lib/merchant-ai";
import { cacheCategory, getCachedCategories } from "@/lib/merchant-ai-cache";
import { z } from "zod/v4";

const BodySchema = z.object({
  merchantNames: z.array(z.string()).max(50),
});

/**
 * POST /api/reconciliation/classify-merchants { merchantNames } ->
 * { categories: Record<string, MerchantAiCategory> }
 *
 * The AI fallback tier for lib/reconciliation-insights.ts's suggestCategory:
 * classifies merchants the hardcoded table (lib/merchant-categories.ts)
 * doesn't recognise, via a global cache (lib/merchant-ai-cache.ts) so no
 * merchant is ever classified by Anthropic more than once. Beyond request
 * validation, this always returns 200 — a merchant that fails to classify
 * (Anthropic down, rate-limited, misconfigured key) is simply absent from
 * the response, and the caller already treats "no entry" as "stays
 * Uncategorised."
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let names: string[];
  try {
    const body = BodySchema.parse(await req.json());
    names = [...new Set(body.merchantNames.map((n) => n.trim()).filter(Boolean))];
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (names.length === 0) return NextResponse.json({ categories: {} });

  try {
    const cached = await getCachedCategories(names);
    const misses = names.filter((n) => !cached.has(n.toLowerCase()));

    const classified = await Promise.all(
      misses.map(async (name) => ({ name, result: await classifyMerchant(name) })),
    );

    const categories: Record<string, MerchantAiCategory> = {};
    for (const [key, value] of cached) categories[key] = value;

    for (const { name, result } of classified) {
      if (!result) continue;
      categories[name.toLowerCase()] = result;
      try {
        await cacheCategory(name, result);
      } catch (err) {
        console.warn(`failed to cache AI category for "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return NextResponse.json({ categories });
  } catch (err) {
    console.warn(`classify-merchants failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ categories: {} });
  }
}
