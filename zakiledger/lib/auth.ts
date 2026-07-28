import type { User } from "@supabase/supabase-js";
import {
  createSupabaseRouteHandlerClient,
  createSupabaseServerComponentClient,
} from "./supabase-server";
import { getSupabase } from "./supabase";

/**
 * The logged-in user for an API route (app/api/**), or null. Every data-
 * touching route calls this first and 401s if it comes back null — see
 * app/api/pending/route.ts for the shape every other route repeats.
 */
export async function requireUser(): Promise<User | null> {
  const supabase = await createSupabaseRouteHandlerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

/**
 * The logged-in user for a Server Component (app/layout.tsx), or null.
 *
 * Unlike requireUser(), this is not a security boundary — it only decides
 * whether to render the cosmetic "you@example.com · Logout" bar, and it runs
 * on every single page (via the root layout), including at build time when
 * Next.js prerenders /login and /signup and SUPABASE_ANON_KEY may not be set
 * yet. So missing config here degrades to "no session" rather than throwing —
 * the middleware and requireUser() are what actually keep pages and API
 * routes locked down.
 */
export async function getSessionUser(): Promise<User | null> {
  try {
    const supabase = await createSupabaseServerComponentClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

/** Tables that carried data before this app had any users to attribute it to. */
const ORPHANABLE_TABLES = [
  "pending_documents",
  "invoices",
  "corrections",
  "confirmations",
  "oauth_connections",
] as const;

/**
 * Give every row nobody owns yet to `userId`, but only when `userId` is
 * genuinely the first account this project has ever had — checked with
 * `auth.admin.listUsers()` on the service-role client, which is the
 * authoritative count regardless of which table's data we're adopting.
 *
 * Called once, right after a successful signup (see
 * app/api/auth/signup/route.ts). The condition is unambiguous and can only be
 * true once, so this is safe to automate rather than requiring a manual
 * migration step — a second signup sees other users already exist and does
 * nothing.
 *
 * Only touches the Postgres path. The in-memory fallback (Supabase not
 * configured) resets on every restart anyway, so there's nothing durable to
 * adopt there — and signup itself requires SUPABASE_URL/SUPABASE_ANON_KEY
 * (see lib/supabase-server.ts), so a deployment with auth enabled but no
 * database is not a case this needs to handle.
 */
export async function adoptOrphanedDataIfFirstUser(userId: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;

  const { data, error } = await db.auth.admin.listUsers();
  if (error) {
    console.warn(`[auth] couldn't check user count for first-signup adoption: ${error.message}`);
    return;
  }
  if (data.users.length !== 1) return; // not the first signup — leave orphaned rows alone

  await Promise.all(
    ORPHANABLE_TABLES.map((table) =>
      db
        .from(table)
        .update({ user_id: userId })
        .is("user_id", null)
        .then(({ error: updateError }) => {
          if (updateError) {
            console.warn(`[auth] first-signup adoption failed for ${table}: ${updateError.message}`);
          }
        }),
    ),
  );
}
