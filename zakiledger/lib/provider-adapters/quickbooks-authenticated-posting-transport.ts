import {
  getValidQboAccess,
  quickBooksAccountingApiBase,
} from "../quickbooks";
import {
  QuickBooksPostingAdapter,
  QuickBooksSubmissionError,
  type QuickBooksCreateBillRequest,
  type QuickBooksObservedBill,
  type QuickBooksPostingTransport,
} from "./quickbooks-posting-adapter";
import {
  QuickBooksVendorPostingAdapter,
  QuickBooksVendorSubmissionError,
  type QuickBooksCreateVendorRequest,
  type QuickBooksObservedVendor,
  type QuickBooksVendorPostingTransport,
} from "./quickbooks-vendor-posting-adapter";

/**
 * The credential holder and destination are deliberately fixed when this
 * transport is constructed.  The operation grant still supplies the realm to
 * every call, and a mismatch fails before any provider request is made.
 */
export interface QuickBooksAuthenticatedPostingScope {
  actorUserId: string;
  providerConnectionId: string;
  realmId: string;
}

export interface QuickBooksAuthenticatedAccessClient {
  getAccess(userId: string): Promise<{ accessToken: string; realmId: string } | null>;
}

export interface QuickBooksHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}

export type QuickBooksHttpClient = (
  input: string,
  init: RequestInit,
) => Promise<QuickBooksHttpResponse>;

const defaultAccessClient: QuickBooksAuthenticatedAccessClient = {
  getAccess: getValidQboAccess,
};

