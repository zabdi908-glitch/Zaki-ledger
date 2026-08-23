import {
  createAuthoritativePostingService,
  type AuthoritativePostingService,
} from "./authoritative-posting-service";
import type {
  AccountTreatment,
  EvidenceReference,
  PostingProvider,
  PostingSubmitResult,
  TaxTreatment,
} from "./posting-contract";
import type { DocumentType, LineItem } from "./schema";

/** Human-approved values used to construct the canonical provider-neutral bill intent. */
export interface ApprovedBill {
  documentType?: DocumentType;
  supplierName: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  lineItems: LineItem[];
}

export interface PostingDestination {
  practiceId: string;
  clientEntityId: string;
  ledgerBookId: string;
  providerConnectionId: string;
  provider: PostingProvider;
  externalOrganisationId: string;
}

/**
 * Exact, caller-selected posting context. These identifiers are proposals only:
 * AuthoritativePostingService revalidates their ownership and eligibility from
 * canonical tables before it can authorize an operation.
 */
export interface ApprovedBillPostingRequest {
  operationId?: string | null;
  destination: PostingDestination;
  idempotencyKey: string;
  sourceDocumentId: string;
  sourceRevision: string;
  evidence: EvidenceReference[];
  accountTreatment: AccountTreatment[];
  taxTreatment: TaxTreatment[];
  /** Exact ENSURE_VENDOR child identity disclosed by the parent approval. */
  vendorChild?: {
    operationId: string;
    idempotencyKey: string;
    authorizedRequestFingerprint: string;
  } | null;
  humanApprovalId?: string | null;
  /** Set for fixtures, generated examples, and any other non-source evidence. */
  synthetic?: boolean;
}

type PostingSubmitter = Pick<AuthoritativePostingService, "submit">;

/** Provider-neutral description used only as part of the requested object. */
export function billLineDescription(bill: ApprovedBill): string {
  const noun = bill.documentType === "receipt" ? "Receipt" : "Invoice";
  return bill.invoiceNumber?.trim()
    ? `${noun} ${bill.invoiceNumber.trim()}`
    : `Imported ${noun.toLowerCase()}`;
}

export {
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  unsupportedCurrencyReason,
  formatMoney,
  type SupportedCurrency,
} from "./currency";

function decimalAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

function requirePostingRequest(request: ApprovedBillPostingRequest): void {
  const destination = request.destination;
  if (
    !destination?.practiceId ||
    !destination.clientEntityId ||
    !destination.ledgerBookId ||
    !destination.providerConnectionId ||
    !destination.externalOrganisationId ||
    !new Set(["quickbooks", "xero"]).has(destination.provider)
  ) {
    throw new Error("An explicit canonical provider destination is required.");
  }
  if (!request.sourceDocumentId?.trim() || !request.sourceRevision?.trim()) {
    throw new Error("A durable source document and revision are required for posting.");
  }
  if (!request.idempotencyKey?.trim()) {
    throw new Error("A scoped posting idempotency key is required.");
  }
}

/**
 * Compatibility façade for legacy approval callers. It only constructs a
 * provider-neutral intent and submits it to the authoritative service. It does
 * not inspect oauth_connections, choose a provider, or invoke an adapter.
 */
export async function postApprovedBill(
  userId: string,
  bill: ApprovedBill,
  request: ApprovedBillPostingRequest,
  service?: PostingSubmitter,
): Promise<PostingSubmitResult> {
  requirePostingRequest(request);
  const destination = request.destination;
  const postingService = service ?? createAuthoritativePostingService();

  return postingService.submit(
    {
      ...destination,
      operationId: request.operationId ?? null,
      operationKind: "ACCOUNTS_PAYABLE_BILL",
      externalObjectType: "BILL",
      action: "CREATE",
      idempotencyKey: request.idempotencyKey,
      sourceActionClaim: {
        sourceKind: "FINANCIAL_DOCUMENT",
        sourceId: request.sourceDocumentId,
        sourceRevision: request.sourceRevision,
        postingSubjectKey: "ACCOUNTS_PAYABLE_BILL",
      },
      intentSchemaVersion: "step5.v1",
      canonicalizationVersion: "step5.v1",
      validationRuleSetVersion: "step5.v1",
      requestedObject: {
        documentType: bill.documentType ?? "invoice",
        supplierName: bill.supplierName,
        invoiceNumber: bill.invoiceNumber,
        invoiceDate: bill.invoiceDate,
        currency: bill.currency?.trim().toUpperCase() ?? "",
        amount: decimalAmount(bill.total),
        subtotal: decimalAmount(bill.subtotal),
        tax: decimalAmount(bill.tax),
        lineItems: bill.lineItems,
        description: billLineDescription(bill),
        vendorChild: request.vendorChild ?? null,
        synthetic: request.synthetic === true,
        liveTarget: true,
      },
      evidence: request.evidence,
      accountTreatment: request.accountTreatment,
      taxTreatment: request.taxTreatment,
      expectedMaterialState: {
        externalObjectType: "BILL",
        status: destination.provider === "quickbooks" ? "OPEN" : "DRAFT",
        currency: bill.currency?.trim().toUpperCase() ?? "",
        amount: decimalAmount(bill.total),
      },
      humanApprovalId: request.humanApprovalId ?? null,
    },
    { kind: "USER", userId },
  );
}
