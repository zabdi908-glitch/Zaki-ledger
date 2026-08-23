import { canonicalJson, sha256Hex } from "../posting-contract";
import {
  type ProviderPostingAdapter,
  type SanitizedProviderFailure,
} from "./provider-posting-adapter";

export interface QuickBooksBillLine {
  amount: string;
  description: string;
  providerAccountId: string;
  providerTaxCode: string;
}

interface DestinationScope {
  practiceId: string;
  clientEntityId: string;
  ledgerBookId: string;
  providerConnectionId: string;
  externalOrganisationId: string;
}

interface QuickBooksBillOperation extends DestinationScope {
  id: string;
  provider: "quickbooks";
  externalObjectType: "BILL";
  action: "CREATE";
  authorizedRequestFingerprint: string;
}

interface EligibleAccountMapping {
  id: string;
  providerAccountId: string;
  providerAccountType: string;
  scope: DestinationScope;
  eligible: true;
}

interface EligibleTaxMapping {
  id: string;
  providerTaxCode: string;
  evidenceFingerprint: string;
  scope: DestinationScope;
  eligible: true;
}

interface VerifiedVendorChild {
  operationId: string;
  state: "SUCCEEDED";
  externalVendorId: string;
  verifiedProviderStateFingerprint: string;
}

export interface QuickBooksAuthorizedBillGrant {
  operation: QuickBooksBillOperation & { stateAtDispatch: "AUTHORIZED" };
  attempt: {
    id: string;
    number: number;
    kind: "SUBMIT";
    providerIdempotencyToken: string;
  };
  accountMapping: EligibleAccountMapping;
  taxMapping: EligibleTaxMapping;
  vendorChild: VerifiedVendorChild;
  requestedObject: Record<string, unknown>;
  expectedMaterialState: Record<string, unknown>;
}

export interface QuickBooksBillRecoveryGrant {
  operation: QuickBooksBillOperation & {
    stateAtRecovery: "SUBMITTING" | "VERIFYING" | "UNCERTAIN";
  };
  attempt: {
    id: string;
    number: number;
    kind: "RECOVERY";
    providerIdempotencyToken: string;
  };
  accountMapping: EligibleAccountMapping;
  taxMapping: EligibleTaxMapping;
  vendorChild: VerifiedVendorChild;
  requestedObject: Record<string, unknown>;
  expectedMaterialState: Record<string, unknown>;
  knownExternalBillId: string | null;
}

export interface QuickBooksCreateBillRequest {
  realmId: string;
  providerIdempotencyToken: string;
  correlationTag: string;
  vendorId: string;
  transactionDate: string | null;
  documentNumber: string | null;
  currency: string;
  amount: string;
  lines: QuickBooksBillLine[];
  payload: {
    VendorRef: { value: string };
    TxnDate?: string;
    DocNumber?: string;
    CurrencyRef: { value: string };
    PrivateNote: string;
    Line: Array<{
      Amount: number;
      Description: string;
      DetailType: "AccountBasedExpenseLineDetail";
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: string };
        TaxCodeRef: { value: string };
      };
    }>;
  };
}

export interface QuickBooksObservedBill {
  id: string;
  realmId: string;
  status: string;
  vendorId: string;
  transactionDate: string | null;
  documentNumber: string | null;
  currency: string;
  amount: string;
  lines: QuickBooksBillLine[];
  providerVersion: string | null;
}

export interface QuickBooksPostingTransport {
  createBill(request: QuickBooksCreateBillRequest): Promise<{
    externalBillId: string;
    providerRequestId: string | null;
  }>;
  readBill(realmId: string, externalBillId: string): Promise<QuickBooksObservedBill | null>;
  findBillsByCorrelation(
    realmId: string,
    correlationTag: string,
  ): Promise<QuickBooksObservedBill[]>;
}

export class QuickBooksSubmissionError extends Error {
  constructor(readonly failure: SanitizedProviderFailure) {
    super(failure.summary);
    this.name = "QuickBooksSubmissionError";
  }
}

export type QuickBooksSubmitOutcome =
  | {
      kind: "ACKNOWLEDGED";
      externalBillId: string;
      providerRequestId: string | null;
      sanitizedResponse: { result: "CREATED" };
    }
  | { kind: "FAILED_SAFE"; failure: SanitizedProviderFailure }
  | { kind: "UNCERTAIN"; failure: SanitizedProviderFailure };

