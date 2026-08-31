import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAuthoritativePostingService, type AuthoritativePostingService } from "./authoritative-posting-service";
import type { PostingActor, PostingState } from "./posting-contract";
import { getValidQboAccess } from "./quickbooks";
import {
  createAuthenticatedQuickBooksPostingAdapter,
  createAuthenticatedQuickBooksVendorAdoptionAdapter,
  type QuickBooksAuthenticatedAccessClient,
  type QuickBooksAuthenticatedPostingScope,
  type QuickBooksHttpClient,
} from "./provider-adapters/quickbooks-authenticated-posting-transport";
import { getSupabase } from "./supabase";

const SANDBOX_API_BASE = "https://sandbox-quickbooks.api.intuit.com";
const PILOT_REALM_ID = "9341457595863196";
const PILOT_VENDOR_OPERATION_ID = "249d5c5b-1111-42b2-9615-108e51a31696";
const PILOT_BILL_OPERATION_ID = "1c93b544-c9b2-4f0a-a573-c96d9a07f61e";

function sandboxPilotBaseRuntimeAllowed(): boolean {
  return process.env.QUICKBOOKS_SANDBOX_PILOT_ENABLED === "true";
}

function pilotOperationsAllowed(input: QuickBooksSandboxPilotInput): boolean {
  return input.vendorOperationId === PILOT_VENDOR_OPERATION_ID &&
    input.billOperationId === PILOT_BILL_OPERATION_ID;
}

function pilotRealmAllowed(realmId: string): boolean {
  return realmId === PILOT_REALM_ID;
}

export interface QuickBooksSandboxPilotInput {
  vendorOperationId: string;
  billOperationId: string;
  externalVendorId: string;
}

export interface QuickBooksSandboxPilotScope extends QuickBooksAuthenticatedPostingScope {
  vendorState: PostingState;
  billState: PostingState;
  existingBillId: string | null;
}

export type QuickBooksSandboxPilotPrepareResult =
  | { kind: "READY"; scope: QuickBooksSandboxPilotScope }
  | { kind: "STOP"; state: PostingState; reasonCode: string };

export type QuickBooksSandboxPilotMappingResult =
  | { kind: "READY" }
  | { kind: "STOP"; state: PostingState; reasonCode: string };

export interface QuickBooksSandboxPilotAccountMappingExpectation {
  mappingId: string;
  providerAccountId: string;
  providerAccountCode: string | null;
  providerAccountName: string | null;
  providerAccountType: string;
  providerAccountSubtype: string | null;
  providerVersion: string | null;
}

export interface QuickBooksSandboxPilotTaxMappingExpectation {
  treatmentId: string;
  providerTaxCode: string;
  treatmentName: string;
  evidenceFingerprint: string;
  providerVersion: string | null;
}

export type QuickBooksSandboxPilotMappingExpectationResult =
  | {
      kind: "READY";
      account: QuickBooksSandboxPilotAccountMappingExpectation;
      tax: QuickBooksSandboxPilotTaxMappingExpectation;
    }
  | { kind: "STOP"; state: PostingState; reasonCode: string };

export interface QuickBooksSandboxPilotMappingObservation {
  account: QuickBooksSandboxPilotAccountMappingExpectation & {
    active: boolean;
    providerRequestId: string | null;
  };
  tax: QuickBooksSandboxPilotTaxMappingExpectation & {
    active: boolean;
    providerRequestId: string | null;
    verificationSource: "QBO_TAX_CODE" | "QBO_US_SPECIAL_NON";
  };
}

export type QuickBooksSandboxPilotAuthorizationResult =
  | {
      kind: "REFRESHED";
      authorizations: Array<{
        operationId: string;
        authorizationId: string;
        expiresAt: string;
        refreshed: boolean;
      }>;
    }
  | { kind: "BLOCKED"; operationId?: string; reasonCode: string };

