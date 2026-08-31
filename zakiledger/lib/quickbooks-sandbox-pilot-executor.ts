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

export interface QuickBooksSandboxPilotStore {
  prepare(input: QuickBooksSandboxPilotInput, actor: PostingActor): Promise<QuickBooksSandboxPilotPrepareResult>;
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

  async prepare(input: QuickBooksSandboxPilotInput, actor: PostingActor) {
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

    const prepared = await this.store.prepare(input, actor);
    if (prepared.kind === "STOP") {
      flow.push("preflight:STOP");
      return stopped(input, prepared.reasonCode, flow, null, prepared.state);
    }
    const scope = prepared.scope;
    flow.push("operation-pair-and-current-gates:ALLOW");
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
  );
}