export type QuickBooksRecoveryOutcome =
  | { kind: "OBSERVED"; observation: QuickBooksObservedBill }
  | { kind: "INCONCLUSIVE"; reasonCode: string };

function scrub(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:access|refresh)[_-]?token\s*[=:]\s*[^\s,;]+/gi, "token=[REDACTED]")
    .slice(0, 240);
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) {
    throw new Error(`${label} must be an exact positive two-decimal string`);
  }
  if (Number(value) <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameScope(operation: DestinationScope, scope: DestinationScope): boolean {
  return scope.practiceId === operation.practiceId &&
    scope.clientEntityId === operation.clientEntityId &&
    scope.ledgerBookId === operation.ledgerBookId &&
    scope.providerConnectionId === operation.providerConnectionId &&
    scope.externalOrganisationId === operation.externalOrganisationId;
}

function correlationTag(operationId: string, fingerprint: string): string {
  return `zaki:${operationId}:${fingerprint}`;
}

function normalizeLines(lines: QuickBooksBillLine[]): QuickBooksBillLine[] {
  return lines.map((line) => ({
    amount: decimal(line.amount, "line amount"),
    description: line.description.trim(),
    providerAccountId: line.providerAccountId.trim(),
    providerTaxCode: line.providerTaxCode.trim(),
  }));
}

export function normalizedQuickBooksBillMaterial(
  observed: QuickBooksObservedBill,
): Record<string, unknown> {
  return {
    externalObjectType: "BILL",
    status: observed.status.trim().toUpperCase(),
    vendorId: observed.vendorId.trim(),
    transactionDate: observed.transactionDate,
    documentNumber: observed.documentNumber,
    currency: observed.currency.trim().toUpperCase(),
    amount: decimal(observed.amount, "observed amount"),
    lines: normalizeLines(observed.lines),
  };
}

export function quickBooksProviderStateFingerprint(observed: QuickBooksObservedBill): string {
  return sha256Hex(normalizedQuickBooksBillMaterial(observed));
}

export function expectedQuickBooksBillMaterial(
  grant: Pick<
    QuickBooksAuthorizedBillGrant,
    "accountMapping" | "taxMapping" | "vendorChild" | "requestedObject" | "expectedMaterialState"
  >,
): Record<string, unknown> {
  const amount = decimal(grant.requestedObject.amount, "bill amount");
  const currency = optionalString(grant.requestedObject.currency)?.toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new Error("bill currency is invalid");
  const description = optionalString(grant.requestedObject.description) ?? "Supplier bill";
  const status = optionalString(grant.expectedMaterialState.status)?.toUpperCase() ?? "OPEN";
  return {
    externalObjectType: "BILL",
    status,
    vendorId: grant.vendorChild.externalVendorId,
    transactionDate: optionalString(grant.requestedObject.invoiceDate),
    documentNumber: optionalString(grant.requestedObject.invoiceNumber),
    currency,
    amount,
    lines: [{
      amount,
      description,
      providerAccountId: grant.accountMapping.providerAccountId,
      providerTaxCode: grant.taxMapping.providerTaxCode,
    }],
  };
}

function requestFromGrant(grant: QuickBooksAuthorizedBillGrant): QuickBooksCreateBillRequest {
  if (grant.operation.stateAtDispatch !== "AUTHORIZED") {
    throw new Error("QuickBooks Bill adapter accepts only AUTHORIZED operations");
  }
  if (grant.operation.provider !== "quickbooks" || grant.operation.externalObjectType !== "BILL" ||
      grant.operation.action !== "CREATE") {
    throw new Error("QuickBooks adapter supports CREATE BILL only");
  }
  if (!grant.accountMapping.eligible || !sameScope(grant.operation, grant.accountMapping.scope) ||
      !grant.accountMapping.providerAccountId.trim()) {
    throw new Error("QuickBooks posting account mapping is not eligible for this destination");
  }
  if (!grant.taxMapping.eligible || !sameScope(grant.operation, grant.taxMapping.scope) ||
      !grant.taxMapping.providerTaxCode.trim() ||
      !/^[0-9a-f]{64}$/i.test(grant.taxMapping.evidenceFingerprint)) {
    throw new Error("QuickBooks tax treatment is not explicit and validated for this destination");
  }
  if (grant.vendorChild.state !== "SUCCEEDED" || !grant.vendorChild.externalVendorId.trim()) {
    throw new Error("Verified ENSURE_VENDOR child operation is required");
  }
  const material = expectedQuickBooksBillMaterial(grant);
  const tag = correlationTag(
    grant.operation.id,
    grant.operation.authorizedRequestFingerprint,
  );
  const lines = material.lines as QuickBooksBillLine[];
  return {
    realmId: grant.operation.externalOrganisationId,
    providerIdempotencyToken: grant.attempt.providerIdempotencyToken,
    correlationTag: tag,
    vendorId: material.vendorId as string,
    transactionDate: material.transactionDate as string | null,
    documentNumber: material.documentNumber as string | null,
    currency: material.currency as string,
    amount: material.amount as string,
    lines,
    payload: {
      VendorRef: { value: material.vendorId as string },
      ...(material.transactionDate ? { TxnDate: material.transactionDate as string } : {}),
      ...(material.documentNumber ? { DocNumber: material.documentNumber as string } : {}),
      CurrencyRef: { value: material.currency as string },
      PrivateNote: tag,
      Line: lines.map((line) => ({
        Amount: Number(line.amount),
        Description: line.description,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: line.providerAccountId },
          TaxCodeRef: { value: line.providerTaxCode },
        },
      })),
    },
  };
}