export interface QuickBooksSandboxPilotStore {
  validateEligibility(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
  ): Promise<QuickBooksSandboxPilotPrepareResult>;
  reverifyMappings(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
  ): Promise<QuickBooksSandboxPilotMappingResult>;
  getMappingExpectations(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
  ): Promise<QuickBooksSandboxPilotMappingExpectationResult>;
  refreshMappingEligibility(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
    observation: QuickBooksSandboxPilotMappingObservation,
  ): Promise<QuickBooksSandboxPilotMappingResult>;
  refreshAuthorization(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
  ): Promise<QuickBooksSandboxPilotAuthorizationResult>;
  prepareDispatch(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
  ): Promise<QuickBooksSandboxPilotPrepareResult>;
  audit(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
    reasonCode: string,
    details: Record<string, unknown>,
  ): Promise<void>;
}

export interface QuickBooksSandboxOAuthVerifier {
  verify(userId: string, realmId: string): Promise<{ accountName: string | null }>;
}

export interface QuickBooksSandboxMappingVerifier {
  verify(
    userId: string,
    realmId: string,
    expected: Extract<QuickBooksSandboxPilotMappingExpectationResult, { kind: "READY" }>,
  ): Promise<QuickBooksSandboxPilotMappingObservation>;
}

export interface QuickBooksSandboxPilotResult {
  verdict: "SUCCEEDED" | "STOPPED";
  billOperationId: string;
  vendorOperationId: string;
  vendorState: PostingState | null;
  billState: PostingState | null;
  externalVendorId: string | null;
  externalBillId: string | null;
  reasonCode: string;
  flow: string[];
}

function payload<T>(data: unknown, label: string): T {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object") throw new Error(`${label} returned no payload`);
  return value as T;
}

export class SupabaseQuickBooksSandboxPilotStore implements QuickBooksSandboxPilotStore {
  constructor(private readonly db: SupabaseClient) {}

  async validateEligibility(input: QuickBooksSandboxPilotInput, actor: PostingActor) {
    const { data, error } = await this.db.rpc("prepare_quickbooks_sandbox_pilot_eligibility_v2", {
      p_vendor_operation_id: input.vendorOperationId,
      p_bill_operation_id: input.billOperationId,
      p_actor_user_id: actor.userId,
      p_external_vendor_id: input.externalVendorId,
    });
    if (error) throw new Error(`QuickBooks Sandbox pilot eligibility failed: ${error.message}`);
    return payload<QuickBooksSandboxPilotPrepareResult>(
      data,
      "prepare_quickbooks_sandbox_pilot_eligibility_v2",
    );
  }

  async reverifyMappings(input: QuickBooksSandboxPilotInput, actor: PostingActor) {
    const { data, error } = await this.db.rpc("reverify_quickbooks_sandbox_pilot_mappings_v1", {
      p_vendor_operation_id: input.vendorOperationId,
      p_bill_operation_id: input.billOperationId,
      p_actor_user_id: actor.userId,
    });
    if (error) throw new Error(`QuickBooks Sandbox pilot mapping revalidation failed: ${error.message}`);
    return payload<QuickBooksSandboxPilotMappingResult>(
      data,
      "reverify_quickbooks_sandbox_pilot_mappings_v1",
    );
  }

  async getMappingExpectations(input: QuickBooksSandboxPilotInput, actor: PostingActor) {
    const { data, error } = await this.db.rpc(
      "prepare_quickbooks_sandbox_pilot_mapping_refresh_v1",
      {
        p_vendor_operation_id: input.vendorOperationId,
        p_bill_operation_id: input.billOperationId,
        p_actor_user_id: actor.userId,
      },
    );
    if (error) throw new Error(`QuickBooks Sandbox mapping expectation failed: ${error.message}`);
    return payload<QuickBooksSandboxPilotMappingExpectationResult>(
      data,
      "prepare_quickbooks_sandbox_pilot_mapping_refresh_v1",
    );
  }

