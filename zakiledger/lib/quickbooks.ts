import {
  getConnection,
  isExpired,
  saveConnection,
  type TokenSet,
} from "./oauth-store";
import type { QbTransactionInput } from "./reconciliation-schema";

/**
 * QuickBooks Online OAuth 2.0 + Accounting API integration.
 *
 * Flow: /api/quickbooks/connect redirects to Intuit to authorize; Intuit calls
 * back to /api/quickbooks/callback with a `code` and a `realmId` (the company
 * id). We exchange the code for tokens and store the realmId alongside them.
 * Access tokens live ~60 min, so `getValidQboAccess()` refreshes transparently
 * before each API call using the refresh token.
 */
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

/** Sandbox by default; set QUICKBOOKS_ENVIRONMENT=production to hit live company data. */
/** Shared accounting API base for authenticated, capability-scoped clients. */
export function quickBooksAccountingApiBase(): string {
  return process.env.QUICKBOOKS_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

/** True when the client id is present. Secret is additionally needed to exchange codes. */
export function isQuickBooksConfigured(): boolean {
  return Boolean(process.env.QUICKBOOKS_CLIENT_ID);
}

function clientId(): string {
  const id = process.env.QUICKBOOKS_CLIENT_ID;
  if (!id) throw new Error("QUICKBOOKS_CLIENT_ID is not set.");
  return id;
}

function basicAuthHeader(): string {
  const id = clientId();
  const secret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!secret) throw new Error("QUICKBOOKS_CLIENT_SECRET is not set.");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

/** The URL to send the user to in order to authorize QuickBooks. */
export function quickbooksAuthorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function parseTokenResponse(body: Record<string, unknown>): TokenSet {
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token),
    expiresIn: Number(body.expires_in ?? 3600),
  };
}

/** Exchange an authorization code for the first token set. */
export async function exchangeQuickBooksCode(
  code: string,
  redirectUri: string,
): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`QuickBooks token exchange failed (${res.status}): ${await res.text()}`);
  }
  return parseTokenResponse(await res.json());
}

/** Refresh an expired access token. */
export async function refreshQuickBooksToken(refreshToken: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`QuickBooks token refresh failed (${res.status}): ${await res.text()}`);
  }
  return parseTokenResponse(await res.json());
}

/**
 * Return a valid access token + realmId for the stored connection, refreshing
 * the access token first if it's expired. Returns null when not connected.
 */
export async function getValidQboAccess(
  userId: string,
): Promise<{ accessToken: string; realmId: string } | null> {
  let conn = await getConnection(userId, "quickbooks");
  if (!conn) return null;

  if (isExpired(conn)) {
    const tokens = await refreshQuickBooksToken(conn.refreshToken);
    conn = await saveConnection(userId, "quickbooks", tokens, conn.orgId);
  }

  if (!conn.orgId) throw new Error("QuickBooks connection has no realmId — reconnect required.");
  return { accessToken: conn.accessToken, realmId: conn.orgId };
}

/** True when this user has a usable QuickBooks connection stored. */
export async function isQuickBooksConnected(userId: string): Promise<boolean> {
  return (await getConnection(userId, "quickbooks")) !== null;
}

/**
 * The connection status the UI shows: not just "a token is stored" but "the
 * token still works" — refreshes an expired access token first, then proves it
 * with a real API call (company info) rather than trusting the stored expiry.
 * A revoked or otherwise broken token reports as disconnected instead of
 * throwing.
 */
export async function quickBooksConnectionStatus(userId: string): Promise<{
  connected: boolean;
  accountName?: string;
}> {
  try {
    const access = await getValidQboAccess(userId);
    if (!access) return { connected: false };

    const info = (await qboGet(
      `companyinfo/${access.realmId}?minorversion=65`,
      access.accessToken,
      access.realmId,
    )) as { CompanyInfo?: { CompanyName?: string } };
    return { connected: true, accountName: info.CompanyInfo?.CompanyName };
  } catch {
    return { connected: false };
  }
}

async function qboGet(
  path: string,
  accessToken: string,
  realmId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${quickBooksAccountingApiBase()}/v3/company/${realmId}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`QuickBooks GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * The accounting side of reconciliation, pulled live instead of a CSV import:
 * every QuickBooks Purchase (Expense/Check/CreditCardCredit — the entity QBO
 * uses for money actually spent, as opposed to a Bill, which is money owed)
 * posted within the given date range. Mapped onto the same QbTransactionInput
 * shape saveQbTransactions() already takes from the CSV-import stand-in (see
 * lib/bank-parsers.ts parsedTransactionsToQbInputs), so the matching
 * algorithm doesn't need to know which source a transaction came from.
 *
 * QBO's query API paginates via STARTPOSITION/MAXRESULTS; 1000 per page is
 * the platform's own max page size.
 */
export async function listQuickBooksPurchases(
  userId: string,
  periodStart: string,
  periodEnd: string,
): Promise<QbTransactionInput[]> {
  const access = await getValidQboAccess(userId);
  if (!access) throw new Error("QuickBooks is not connected.");
  const { accessToken, realmId } = access;

  type QboPurchase = {
    Id?: string;
    TxnDate?: string;
    TotalAmt?: number;
    PrivateNote?: string;
    EntityRef?: { name?: string };
    AccountRef?: { value?: string; name?: string };
    PaymentType?: string;
    CurrencyRef?: { value?: string };
    Line?: Array<{ Description?: string }>;
  };

  const results: QbTransactionInput[] = [];
  let startPosition = 1;
  const pageSize = 1000;

  // A hard cap on pages, not just a while(true): a runaway loop against a
  // live API on every /reconciliation/upload would be a real cost/latency
  // problem, not just a theoretical one. 20k purchases in one statement
  // period is already an unreasonable amount of data for this flow.
  for (let page = 0; page < 20; page++) {
    const query =
      `select * from Purchase where TxnDate >= '${periodStart}' and TxnDate <= '${periodEnd}' ` +
      `startposition ${startPosition} maxresults ${pageSize}`;
    const found = (await qboGet(`query?query=${encodeURIComponent(query)}&minorversion=65`, accessToken, realmId)) as {
      QueryResponse?: { Purchase?: QboPurchase[] };
    };
    const batch = found.QueryResponse?.Purchase ?? [];

    for (const p of batch) {
      if (p.TxnDate === undefined || p.TotalAmt === undefined) continue;
      results.push({
        provider: "quickbooks",
        organisationId: realmId,
        externalObjectType: "purchase",
        qbTransactionId: p.Id ?? null,
        qbAccountId: p.AccountRef?.value ?? null,
        postedDate: p.TxnDate,
        // QBO's Purchase.TotalAmt is already a positive "money spent" figure
        // — the same convention this app uses (positive = debit/money out).
        amount: p.TotalAmt,
        description: p.EntityRef?.name ?? p.PrivateNote ?? p.Line?.[0]?.Description ?? null,
        accountName: p.AccountRef?.name ?? null,
        accountType: p.PaymentType ?? null,
        currency: p.CurrencyRef?.value ?? null,
      });
    }

    if (batch.length < pageSize) break;
    startPosition += pageSize;
  }

  return results;
}
