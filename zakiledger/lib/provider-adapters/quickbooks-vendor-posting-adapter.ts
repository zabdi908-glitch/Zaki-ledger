import { canonicalJson, sha256Hex } from "../posting-contract";
import type { SanitizedProviderFailure, ProviderPostingAdapter } from "./provider-posting-adapter";

interface DestinationScope {
  practiceId: string;
  clientEntityId: string;
  ledgerBookId: string;
  providerConnectionId: string;
  externalOrganisationId: string;
}

interface QuickBooksVendorOperation extends DestinationScope {
  id: string;
  provider: "quickbooks";
  externalObjectType: "VENDOR";
  action: "CREATE";
  authorizedRequestFingerprint: string;
}

export interface QuickBooksAuthorizedVendorGrant {
  operation: QuickBooksVendorOperation & { stateAtDispatch: "AUTHORIZED" };
  attempt: { id: string; number: number; kind: "SUBMIT"; providerIdempotencyToken: string };
  requestedObject: Record<string, unknown>;
  expectedMaterialState: Record<string, unknown>;
}

export interface QuickBooksVendorRecoveryGrant {
  operation: QuickBooksVendorOperation & {
    stateAtRecovery: "SUBMITTING" | "VERIFYING" | "UNCERTAIN";
  };
  attempt: { id: string; number: number; kind: "RECOVERY"; providerIdempotencyToken: string };
  requestedObject: Record<string, unknown>;
  expectedMaterialState: Record<string, unknown>;
  knownExternalVendorId: string | null;
}

export interface QuickBooksCreateVendorRequest {
  realmId: string;
  providerConnectionId: string;
  providerIdempotencyToken: string;
  correlationTag: string;
  displayName: string;
  payload: { DisplayName: string; Active: true; Notes: string };
}

export interface QuickBooksObservedVendor {
  id: string;
  realmId: string;
  displayName: string;
  active: boolean;
  providerVersion: string | null;
}

/** This narrow transport is capability-scoped to an authorized Vendor operation. */
export interface QuickBooksVendorPostingTransport {
  createVendor(request: QuickBooksCreateVendorRequest): Promise<{
    externalVendorId: string;
    providerRequestId: string | null;
  }>;
  readVendor(realmId: string, externalVendorId: string): Promise<QuickBooksObservedVendor | null>;
  findVendorsByCorrelation(
    realmId: string,
    correlationTag: string,
  ): Promise<QuickBooksObservedVendor[]>;
}

export class QuickBooksVendorSubmissionError extends Error {
  constructor(readonly failure: SanitizedProviderFailure) {
    super(failure.summary);
    this.name = "QuickBooksVendorSubmissionError";
  }
}

export type QuickBooksVendorSubmitOutcome =
  | {
      kind: "ACKNOWLEDGED";
      externalVendorId: string;
      providerRequestId: string | null;
    }
  | { kind: "FAILED_SAFE"; failure: SanitizedProviderFailure }
  | { kind: "UNCERTAIN"; failure: SanitizedProviderFailure };

export type QuickBooksVendorRecoveryOutcome =
  | { kind: "OBSERVED"; observation: QuickBooksObservedVendor }
  | { kind: "INCONCLUSIVE"; reasonCode: string };

function scrub(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:access|refresh)[_-]?token\s*[=:]\s*[^\s,;]+/gi, "token=[REDACTED]")
    .slice(0, 240);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function correlationTag(operationId: string, fingerprint: string): string {
  return `zaki:${operationId}:${fingerprint}`;
}

export function normalizedQuickBooksVendorMaterial(
  observed: QuickBooksObservedVendor,
): Record<string, unknown> {
  return {
    externalObjectType: "VENDOR",
    displayName: text(observed.displayName, "observed Vendor display name"),
    active: observed.active === true,
  };
}

export function quickBooksVendorProviderStateFingerprint(
  observed: QuickBooksObservedVendor,
): string {
  return sha256Hex(normalizedQuickBooksVendorMaterial(observed));
}

export function expectedQuickBooksVendorMaterial(
  grant: Pick<QuickBooksAuthorizedVendorGrant, "requestedObject" | "expectedMaterialState">,
): Record<string, unknown> {
  const displayName = text(grant.requestedObject.displayName, "Vendor display name");
  const expectedName = grant.expectedMaterialState.displayName;
  if (expectedName !== undefined && text(expectedName, "expected Vendor display name") !== displayName) {
    throw new Error("Vendor display name does not match expected material state");
  }
  return { externalObjectType: "VENDOR", displayName, active: true };
}