  async refreshMappingEligibility(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
    observation: QuickBooksSandboxPilotMappingObservation,
  ) {
    const { data, error } = await this.db.rpc(
      "refresh_quickbooks_sandbox_pilot_mapping_eligibility_v1",
      {
        p_vendor_operation_id: input.vendorOperationId,
        p_bill_operation_id: input.billOperationId,
        p_actor_user_id: actor.userId,
        p_account_observation: observation.account,
        p_tax_observation: observation.tax,
        p_ttl_seconds: 3600,
      },
    );
    if (error) throw new Error(`QuickBooks Sandbox mapping refresh failed: ${error.message}`);
    return payload<QuickBooksSandboxPilotMappingResult>(
      data,
      "refresh_quickbooks_sandbox_pilot_mapping_eligibility_v1",
    );
  }

  async refreshAuthorization(input: QuickBooksSandboxPilotInput, actor: PostingActor) {
    const { data, error } = await this.db.rpc("refresh_posting_human_authorizations_v1", {
      p_operation_ids: [input.vendorOperationId, input.billOperationId],
      p_actor_user_id: actor.userId,
      p_refresh_request_id: randomUUID(),
      p_ttl_seconds: 3600,
    });
    if (error) throw new Error(`QuickBooks Sandbox pilot authorization refresh failed: ${error.message}`);
    return payload<QuickBooksSandboxPilotAuthorizationResult>(
      data,
      "refresh_posting_human_authorizations_v1",
    );
  }

  async prepareDispatch(input: QuickBooksSandboxPilotInput, actor: PostingActor) {
    const { data, error } = await this.db.rpc("prepare_quickbooks_sandbox_pilot_v1", {
      p_vendor_operation_id: input.vendorOperationId,
      p_bill_operation_id: input.billOperationId,
      p_actor_user_id: actor.userId,
      p_external_vendor_id: input.externalVendorId,
    });
    if (error) throw new Error(`QuickBooks Sandbox pilot preflight failed: ${error.message}`);
    return payload<QuickBooksSandboxPilotPrepareResult>(data, "prepare_quickbooks_sandbox_pilot_v1");
  }

  async audit(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
    reasonCode: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.db.rpc("record_quickbooks_sandbox_pilot_event_v1", {
      p_vendor_operation_id: input.vendorOperationId,
      p_bill_operation_id: input.billOperationId,
      p_actor_user_id: actor.userId,
      p_reason_code: reasonCode,
      p_details: details,
    });
    if (error) throw new Error(`QuickBooks Sandbox pilot audit failed: ${error.message}`);
  }
}

export class LiveQuickBooksSandboxOAuthVerifier implements QuickBooksSandboxOAuthVerifier {
  constructor(
    private readonly access: QuickBooksAuthenticatedAccessClient = { getAccess: getValidQboAccess },
    private readonly http: QuickBooksHttpClient = fetch,
  ) {}

  async verify(userId: string, realmId: string): Promise<{ accountName: string | null }> {
    if (!sandboxPilotBaseRuntimeAllowed() || !pilotRealmAllowed(realmId)) {
      throw new Error("QUICKBOOKS_SANDBOX_REQUIRED");
    }
    const credential = await this.access.getAccess(userId);
    if (!credential || credential.realmId !== realmId || !credential.accessToken.trim()) {
      throw new Error("QUICKBOOKS_LIVE_OAUTH_REQUIRED");
    }
    const response = await this.http(
      `${SANDBOX_API_BASE}/v3/company/${encodeURIComponent(realmId)}` +
        `/companyinfo/${encodeURIComponent(realmId)}?minorversion=65`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: "application/json" },
      },
    );
    if (!response.ok) throw new Error("QUICKBOOKS_LIVE_OAUTH_REQUIRED");
    const body = await response.json() as { CompanyInfo?: { CompanyName?: unknown } };
    return {
      accountName: typeof body.CompanyInfo?.CompanyName === "string"
        ? body.CompanyInfo.CompanyName : null,
    };
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Read-only live verification. Only the refresh RPC below can mutate mapping freshness. */
export class LiveQuickBooksSandboxMappingVerifier implements QuickBooksSandboxMappingVerifier {
  constructor(
    private readonly access: QuickBooksAuthenticatedAccessClient = { getAccess: getValidQboAccess },
    private readonly http: QuickBooksHttpClient = fetch,
  ) {}

