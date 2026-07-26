import {
  getConnection,
  isExpired,
  saveConnection,
  type TokenSet,
} from "./oauth-store";
import type { ApprovedBill } from "./accounting";

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
function apiBase(): string {
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
async function getValidQboAccess(): Promise<{ accessToken: string; realmId: string } | null> {
  let conn = await getConnection("quickbooks");
  if (!conn) return null;

  if (isExpired(conn)) {
    const tokens = await refreshQuickBooksToken(conn.refreshToken);
    conn = await saveConnection("quickbooks", tokens, conn.orgId);
  }

  if (!conn.orgId) throw new Error("QuickBooks connection has no realmId — reconnect required.");
  return { accessToken: conn.accessToken, realmId: conn.orgId };
}

/** True when there is a usable QuickBooks connection stored. */
export async function isQuickBooksConnected(): Promise<boolean> {
  return (await getConnection("quickbooks")) !== null;
}

/** Escape a value for inclusion in a QuickBooks SQL-like query string. */
function escapeQuery(value: string): string {
  return value.replace(/'/g, "\\'");
}

/** Today as a YYYY-MM-DD string (UTC). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** True when `s` is a date string Date can actually parse (e.g. YYYY-MM-DD). */
function isParsableDate(s: string | null | undefined): s is string {
  if (!s || s.trim() === "") return false;
  return !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

/** Add `days` to an ISO date (YYYY-MM-DD), returning a YYYY-MM-DD string. */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function qboGet(
  path: string,
  accessToken: string,
  realmId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase()}/v3/company/${realmId}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`QuickBooks GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function qboPost(
  path: string,
  accessToken: string,
  realmId: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase()}/v3/company/${realmId}/${path}?minorversion=65`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`QuickBooks POST ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Find a vendor by display name, creating one if it doesn't exist. Returns its Id. */
async function findOrCreateVendor(
  name: string,
  accessToken: string,
  realmId: string,
): Promise<string> {
  const query = `select Id from Vendor where DisplayName = '${escapeQuery(name)}'`;
  const found = (await qboGet(
    `query?query=${encodeURIComponent(query)}&minorversion=65`,
    accessToken,
    realmId,
  )) as { QueryResponse?: { Vendor?: Array<{ Id: string }> } };

  const existing = found.QueryResponse?.Vendor?.[0]?.Id;
  if (existing) return existing;

  const created = (await qboPost("vendor", accessToken, realmId, { DisplayName: name })) as {
    Vendor?: { Id?: string };
  };
  const id = created.Vendor?.Id;
  if (!id) throw new Error("QuickBooks vendor creation returned no id.");
  return id;
}

/** The Id of the first Expense-type account — needed for the bill's expense line. */
async function firstExpenseAccountId(accessToken: string, realmId: string): Promise<string> {
  const query = "select Id from Account where AccountType = 'Expense' maxresults 1";
  const found = (await qboGet(
    `query?query=${encodeURIComponent(query)}&minorversion=65`,
    accessToken,
    realmId,
  )) as { QueryResponse?: { Account?: Array<{ Id: string }> } };

  const id = found.QueryResponse?.Account?.[0]?.Id;
  if (!id) throw new Error("QuickBooks company has no Expense account to book the bill against.");
  return id;
}

/**
 * Post an approved invoice as a QuickBooks Bill and return its Id. A Bill needs
 * a VendorRef (we find/create the vendor by name) and each line needs an
 * AccountRef (we use the first Expense account). Amount = the approved total.
 */
export async function createQuickBooksBill(bill: ApprovedBill): Promise<string> {
  const access = await getValidQboAccess();
  if (!access) throw new Error("QuickBooks is not connected.");
  const { accessToken, realmId } = access;

  const vendorId = await findOrCreateVendor(
    bill.supplierName || "Unknown supplier",
    accessToken,
    realmId,
  );
  const accountId = await firstExpenseAccountId(accessToken, realmId);

  const payload: Record<string, unknown> = {
    VendorRef: { value: vendorId },
    Line: [
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: bill.total ?? 0,
        Description: `Invoice ${bill.invoiceNumber ?? ""}`.trim() || "Imported invoice",
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
      },
    ],
  };
  if (bill.invoiceNumber) payload.DocNumber = bill.invoiceNumber;

  // Use the invoice's own date only when it's actually parseable — a missing,
  // blank, or oddly-formatted value (`??` alone doesn't catch "" or bad formats)
  // would produce an Invalid Date and make addDays() throw "Invalid time value".
  // Fall back to today so the bill still posts cleanly.
  const txnDate = isParsableDate(bill.invoiceDate) ? bill.invoiceDate : today();
  payload.TxnDate = txnDate;
  // Intentionally ignore the invoice's original due date / payment terms. If we
  // pass a due date already in the past (common for invoices dated before today),
  // QuickBooks immediately marks the bill "Overdue" — which looks wrong in a
  // review queue, where Xero shows the equivalent bill as a clean "Draft". The
  // goal here is just getting the bill into the books for a bookkeeper to review,
  // not preserving payment terms, so we always set DueDate to bill date + 30 days.
  payload.DueDate = addDays(txnDate, 30);

  const created = (await qboPost("bill", accessToken, realmId, payload)) as {
    Bill?: { Id?: string };
  };
  const id = created.Bill?.Id;
  if (!id) throw new Error("QuickBooks did not return a bill id.");
  return id;
}
