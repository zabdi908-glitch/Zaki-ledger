import { getSupabase } from "./supabase";

/**
 * OAuth connection storage for the accounting integrations (Xero, QuickBooks).
 *
 * Mirrors the pattern in lib/store.ts: persist to Supabase/Postgres when it's
 * configured (see the `oauth_connections` table in db/schema.sql), otherwise fall
 * back to an in-memory map so the flow is runnable without a database. This is a
 * single-tenant MVP, so we keep exactly one connection per provider.
 *
 * Access tokens are short-lived (Xero ~30 min, QuickBooks ~60 min); the refresh
 * token is what keeps a connection alive across sessions, so it is stored here
 * too and rotated on every refresh.
 */
export type OAuthProvider = "xero" | "quickbooks";

export interface OAuthConnection {
  provider: OAuthProvider;
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the access token expires. */
  expiresAt: string;
  /** Provider org identifier: Xero tenantId, QuickBooks realmId. */
  orgId?: string;
  updatedAt: string;
}

/** What a token grant/refresh produces, before we stamp it with metadata. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires (provider's `expires_in`). */
  expiresIn: number;
}

// --- In-memory fallback (used only when Supabase isn't configured) ----------

/**
 * On `globalThis` for the same reason as lib/store.ts: each Next.js route handler
 * is bundled separately, so a module-level Map would mean the connection saved by
 * /api/xero/callback was invisible to /api/approve — the OAuth flow would appear
 * to succeed and then every approval would report "not connected".
 * Irrelevant once Supabase is configured; the `oauth_connections` table is then
 * the shared state.
 */
const globalForConnections = globalThis as unknown as {
  __zakiLedgerConnections?: Map<OAuthProvider, OAuthConnection>;
};
const memConnections: Map<OAuthProvider, OAuthConnection> =
  (globalForConnections.__zakiLedgerConnections ??= new Map());

function mapConnectionRow(row: Record<string, unknown>): OAuthConnection {
  return {
    provider: row.provider as OAuthProvider,
    accessToken: String(row.access_token),
    refreshToken: String(row.refresh_token),
    expiresAt: String(row.expires_at),
    orgId: (row.org_id as string) ?? undefined,
    updatedAt: String(row.updated_at),
  };
}

/** Compute an absolute expiry from a `expires_in` (seconds), ISO-encoded. */
function expiryFromNow(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * Upsert the connection for a provider. One row per provider (provider is the
 * primary key), so re-connecting or refreshing overwrites in place.
 */
export async function saveConnection(
  provider: OAuthProvider,
  tokens: TokenSet,
  orgId?: string,
): Promise<OAuthConnection> {
  const entry: OAuthConnection = {
    provider,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: expiryFromNow(tokens.expiresIn),
    orgId,
    updatedAt: new Date().toISOString(),
  };

  const db = getSupabase();
  if (!db) {
    memConnections.set(provider, entry);
    return entry;
  }

  const { data, error } = await db
    .from("oauth_connections")
    .upsert(
      {
        provider,
        access_token: entry.accessToken,
        refresh_token: entry.refreshToken,
        expires_at: entry.expiresAt,
        org_id: entry.orgId ?? null,
        updated_at: entry.updatedAt,
      },
      { onConflict: "provider" },
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to save ${provider} connection: ${error.message}`);
  return mapConnectionRow(data as Record<string, unknown>);
}

/** Update just the org identifier (Xero tenantId / QuickBooks realmId). */
export async function setConnectionOrgId(
  provider: OAuthProvider,
  orgId: string,
): Promise<void> {
  const db = getSupabase();
  if (!db) {
    const existing = memConnections.get(provider);
    if (existing) existing.orgId = orgId;
    return;
  }

  const { error } = await db
    .from("oauth_connections")
    .update({ org_id: orgId, updated_at: new Date().toISOString() })
    .eq("provider", provider);

  if (error) throw new Error(`Failed to set ${provider} org id: ${error.message}`);
}

/**
 * Delay before the single retry in `getConnection`. The race it absorbs closes
 * in well under a second, so this only has to outlast the clock correction.
 */
const COLD_START_RETRY_DELAY_MS = 300;

/**
 * The stored connection for a provider, or null if never connected.
 *
 * Retries once on failure. This is not a general retry policy — it exists for one
 * specific observed race: the FIRST Supabase call from a freshly-started instance
 * fails, then everything after it succeeds. Seen twice as
 * `JWT issued at future` (Supabase rejecting the service_role key because the new
 * container's clock is briefly ahead of Supabase's, so the token's `iat` looks
 * future-dated) and once as `TypeError: fetch failed`, which is the same cold-start
 * shape with different wording — hence retrying on any error rather than matching
 * a message.
 *
 * Without this, the first visitor after an idle spin-down or a deploy gets a 500
 * from /api/connections. On the free tier that is a routine event, not an edge case.
 * A second attempt lands after the clock settles.
 */
export async function getConnection(
  provider: OAuthProvider,
): Promise<OAuthConnection | null> {
  const db = getSupabase();
  if (!db) return memConnections.get(provider) ?? null;

  const load = () =>
    db.from("oauth_connections").select().eq("provider", provider).maybeSingle();

  let { data, error } = await load();

  if (error) {
    // Logged rather than swallowed: if this starts firing on warm instances it is
    // no longer a cold-start race and the retry is masking something real.
    console.warn(
      `[oauth-store] ${provider} connection load failed (${error.message}) — retrying once`,
    );
    await new Promise((r) => setTimeout(r, COLD_START_RETRY_DELAY_MS));
    ({ data, error } = await load());
  }

  if (error) throw new Error(`Failed to load ${provider} connection: ${error.message}`);
  return data ? mapConnectionRow(data as Record<string, unknown>) : null;
}

/** True when the access token is expired (or within a 60s safety buffer). */
export function isExpired(conn: OAuthConnection): boolean {
  return Date.parse(conn.expiresAt) - Date.now() <= 60_000;
}