  private async get(
    accessToken: string,
    realmId: string,
    path: string,
  ): Promise<{ body: Record<string, unknown>; providerRequestId: string | null }> {
    const response = await this.http(
      `${SANDBOX_API_BASE}/v3/company/${encodeURIComponent(realmId)}/${path}`,
      { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    );
    if (!response.ok) throw new Error(`QUICKBOOKS_MAPPING_READ_${response.status}`);
    return { body: record(await response.json()), providerRequestId: response.headers.get("intuit_tid") };
  }

  async verify(
    userId: string,
    realmId: string,
    expected: Extract<QuickBooksSandboxPilotMappingExpectationResult, { kind: "READY" }>,
  ): Promise<QuickBooksSandboxPilotMappingObservation> {
    if (!sandboxPilotBaseRuntimeAllowed() || !pilotRealmAllowed(realmId)) {
      throw new Error("QUICKBOOKS_SANDBOX_REQUIRED");
    }
    const credential = await this.access.getAccess(userId);
    if (!credential || credential.realmId !== realmId || !credential.accessToken.trim()) {
      throw new Error("QUICKBOOKS_LIVE_OAUTH_REQUIRED");
    }

    const accountResult = await this.get(
      credential.accessToken,
      realmId,
      `account/${encodeURIComponent(expected.account.providerAccountId)}?minorversion=65`,
    );
    const account = record(accountResult.body.Account);
    const observedAccount = {
      mappingId: expected.account.mappingId,
      providerAccountId: nullableString(account.Id) ?? "",
      providerAccountCode: nullableString(account.AcctNum),
      providerAccountName: nullableString(account.Name),
      providerAccountType: nullableString(account.AccountType) ?? "",
      providerAccountSubtype: nullableString(account.AccountSubType),
      active: account.Active === true,
      providerVersion: nullableString(account.SyncToken),
      providerRequestId: accountResult.providerRequestId,
    };

    let observedTax: QuickBooksSandboxPilotMappingObservation["tax"];
    if (expected.tax.providerTaxCode === "NON" && expected.tax.treatmentName === "NON_TAXABLE") {
      // QBO's US automated-sales-tax realm uses NON as a special line code,
      // not a queryable TaxCode entity. Preferences is the live tax surface.
      const preferenceResult = await this.get(
        credential.accessToken,
        realmId,
        "preferences?minorversion=65",
      );
      const taxPrefs = record(record(preferenceResult.body.Preferences).TaxPrefs);
      if (typeof taxPrefs.UsingSalesTax !== "boolean") {
        throw new Error("QUICKBOOKS_TAX_PREFERENCES_UNVERIFIABLE");
      }
      observedTax = {
        ...expected.tax,
        active: taxPrefs.UsingSalesTax === true,
        providerRequestId: preferenceResult.providerRequestId,
        verificationSource: "QBO_US_SPECIAL_NON",
      };
    } else {
      const escapedCode = expected.tax.providerTaxCode
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'");
      const query = `select * from TaxCode where Name = '${escapedCode}'`;
      const taxResult = await this.get(
        credential.accessToken,
        realmId,
        `query?query=${encodeURIComponent(query)}&minorversion=65`,
      );
      const rows = record(taxResult.body.QueryResponse).TaxCode;
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error("QUICKBOOKS_TAX_CODE_UNVERIFIABLE");
      }
      const taxCode = record(rows[0]);
      observedTax = {
        treatmentId: expected.tax.treatmentId,
        providerTaxCode: nullableString(taxCode.Name) ?? "",
        treatmentName: expected.tax.treatmentName,
        evidenceFingerprint: expected.tax.evidenceFingerprint,
        active: taxCode.Active === true,
        providerVersion: nullableString(taxCode.SyncToken),
        providerRequestId: taxResult.providerRequestId,
        verificationSource: "QBO_TAX_CODE",
      };
    }

    return { account: observedAccount, tax: observedTax };
  }
}