function requestFromGrant(grant: QuickBooksAuthorizedVendorGrant): QuickBooksCreateVendorRequest {
  if (grant.operation.stateAtDispatch !== "AUTHORIZED" ||
      grant.operation.provider !== "quickbooks" ||
      grant.operation.externalObjectType !== "VENDOR" || grant.operation.action !== "CREATE") {
    throw new Error("QuickBooks Vendor adapter accepts only authorized CREATE VENDOR grants");
  }
  const material = expectedQuickBooksVendorMaterial(grant);
  const tag = correlationTag(grant.operation.id, grant.operation.authorizedRequestFingerprint);
  return {
    realmId: grant.operation.externalOrganisationId,
    providerConnectionId: grant.operation.providerConnectionId,
    providerIdempotencyToken: text(grant.attempt.providerIdempotencyToken, "provider idempotency token"),
    correlationTag: tag,
    displayName: material.displayName as string,
    // The correlation is provider-visible and is the only recovery query key.
    payload: { DisplayName: material.displayName as string, Active: true, Notes: tag },
  };
}

export class QuickBooksVendorPostingAdapter implements ProviderPostingAdapter {
  readonly provider = "quickbooks" as const;

  constructor(private readonly transport: QuickBooksVendorPostingTransport) {}

  async executeAuthorizedVendor(
    grant: QuickBooksAuthorizedVendorGrant,
  ): Promise<QuickBooksVendorSubmitOutcome> {
    let request: QuickBooksCreateVendorRequest;
    try {
      request = requestFromGrant(grant);
    } catch (error) {
      return {
        kind: "FAILED_SAFE",
        failure: {
          classification: "VALIDATION_REJECTION",
          code: "INVALID_VENDOR_EXECUTION_GRANT",
          summary: scrub(error instanceof Error ? error.message : "Invalid Vendor execution grant"),
        },
      };
    }
    try {
      const response = await this.transport.createVendor(request);
      if (!response.externalVendorId.trim()) {
        throw new QuickBooksVendorSubmissionError({
          classification: "UNCERTAIN_DELIVERY",
          code: "MALFORMED_VENDOR_CREATE_ACKNOWLEDGEMENT",
          summary: "QuickBooks create acknowledgement omitted the Vendor ID",
        });
      }
      return {
        kind: "ACKNOWLEDGED",
        externalVendorId: response.externalVendorId.trim(),
        providerRequestId: response.providerRequestId?.trim() || null,
      };
    } catch (error) {
      const failure = error instanceof QuickBooksVendorSubmissionError ? error.failure : {
        classification: "UNCERTAIN_DELIVERY" as const,
        code: "UNCLASSIFIED_VENDOR_TRANSPORT_FAILURE",
        summary: scrub(error instanceof Error ? error.message : "Unknown Vendor transport failure"),
      };
      const safeFailure = { ...failure, summary: scrub(failure.summary) };
      return failure.classification === "VALIDATION_REJECTION" ||
        failure.classification === "BEFORE_DELIVERY"
        ? { kind: "FAILED_SAFE", failure: safeFailure }
        : { kind: "UNCERTAIN", failure: safeFailure };
    }
  }

  async readBack(
    grant: QuickBooksAuthorizedVendorGrant | QuickBooksVendorRecoveryGrant,
    externalVendorId: string,
  ): Promise<QuickBooksVendorRecoveryOutcome> {
    try {
      const observed = await this.transport.readVendor(
        grant.operation.externalOrganisationId,
        externalVendorId,
      );
      return observed
        ? { kind: "OBSERVED", observation: observed }
        : { kind: "INCONCLUSIVE", reasonCode: "VENDOR_NOT_FOUND_INCONCLUSIVE" };
    } catch {
      return { kind: "INCONCLUSIVE", reasonCode: "VENDOR_READ_BACK_UNAVAILABLE" };
    }
  }

  async recover(grant: QuickBooksVendorRecoveryGrant): Promise<QuickBooksVendorRecoveryOutcome> {
    if (grant.knownExternalVendorId) return this.readBack(grant, grant.knownExternalVendorId);
    const tag = correlationTag(grant.operation.id, grant.operation.authorizedRequestFingerprint);
    try {
      const candidates = await this.transport.findVendorsByCorrelation(
        grant.operation.externalOrganisationId,
        tag,
      );
      return candidates.length === 1
        ? { kind: "OBSERVED", observation: candidates[0] }
        : { kind: "INCONCLUSIVE", reasonCode: candidates.length > 1
          ? "MULTIPLE_CORRELATED_VENDORS"
          : "VENDOR_ABSENCE_NOT_CONCLUSIVE" };
    } catch {
      return { kind: "INCONCLUSIVE", reasonCode: "VENDOR_RECOVERY_QUERY_UNAVAILABLE" };
    }
  }
}

export const __quickBooksVendorAdapterTestUtils = {
  correlationTag,
  requestFromGrant,
  stableMaterialJson: canonicalJson,
};
