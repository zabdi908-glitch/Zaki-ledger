import { getSupabase } from "./supabase";
import type { MerchantAiCategory } from "./merchant-ai";

/**
 * Global cache for AI-classified merchant categories (Anthropic fallback, see
 * lib/merchant-ai.ts). Deliberately not scoped to user_id — GL_CATEGORIES is
 * a fixed shared enum, not a per-user chart of accounts, so every user
 * benefits from a merchant classified once by anyone. Follows the same
 * Supabase-or-in-memory pattern as lib/decision-store.ts.
 */

interface MemEntry extends MerchantAiCategory {
  merchantName: string;
}

const globalForMerchantAi = globalThis as unknown as {
  __zakiLedgerMerchantAiCache?: MemEntry[];
};
const mem = (globalForMerchantAi.__zakiLedgerMerchantAiCache ??= []);

export function __clearMerchantAiCacheForTests(): void {
  mem.length = 0;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export async function getCachedCategories(names: string[]): Promise<Map<string, MerchantAiCategory>> {
  const keys = [...new Set(names.map(normalize).filter(Boolean))];
  const result = new Map<string, MerchantAiCategory>();
  if (keys.length === 0) return result;

  const db = getSupabase();
  if (!db) {
    for (const entry of mem) {
      if (keys.includes(entry.merchantName)) {
        result.set(entry.merchantName, { category: entry.category, confidencePct: entry.confidencePct, reason: entry.reason });
      }
    }
    return result;
  }

  const { data, error } = await db.from("merchant_ai_categories").select().in("merchant_name", keys);
  if (error) throw new Error(`Failed to load AI merchant cache: ${error.message}`);
  for (const row of data ?? []) {
    result.set(row.merchant_name as string, {
      category: row.category as string,
      confidencePct: Number(row.confidence_pct ?? 0),
      reason: row.reason as string,
    });
  }
  return result;
}

export async function cacheCategory(merchantName: string, result: MerchantAiCategory): Promise<void> {
  const key = normalize(merchantName);
  if (!key) return;

  const db = getSupabase();
  if (!db) {
    if (!mem.some((e) => e.merchantName === key)) mem.push({ merchantName: key, ...result });
    return;
  }

  const { error } = await db.from("merchant_ai_categories").insert({
    merchant_name: key,
    category: result.category,
    confidence_pct: result.confidencePct,
    reason: result.reason,
  });
  // A concurrent classify-merchants request may have already cached this
  // merchant between our read and this write; the primary key turns that
  // race into a harmless duplicate-key error, not a real failure.
  if (error && !/duplicate key/i.test(error.message)) {
    throw new Error(`Failed to cache AI merchant category: ${error.message}`);
  }
}