function stopped(
  input: QuickBooksSandboxPilotInput,
  reasonCode: string,
  flow: string[],
  vendorState: PostingState | null,
  billState: PostingState | null,
  externalVendorId: string | null = null,
  externalBillId: string | null = null,
): QuickBooksSandboxPilotResult {
  return {
    verdict: "STOPPED",
    billOperationId: input.billOperationId,
    vendorOperationId: input.vendorOperationId,
    vendorState,
    billState,
    externalVendorId,
    externalBillId,
    reasonCode,
    flow,
  };
}

/**
 * One bounded Step-5 Sandbox pilot. It cannot create a Vendor, cannot choose a
 * destination or mapping, and cannot manufacture an operation or approval.
 */
export class QuickBooksSandboxPilotExecutor {
  constructor(
    private readonly store: QuickBooksSandboxPilotStore,
    private readonly posting: Pick<AuthoritativePostingService,
      "adoptExistingQuickBooksVendor" | "executeQuickBooksBill">,
    private readonly oauth: QuickBooksSandboxOAuthVerifier,
    private readonly mappings: QuickBooksSandboxMappingVerifier,
    private readonly accessClient?: QuickBooksAuthenticatedAccessClient,
    private readonly http?: QuickBooksHttpClient,
  ) {}

  async execute(
    input: QuickBooksSandboxPilotInput,
    actor: PostingActor,
  ): Promise<QuickBooksSandboxPilotResult> {
    const flow: string[] = [];
    if (!sandboxPilotBaseRuntimeAllowed() || !pilotOperationsAllowed(input)) {
      return stopped(input, "QUICKBOOKS_SANDBOX_REQUIRED", flow, null, null);
    }

    const eligibility = await this.store.validateEligibility(input, actor);
    if (eligibility.kind === "STOP") {
      flow.push("immutable-operation-evidence-scope:STOP");
      return stopped(input, eligibility.reasonCode, flow, null, eligibility.state);
    }
    let scope = eligibility.scope;
    flow.push("immutable-operation-evidence-scope:VERIFIED");
    if (!pilotRealmAllowed(scope.realmId)) {
      flow.push("pilot-realm:STOP");
      return stopped(
        input,
        "QUICKBOOKS_SANDBOX_REQUIRED",
        flow,
        scope.vendorState,
        scope.billState,
      );
    }
    let oauthResult: { accountName: string | null };
    try {
      oauthResult = await this.oauth.verify(actor.userId, scope.realmId);
    } catch {
      await this.store.audit(input, actor, "SANDBOX_PILOT_OAUTH_REVIEW", {
        environment: "sandbox",
        realmId: scope.realmId,
        providerConnectionId: scope.providerConnectionId,
      });
      flow.push("live-oauth:REVIEW");
      return stopped(input, "QUICKBOOKS_LIVE_OAUTH_REQUIRED", flow, scope.vendorState, scope.billState);
    }
    await this.store.audit(input, actor, "SANDBOX_PILOT_OAUTH_VERIFIED", {
      environment: "sandbox",
      realmId: scope.realmId,
      providerConnectionId: scope.providerConnectionId,
      accountName: oauthResult.accountName,
    });
    flow.push("live-oauth:VERIFIED");

    const expectedMappings = await this.store.getMappingExpectations(input, actor);
    if (expectedMappings.kind === "STOP") {
      await this.store.audit(input, actor, "SANDBOX_PILOT_LIVE_MAPPING_REVIEW", {
        reasonCode: expectedMappings.reasonCode,
        providerWrite: false,
      });
      flow.push("account-tax-mappings:REVIEW");
      return stopped(
        input,
        expectedMappings.reasonCode,
        flow,
        scope.vendorState,
        expectedMappings.state,
      );
    }
    flow.push("mapping-expectations:VERIFIED");

    let observedMappings: QuickBooksSandboxPilotMappingObservation;
    try {
      observedMappings = await this.mappings.verify(
        actor.userId,
        scope.realmId,
        expectedMappings,
      );
    } catch {
      await this.store.audit(input, actor, "SANDBOX_PILOT_LIVE_MAPPING_REVIEW", {
        reasonCode: "PILOT_LIVE_MAPPING_UNVERIFIABLE",
        providerWrite: false,
      });
      flow.push("live-account-tax-mappings:REVIEW");
      return stopped(
        input,
        "PILOT_LIVE_MAPPING_UNVERIFIABLE",
        flow,
        scope.vendorState,
        "REVIEW",
      );
    }
    flow.push("live-account-tax-mappings:VERIFIED");

    const refreshedMappings = await this.store.refreshMappingEligibility(
      input,
      actor,
      observedMappings,
    );
    if (refreshedMappings.kind === "STOP") {
      flow.push("mapping-eligibility:REVIEW");
      return stopped(
        input,
        refreshedMappings.reasonCode,
        flow,
        scope.vendorState,
        refreshedMappings.state,
      );
    }
    flow.push("mapping-eligibility:REFRESHED");

    const mappings = await this.store.reverifyMappings(input, actor);
    if (mappings.kind === "STOP") {
      flow.push("account-tax-mappings:REVIEW");
      return stopped(input, mappings.reasonCode, flow, scope.vendorState, mappings.state);
    }
    flow.push("account-tax-mappings:VERIFIED");

    if (scope.billState === "SUCCEEDED" && scope.existingBillId) {
      await this.store.audit(input, actor, "SANDBOX_PILOT_EXISTING_SUCCESS", {
        externalBillId: scope.existingBillId,
        providerWrite: false,
      });
      flow.push("bill:EXACT_EXISTING_SUCCESS");
      return {
        verdict: "SUCCEEDED",
        billOperationId: input.billOperationId,
        vendorOperationId: input.vendorOperationId,
        vendorState: scope.vendorState,
        billState: "SUCCEEDED",
        externalVendorId: input.externalVendorId,
        externalBillId: scope.existingBillId,
        reasonCode: "EXACT_RETRY_EXISTING_SUCCESS",
        flow,
      };
    }

    const authorization = await this.store.refreshAuthorization(input, actor);
    if (authorization.kind === "BLOCKED") {
      await this.store.audit(input, actor, "SANDBOX_PILOT_AUTHORIZATION_REVIEW", {
        operationId: authorization.operationId ?? null,
        reasonCode: authorization.reasonCode,
        providerWrite: false,
      });
      flow.push("exact-human-authorization:REVIEW");
      return stopped(
        input,
        authorization.reasonCode,
        flow,
        scope.vendorState,
        "REVIEW",
      );
    }
    const refreshedOperationIds = new Set(
      authorization.authorizations.map((item) => item.operationId),
    );
    if (authorization.authorizations.length !== 2 ||
        !refreshedOperationIds.has(input.vendorOperationId) ||
        !refreshedOperationIds.has(input.billOperationId)) {
      await this.store.audit(input, actor, "SANDBOX_PILOT_AUTHORIZATION_REVIEW", {
        reasonCode: "PILOT_AUTHORIZATION_REFRESH_INCOMPLETE",
        providerWrite: false,
      });
      flow.push("exact-human-authorization:REVIEW");
      return stopped(
        input,
        "PILOT_AUTHORIZATION_REFRESH_INCOMPLETE",
        flow,
        scope.vendorState,
        "REVIEW",
      );
    }
    await this.store.audit(input, actor, "SANDBOX_PILOT_AUTHORIZATION_REFRESHED", {
      authorizations: authorization.authorizations,
      providerWrite: false,
    });
    flow.push("exact-human-authorization:REFRESHED");

    // Migration 026 remains the final dispatch gate. It rechecks every prior
    // invariant after the refresh and before any provider operation.
    const prepared = await this.store.prepareDispatch(input, actor);
    if (prepared.kind === "STOP") {
      flow.push("final-dispatch-preflight:STOP");
      return stopped(input, prepared.reasonCode, flow, scope.vendorState, prepared.state);
    }
    scope = prepared.scope;
    flow.push("final-dispatch-preflight:ALLOW");

    const adapterScope: QuickBooksAuthenticatedPostingScope = {
      actorUserId: actor.userId,
      providerConnectionId: scope.providerConnectionId,
      realmId: scope.realmId,
    };
    const vendor = await this.posting.adoptExistingQuickBooksVendor(
      input.vendorOperationId,
      actor,
      input.externalVendorId,
      createAuthenticatedQuickBooksVendorAdoptionAdapter(
        adapterScope,
        this.accessClient,
        this.http,
        "sandbox",
      ),
    );
    flow.push(`vendor-adopt-read-back:${vendor.state}`);
    if (vendor.state !== "SUCCEEDED" || vendor.externalVendorId !== input.externalVendorId) {
      await this.store.audit(input, actor, "SANDBOX_PILOT_STOPPED_AFTER_VENDOR", {
        vendorState: vendor.state,
        reasonCodes: vendor.reasonCodes,
        providerWrite: false,
      });
      return stopped(
        input,
        vendor.reasonCodes[0] ?? "VENDOR_NOT_VERIFIED",
        flow,
        vendor.state,
        scope.billState,
        vendor.externalVendorId,
      );
    }

    // This durable marker must commit before asking the existing Bill gate for
    // a CREATE grant. If it fails, Bill dispatch is never attempted.
    await this.store.audit(input, actor, "SANDBOX_PILOT_VENDOR_SUCCEEDED", {
      externalVendorId: vendor.externalVendorId,
      vendorOperationId: input.vendorOperationId,
      billDispatchEligible: true,
    });
    flow.push("vendor-gate:SUCCEEDED");

    const bill = await this.posting.executeQuickBooksBill(
      input.billOperationId,
      actor,
      createAuthenticatedQuickBooksPostingAdapter(
        adapterScope,
        this.accessClient,
        this.http,
        "sandbox",
      ),
      { recoverExisting: false },
    );
    flow.push(`bill-dispatch-and-read-back:${bill.state}`);
    if (bill.state !== "SUCCEEDED" || !bill.externalBillId) {
      await this.store.audit(input, actor, "SANDBOX_PILOT_STOPPED_AFTER_BILL", {
        billState: bill.state,
        reasonCodes: bill.reasonCodes,
        recovered: bill.recovered,
      });
      return stopped(
        input,
        bill.reasonCodes[0] ?? "BILL_NOT_VERIFIED",
        flow,
        vendor.state,
        bill.state,
        vendor.externalVendorId,
        bill.externalBillId,
      );
    }
    await this.store.audit(input, actor, "SANDBOX_PILOT_SUCCEEDED", {
      externalVendorId: vendor.externalVendorId,
      externalBillId: bill.externalBillId,
      billReadBackVerified: true,
    });
    return {
      verdict: "SUCCEEDED",
      billOperationId: input.billOperationId,
      vendorOperationId: input.vendorOperationId,
      vendorState: vendor.state,
      billState: bill.state,
      externalVendorId: vendor.externalVendorId,
      externalBillId: bill.externalBillId,
      reasonCode: bill.reasonCodes[0] ?? "QUICKBOOKS_BILL_VERIFIED",
      flow,
    };
  }
}

export function createQuickBooksSandboxPilotExecutor(): QuickBooksSandboxPilotExecutor {
  const db = getSupabase();
  if (!db) throw new Error("QuickBooks Sandbox pilot requires a configured database");
  return new QuickBooksSandboxPilotExecutor(
    new SupabaseQuickBooksSandboxPilotStore(db),
    createAuthoritativePostingService(),
    new LiveQuickBooksSandboxOAuthVerifier(),
    new LiveQuickBooksSandboxMappingVerifier(),
  );
}