function nonBlank(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function providerFailure(status: number, summary: string) {
  return {
    classification: status >= 400 && status < 500 && ![408, 409, 429].includes(status)
      ? "VALIDATION_REJECTION" as const
      : "UNCERTAIN_DELIVERY" as const,
    code: `QUICKBOOKS_HTTP_${status}`,
    summary,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

class BeforeDeliveryError extends Error {}

function observedVendor(realmId: string, value: unknown): QuickBooksObservedVendor | null {
  const vendor = asRecord(value);
  const id = typeof vendor.Id === "string" ? vendor.Id.trim() : "";
  const displayName = typeof vendor.DisplayName === "string" ? vendor.DisplayName.trim() : "";
  if (!id || !displayName || typeof vendor.Active !== "boolean") return null;
  return {
    id,
    realmId,
    displayName,
    active: vendor.Active,
    providerVersion: typeof vendor.SyncToken === "string" ? vendor.SyncToken : null,
  };
}

function observedBill(realmId: string, value: unknown): QuickBooksObservedBill | null {
  const bill = asRecord(value);
  const id = typeof bill.Id === "string" ? bill.Id.trim() : "";
  const vendorId = asRecord(bill.VendorRef).value;
  const currency = asRecord(bill.CurrencyRef).value;
  const lines = Array.isArray(bill.Line) ? bill.Line.map((line) => {
    const row = asRecord(line);
    const detail = asRecord(row.AccountBasedExpenseLineDetail);
    return {
      amount: typeof row.Amount === "number" ? row.Amount.toFixed(2) : "",
      description: typeof row.Description === "string" ? row.Description : "",
      providerAccountId: typeof asRecord(detail.AccountRef).value === "string"
        ? asRecord(detail.AccountRef).value as string : "",
      providerTaxCode: typeof asRecord(detail.TaxCodeRef).value === "string"
        ? asRecord(detail.TaxCodeRef).value as string : "",
    };
  }) : [];
  if (!id || typeof vendorId !== "string" || typeof currency !== "string" ||
      typeof bill.TotalAmt !== "number" || lines.some((line) => !line.amount || !line.providerAccountId || !line.providerTaxCode)) {
    return null;
  }
  return {
    id,
    realmId,
    status: typeof bill.TxnStatus === "string" ? bill.TxnStatus : "OPEN",
    vendorId,
    transactionDate: typeof bill.TxnDate === "string" ? bill.TxnDate : null,
    documentNumber: typeof bill.DocNumber === "string" ? bill.DocNumber : null,
    currency,
    amount: bill.TotalAmt.toFixed(2),
    lines,
    providerVersion: typeof bill.SyncToken === "string" ? bill.SyncToken : null,
  };
}

/**
 * The one authenticated QBO HTTP client for safe posting.  It implements both
 * narrow transport interfaces, but exposes no generic write capability.
 */
export class AuthenticatedQuickBooksPostingTransport
  implements QuickBooksPostingTransport, QuickBooksVendorPostingTransport {
  private readonly scope: QuickBooksAuthenticatedPostingScope;

  constructor(
    scope: QuickBooksAuthenticatedPostingScope,
    private readonly accessClient: QuickBooksAuthenticatedAccessClient = defaultAccessClient,
    private readonly http: QuickBooksHttpClient = fetch,
  ) {
    this.scope = {
      actorUserId: nonBlank(scope.actorUserId, "actor user ID"),
      providerConnectionId: nonBlank(scope.providerConnectionId, "provider connection ID"),
      realmId: nonBlank(scope.realmId, "QuickBooks realm ID"),
    };
  }

  private async headers(realmId: string): Promise<HeadersInit> {
    if (realmId !== this.scope.realmId) {
      throw new BeforeDeliveryError("QuickBooks realm does not match the bound provider connection scope");
    }
    const access = await this.accessClient.getAccess(this.scope.actorUserId);
    if (!access || access.realmId !== this.scope.realmId || !access.accessToken.trim()) {
      throw new BeforeDeliveryError("Authenticated QuickBooks credential does not match the bound provider connection realm");
    }
    return {
      Authorization: `Bearer ${access.accessToken}`,
      Accept: "application/json",
    };
  }

  private url(realmId: string, path: string): string {
    return `${quickBooksAccountingApiBase()}/v3/company/${encodeURIComponent(realmId)}/${path}`;
  }

  private assertProviderConnection(providerConnectionId: string): void {
    if (providerConnectionId !== this.scope.providerConnectionId) {
      throw new BeforeDeliveryError("QuickBooks provider connection does not match the bound transport scope");
    }
  }

  private async post(
    realmId: string,
    path: string,
    token: string,
    payload: Record<string, unknown>,
    vendor: boolean,
  ): Promise<{ body: Record<string, unknown>; providerRequestId: string | null }> {
    let headers: HeadersInit;
    try {
      headers = await this.headers(realmId);
    } catch (error) {
      const failure = {
        classification: "BEFORE_DELIVERY" as const,
        code: "QUICKBOOKS_SCOPE_OR_CREDENTIAL_REJECTED",
        summary: error instanceof Error ? error.message : "QuickBooks scope validation failed",
      };
      throw vendor ? new QuickBooksVendorSubmissionError(failure) : new QuickBooksSubmissionError(failure);
    }
    try {
      const response = await this.http(
        this.url(realmId, `${path}?minorversion=65&requestid=${encodeURIComponent(token)}`),
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        const failure = providerFailure(response.status, `QuickBooks ${path} request failed (${response.status})`);
        throw vendor ? new QuickBooksVendorSubmissionError(failure) : new QuickBooksSubmissionError(failure);
      }
      return { body: asRecord(await response.json()), providerRequestId: response.headers.get("intuit_tid") };
    } catch (error) {
      if (error instanceof QuickBooksVendorSubmissionError || error instanceof QuickBooksSubmissionError) throw error;
      // Once the HTTP client has been invoked, it is not safe to infer whether
      // QBO received the CREATE. Recovery must remain read-only.
      const failure = { classification: "UNCERTAIN_DELIVERY" as const, code: "QUICKBOOKS_TRANSPORT_FAILURE", summary: "QuickBooks CREATE delivery is uncertain" };
      throw vendor ? new QuickBooksVendorSubmissionError(failure) : new QuickBooksSubmissionError(failure);
    }
  }

  async createVendor(request: QuickBooksCreateVendorRequest) {
    try {
      this.assertProviderConnection(request.providerConnectionId);
    } catch (error) {
      throw new QuickBooksVendorSubmissionError({
        classification: "BEFORE_DELIVERY",
        code: "QUICKBOOKS_PROVIDER_CONNECTION_SCOPE_MISMATCH",
        summary: error instanceof Error ? error.message : "QuickBooks provider connection scope validation failed",
      });
    }
    const response = await this.post(request.realmId, "vendor", request.providerIdempotencyToken, request.payload, true);
    const vendor = asRecord(response.body.Vendor);
    const id = typeof vendor.Id === "string" ? vendor.Id : "";
    return { externalVendorId: id, providerRequestId: response.providerRequestId };
  }

  async createBill(request: QuickBooksCreateBillRequest) {
    try {
      this.assertProviderConnection(request.providerConnectionId);
    } catch (error) {
      throw new QuickBooksSubmissionError({
        classification: "BEFORE_DELIVERY",
        code: "QUICKBOOKS_PROVIDER_CONNECTION_SCOPE_MISMATCH",
        summary: error instanceof Error ? error.message : "QuickBooks provider connection scope validation failed",
      });
    }
    const response = await this.post(request.realmId, "bill", request.providerIdempotencyToken, request.payload, false);
    const bill = asRecord(response.body.Bill);
    const id = typeof bill.Id === "string" ? bill.Id : "";
    return { externalBillId: id, providerRequestId: response.providerRequestId };
  }

  private async get(realmId: string, path: string): Promise<Record<string, unknown>> {
    const response = await this.http(this.url(realmId, path), { headers: await this.headers(realmId) });
    if (!response.ok) throw new Error(`QuickBooks read failed (${response.status})`);
    return asRecord(await response.json());
  }

  async readVendor(realmId: string, externalVendorId: string): Promise<QuickBooksObservedVendor | null> {
    const body = await this.get(realmId, `vendor/${encodeURIComponent(externalVendorId)}?minorversion=65`);
    return observedVendor(realmId, body.Vendor);
  }

  async readBill(realmId: string, externalBillId: string): Promise<QuickBooksObservedBill | null> {
    const body = await this.get(realmId, `bill/${encodeURIComponent(externalBillId)}?minorversion=65`);
    return observedBill(realmId, body.Bill);
  }

  private async find(realmId: string, objectName: "Vendor" | "Bill", correlationTag: string): Promise<Record<string, unknown>[]> {
    const escapedTag = correlationTag.replace(/'/g, "\\'");
    const query = `select * from ${objectName} where ${objectName === "Vendor" ? "Notes" : "PrivateNote"} = '${escapedTag}'`;
    const body = await this.get(realmId, `query?query=${encodeURIComponent(query)}&minorversion=65`);
    const response = asRecord(body.QueryResponse);
    const rows = response[objectName];
    return Array.isArray(rows) ? rows.map(asRecord) : [];
  }

  async findVendorsByCorrelation(realmId: string, correlationTag: string): Promise<QuickBooksObservedVendor[]> {
    return (await this.find(realmId, "Vendor", correlationTag))
      .map((vendor) => observedVendor(realmId, vendor))
      .filter((vendor): vendor is QuickBooksObservedVendor => vendor !== null);
  }

  async findBillsByCorrelation(realmId: string, correlationTag: string): Promise<QuickBooksObservedBill[]> {
    return (await this.find(realmId, "Bill", correlationTag))
      .map((bill) => observedBill(realmId, bill))
      .filter((bill): bill is QuickBooksObservedBill => bill !== null);
  }
}

/** Safe ENSURE_VENDOR wiring. Callers must provide the operation's exact scope. */
export function createAuthenticatedQuickBooksVendorPostingAdapter(
  scope: QuickBooksAuthenticatedPostingScope,
  accessClient?: QuickBooksAuthenticatedAccessClient,
  http?: QuickBooksHttpClient,
): QuickBooksVendorPostingAdapter {
  return new QuickBooksVendorPostingAdapter(
    new AuthenticatedQuickBooksPostingTransport(scope, accessClient, http),
  );
}

/** The Bill adapter uses the very same scoped authenticated transport. */
export function createAuthenticatedQuickBooksPostingAdapter(
  scope: QuickBooksAuthenticatedPostingScope,
  accessClient?: QuickBooksAuthenticatedAccessClient,
  http?: QuickBooksHttpClient,
): QuickBooksPostingAdapter {
  return new QuickBooksPostingAdapter(
    new AuthenticatedQuickBooksPostingTransport(scope, accessClient, http),
  );
}
