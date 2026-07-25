import type { NextRequest } from "next/server";
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
const memConnections = new Map<OAuthProvider, OAuthConnection>();

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

/** The stored connection for a provider, or null if never connected. */
export async function getConnection(
  provider: OAuthProvider,
): Promise<OAuthConnection | null> {
  const db = getSupabase();
  if (!db) return memConnections.get(provider) ?? null;

  const { data, error } = await db
    .from("oauth_connections")
    .select()
    .eq("provider", provider)
    .maybeSingle();

  if (error) throw new Error(`Failed to load ${provider} connection: ${error.message}`);
  return data ? mapConnectionRow(data as Record<string, unknown>) : null;
}

/** True when the access token is expired (or within a 60s safety buffer). */
export function isExpired(conn: OAuthConnection): boolean {
  return Date.parse(conn.expiresAt) - Date.now() <= 60_000;
}

/**
 * The public base URL of this deployment, used to build OAuth redirect URIs.
 * Honours an APP_BASE_URL override (set it when the request origin isn't the
 * externally-registered URL), else derives it from the incoming request — which
 * works for both `localhost` in dev and the Render URL in production.
 */
export function appBaseUrl(req: NextRequest): string {
  const override = process.env.APP_BASE_URL;
  return (override ?? req.nextUrl.origin).replace(/\/$/, "");
}
