import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Page-level auth gate. Protects every page (everything under app/(app) —
 * Dashboard, Upload/Review/Batch, Reconciliation, Settings — plus anything
 * added later) by redirecting to `/login` when there's no session, and
 * refreshes the session cookie on every request — required by
 * @supabase/ssr, since access tokens are short-lived and nothing else in a
 * page-only request would trigger a refresh.
 *
 * API routes are NOT gated here — each one calls requireUser() itself (see
 * lib/auth.ts). That keeps "which routes require auth" auditable with one
 * grep instead of split across middleware and per-route checks, and it means
 * a route handler always gets a real, freshly-verified user rather than
 * trusting whatever middleware decided upstream.
 */
const PUBLIC_PATHS = new Set(["/login", "/signup"]);

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Auth isn't configured — nothing to gate yet. Every API route still
    // throws the moment it needs auth (lib/supabase-server.ts), so this is
    // only reachable in local dev before SUPABASE_ANON_KEY is set, not a
    // silent bypass in a real deployment.
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        // The standard @supabase/ssr middleware dance: mutate the request's
        // cookies so downstream code sees the refreshed session, then rebuild
        // the response from that request so the same cookies reach the
        // browser — setting them on the original `response` object doesn't
        // propagate correctly once the request cookies have changed.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !PUBLIC_PATHS.has(request.nextUrl.pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