export class QuickBooksPostingAdapter implements ProviderPostingAdapter {
  readonly provider = "quickbooks" as const;

  constructor(private readonly transport: QuickBooksPostingTransport) {}

  async executeAuthorizedBill(grant: QuickBooksAuthorizedBillGrant): Promise<QuickBooksSubmitOutcome> {
    let request: QuickBooksCreateBillRequest;
    try {
      request = requestFromGrant(grant);
    } catch (error) {
      return {
        kind: "FAILED_SAFE",
        failure: {
          classification: "VALIDATION_REJECTION",
          code: "INVALID_EXECUTION_GRANT",
          summary: scrub(error instanceof Error ? error.message : "Invalid execution grant"),
        },
      };
    }

    try {
      const response = await this.transport.createBill(request);
      if (!response.externalBillId.trim()) {
        throw new QuickBooksSubmissionError({
          classification: "UNCERTAIN_DELIVERY",
          code: "MALFORMED_CREATE_ACKNOWLEDGEMENT",
          summary: "QuickBooks create acknowledgement omitted the Bill ID",
        });
      }
      return {
        kind: "ACKNOWLEDGED",
        externalBillId: response.externalBillId.trim(),
        providerRequestId: response.providerRequestId?.trim() || null,
        sanitizedResponse: { result: "CREATED" },
      };
    } catch (error) {
      const failure = error instanceof QuickBooksSubmissionError
        ? error.failure
        : {
            classification: "UNCERTAIN_DELIVERY" as const,
            code: "UNCLASSIFIED_TRANSPORT_FAILURE",
            summary: scrub(error instanceof Error ? error.message : "Unknown transport failure"),
          };
      const safeFailure = { ...failure, summary: scrub(failure.summary) };
      return failure.classification === "VALIDATION_REJECTION" ||
        failure.classification === "BEFORE_DELIVERY"
        ? { kind: "FAILED_SAFE", failure: safeFailure }
        : { kind: "UNCERTAIN", failure: safeFailure };
    }
  }

  async readBack(
    grant: QuickBooksAuthorizedBillGrant | QuickBooksBillRecoveryGrant,
    externalBillId: string,
  ): Promise<QuickBooksRecoveryOutcome> {
    try {
      const observed = await this.transport.readBill(
        grant.operation.externalOrganisationId,
        externalBillId,
      );
      return observed
        ? { kind: "OBSERVED", observation: observed }
        : { kind: "INCONCLUSIVE", reasonCode: "BILL_NOT_FOUND_INCONCLUSIVE" };
    } catch {
      return { kind: "INCONCLUSIVE", reasonCode: "READ_BACK_UNAVAILABLE" };
    }
  }

