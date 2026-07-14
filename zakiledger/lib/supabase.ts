import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase access for Zaki Ledger.
 *
 * These API routes run on the server, so we use the **service-role** key (writes
 * bypass RLS). Never expose this key to the browser.
 *
 * If the environment isn't configured, `getSupabase()` returns null and callers
 * fall back to the in-memory store — so the skeleton still runs end-to-end
 * without a database, exactly as the README promises. Wire real keys to persist.
 */
let cached: SupabaseClient | null | undefined;

export function getSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    cached = null;
    return cached;
  }

  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

/** True when real Supabase credentials are present (i.e. not in fallback mode). */
export function isSupabaseConfigured(): boolean {
  return getSupabase() !== null;
}
