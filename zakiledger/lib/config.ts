/**
 * Deployment configuration helpers.
 *
 * The public base URL is needed to build OAuth redirect URIs. It must be the
 * externally-reachable https URL — NOT the request origin, because on Render the
 * app is bound internally to something like http://localhost:10000 behind the
 * TLS proxy, so `req.nextUrl.origin` would produce a wrong `redirect_uri`.
 *
 * Resolution order:
 *   1. RENDER_EXTERNAL_URL — set automatically by Render to the live https URL.
 *   2. APP_URL — manual override for other hosts (or to pin a value locally).
 *   3. http://localhost:3000 — local dev fallback only.
 */
export function appBaseUrl(): string {
  const fromEnv = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  const base = fromEnv || "http://localhost:3000";
  return base.replace(/\/$/, "");
}

/** Absolute callback URL for a provider, e.g. `${base}/api/xero/callback`. */
export function callbackUrl(path: string): string {
  return `${appBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
