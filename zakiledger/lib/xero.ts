import {
  getConnection,
  isExpired,
  saveConnection,
  setConnectionOrgId,
  type TokenSet,
} from "./oauth-store";
import type { ApprovedBill } from "./accounting";

/**
 * Xero OAuth 2.0 + Accounting API integration.
 *
 * Flow: /api/xero/connect redirects the user to Xero to authorize; Xero calls
 * back to /api/xero/callback with a code; we exchange it for tokens, then hit
 * /connections to learn which organisation (tenantId) was authorized. Access
 * tokens live ~30 min, so `getValidXeroAccess()` transparently refreshes using
 * the rotating refresh token (offline_access scope) before every API call.
 */
const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const API_BASE = "https://api.xero.com/api.xro/2.0";

// `offline_access` is required to receive a refresh token — without it the
// connection would die when the 30-minute access token expires, which the
// approval flow can't tolerate. `accounting.transactions` covers reading/writing
// bills (ACCPAY invoices).
const SCOPE = "offline_access accounting.transactions";

/** True when the client id is present. Secret is additionally needed to exchange codes. */
export function isXeroConfigured(): boolean {
  return Boolean(process.env.XERO_CLIENT_ID);
}

function clientId(): string {
  const id = process.env.XERO_CLIENT_ID;
  if (!id) throw new Error("XERO_CLIENT_ID is not set.");
  return id;
}

/** HTTP Basic credentials for the token endpoint. */
function basicAuthHeader(): string {
  const id = clientId();
  const secret = process.env.XERO_CLIENT_SECRET;
  if (!secret) throw new Error("XERO_CLIENT_SECRET is not set.");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

/** The URL to send the user to in order to authorize Xero. */
export function xeroAuthorizeUrl(redirectUri: string, state: string): string {
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
    expiresIn: Number(body.expires_in ?? 1800),
  };
}

/** Exchange an authorization code for the first token set. */
export async function exchangeXeroCode(code: string, redirectUri: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Xero token exchange failed (${res.status}): ${await res.text()}`);
  }
  return parseTokenResponse(await res.json());
}

/** Refresh an expired access token. Xero rotates the refresh token on each use. */
export async function refreshXeroToken(refreshToken: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Xero token refresh failed (${res.status}): ${await res.text()}`);
  }
  return parseTokenResponse(await res.json());
}

/**
 * Fetch the authorized organisations and return the first tenantId. Called once
 * right after the code exchange so we know which org to post bills to.
 */
export async function fetchXeroTenantId(accessToken: string): Promise<string | undefined> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Xero /connections failed (${res.status}): ${await res.text()}`);
  }
  const connections = (await res.json()) as Array<{ tenantId?: string }>;
  return connections[0]?.tenantId;
}

/**
 * Return a valid access token + tenantId for the stored connection, refreshing
 * the token first if it's expired and persisting the rotated tokens. Returns
 * null when Xero isn't connected.
 */
async function getValidXeroAccess(): Promise<{ accessToken: string; tenantId: string } | null> {
  let conn = await getConnection("xero");
  if (!conn) return null;

  if (isExpired(conn)) {
    const tokens = await refreshXeroToken(conn.refreshToken);
    conn = await saveConnection("xero", tokens, conn.orgId);
  }

  let tenantId = conn.orgId;
  if (!tenantId) {
    // Recover the tenantId if it was never captured (e.g. an older connection).
    tenantId = await fetchXeroTenantId(conn.accessToken);
    if (tenantId) await setConnectionOrgId("xero", tenantId);
  }
  if (!tenantId) throw new Error("Xero connection has no tenantId — reconnect required.");

  return { accessToken: conn.accessToken, tenantId };
}

/** True when there is a usable Xero connection stored. */
export async function isXeroConnected(): Promise<boolean> {
  return (await getConnection("xero")) !== null;
}

/**
 * Post an approved invoice as a DRAFT accounts-payable bill (ACCPAY) and return
 * the created bill's InvoiceID. Draft status means Xero accepts an incomplete
 * bill (no account codes required) for a human to finalise inside Xero.
 */
export async function createXeroDraftBill(bill: ApprovedBill): Promise<string> {
  const access = await getValidXeroAccess();
  if (!access) throw new Error("Xero is not connected.");

  // Prefer the extracted line items; fall back to a single summary line so the
  // bill total is always represented even when line items weren't captured.
  const lineItems =
    bill.lineItems && bill.lineItems.length > 0
      ? bill.lineItems.map((li) => ({
          Description: li.description || "Item",
          Quantity: li.quantity,
          UnitAmount: li.unitPrice,
          LineAmount: li.amount,
        }))
      : [
          {
            Description: `Invoice ${bill.invoiceNumber ?? ""}`.trim() || "Imported invoice",
            Quantity: 1,
            UnitAmount: bill.total ?? 0,
            LineAmount: bill.total ?? 0,
          },
        ];

  const payload: Record<string, unknown> = {
    Type: "ACCPAY",
    Status: "DRAFT",
    Contact: { Name: bill.supplierName || "Unknown supplier" },
    LineItems: lineItems,
    LineAmountTypes: "Exclusive",
  };
  if (bill.invoiceNumber) payload.InvoiceNumber = bill.invoiceNumber;
  if (bill.invoiceDate) payload.Date = bill.invoiceDate;
  if (bill.currency) payload.CurrencyCode = bill.currency;

  const res = await fetch(`${API_BASE}/Invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access.accessToken}`,
      "Xero-tenant-id": access.tenantId,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Xero bill creation failed (${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as { Invoices?: Array<{ InvoiceID?: string }> };
  const id = body.Invoices?.[0]?.InvoiceID;
  if (!id) throw new Error("Xero did not return a bill id.");
  return id;
}