  async recover(grant: QuickBooksBillRecoveryGrant): Promise<QuickBooksRecoveryOutcome> {
    if (grant.knownExternalBillId) return this.readBack(grant, grant.knownExternalBillId);
    const tag = correlationTag(grant.operation.id, grant.operation.authorizedRequestFingerprint);
    try {
      const candidates = await this.transport.findBillsByCorrelation(
        grant.operation.externalOrganisationId,
        tag,
      );
      return candidates.length === 1
        ? { kind: "OBSERVED", observation: candidates[0] }
        : { kind: "INCONCLUSIVE", reasonCode: candidates.length > 1
          ? "MULTIPLE_CORRELATED_BILLS"
          : "BILL_ABSENCE_NOT_CONCLUSIVE" };
    } catch {
      return { kind: "INCONCLUSIVE", reasonCode: "RECOVERY_QUERY_UNAVAILABLE" };
    }
  }
}

export type FakeQuickBooksTransportMode =
  | "SUCCESS"
  | "TIMEOUT_BEFORE_DELIVERY"
  | "TIMEOUT_AFTER_DELIVERY"
  | "VALIDATION_REJECTION";

/** Deterministic in-memory transport. It never performs network I/O. */
export class FakeQuickBooksPostingTransport implements QuickBooksPostingTransport {
  readonly bills = new Map<string, QuickBooksObservedBill>();
  readonly correlations = new Map<string, string[]>();
  createCalls = 0;
  readCalls = 0;
  recoveryCalls = 0;
  lastCreateRequest: QuickBooksCreateBillRequest | null = null;

  constructor(
    private mode: FakeQuickBooksTransportMode = "SUCCESS",
    private readonly mutateReadBack?: (bill: QuickBooksObservedBill) => QuickBooksObservedBill,
  ) {}

  setMode(mode: FakeQuickBooksTransportMode): void {
    this.mode = mode;
  }

  async createBill(request: QuickBooksCreateBillRequest): Promise<{
    externalBillId: string;
    providerRequestId: string | null;
  }> {
    this.createCalls += 1;
    this.lastCreateRequest = request;
    if (this.mode === "TIMEOUT_BEFORE_DELIVERY") {
      throw new QuickBooksSubmissionError({
        classification: "BEFORE_DELIVERY",
        code: "CONNECT_TIMEOUT_BEFORE_WRITE",
        summary: "Connection failed before request bytes were sent",
      });
    }
    if (this.mode === "VALIDATION_REJECTION") {
      throw new QuickBooksSubmissionError({
        classification: "VALIDATION_REJECTION",
        code: "QBO_VALIDATION_REJECTED",
        summary: "QuickBooks rejected the Bill before creation",
      });
    }

    const id = `fake-bill-${this.bills.size + 1}`;
    const bill: QuickBooksObservedBill = {
      id,
      realmId: request.realmId,
      status: "OPEN",
      vendorId: request.vendorId,
      transactionDate: request.transactionDate,
      documentNumber: request.documentNumber,
      currency: request.currency,
      amount: request.amount,
      lines: request.lines.map((line) => ({ ...line })),
      providerVersion: "1",
    };
    this.bills.set(id, bill);
    this.correlations.set(request.correlationTag, [
      ...(this.correlations.get(request.correlationTag) ?? []),
      id,
    ]);
    if (this.mode === "TIMEOUT_AFTER_DELIVERY") {
      throw new QuickBooksSubmissionError({
        classification: "UNCERTAIN_DELIVERY",
        code: "RESPONSE_TIMEOUT_AFTER_POSSIBLE_CREATE",
        summary: "Response timed out after QuickBooks may have created the Bill",
      });
    }
    return { externalBillId: id, providerRequestId: `fake-request-${this.createCalls}` };
  }

  async readBill(_realmId: string, externalBillId: string): Promise<QuickBooksObservedBill | null> {
    this.readCalls += 1;
    const bill = this.bills.get(externalBillId);
    return bill ? (this.mutateReadBack ? this.mutateReadBack({ ...bill }) : { ...bill }) : null;
  }

  async findBillsByCorrelation(
    _realmId: string,
    correlation: string,
  ): Promise<QuickBooksObservedBill[]> {
    this.recoveryCalls += 1;
    return (this.correlations.get(correlation) ?? [])
      .map((id) => this.bills.get(id))
      .filter((bill): bill is QuickBooksObservedBill => Boolean(bill))
      .map((bill) => this.mutateReadBack ? this.mutateReadBack({ ...bill }) : { ...bill });
  }
}

export const __quickBooksAdapterTestUtils = {
  correlationTag,
  requestFromGrant,
  scrub,
  stableMaterialJson: canonicalJson,
};
