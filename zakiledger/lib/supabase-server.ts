import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Anon-key, cookie-aware Supabase clients — used ONLY to answer "who is making
 * this request" (`supabase.auth.getUser()`) and to run the actual auth calls
 * (signUp/signInWithPassword/signOut). Data reads/writes still go through the
 * service-role client in lib/supabase.ts, with an explicit userId filter — see
 * lib/auth.ts and the callers in app/api/**.
 *
 * Unlike lib/supabase.ts, there is no graceful in-memory fallback here: the rest
 * of the app degrades to an in-memory store when Supabase isn't configured, but
 * auth silently "degrading" to no-auth would defeat the point of it. Missing
 * config throws, on purpose, the first time anything tries to use it.
 */
function requiredEnv(): { url: string; anonKey: string } {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Auth requires SUPABASE_URL and SUPABASE_ANON_KEY to be set — this app has no anonymous mode.",
    );
  }
  return { url, anonKey };
}

/**
 * For Route Handlers (app/api/**): reads AND writes session cookies via
 * next/headers — Route Handlers are one of the two contexts (with Server
 * Actions) Next.js allows to mutate cookies. Any refresh `getUser()` performs,
 * and the session `signUp`/`signInWithPassword`/`signOut` set, land in the
 * response automatically — nothing to attach manually.
 */
export async function createSupabaseRouteHandlerClient() {
  const { url, anonKey } = requiredEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}

/**
 * For Server Components (e.g. app/layout.tsx): read-only, since Server
 * Components can't set cookies — calling `cookieStore.set()` there throws.
 * That's fine: middleware.ts already refreshes the session on every request
 * before any Server Component renders, so nothing here needs to persist one.
 */
export async function createSupabaseServerComponentClient() {
  const { url, anonKey } = requiredEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        /* Server Components can't set cookies — see doc comment above. */
      },
    },
  });
}
