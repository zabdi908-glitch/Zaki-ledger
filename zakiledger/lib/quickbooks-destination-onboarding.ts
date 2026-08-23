import { canonicalJson, sha256Hex, type PostingActor } from "./posting-contract";

export type QuickBooksDiscoveredAccount = {
  id: string; name: string; type: string; subtype?: string | null; code?: string | null; version?: string | null; active: boolean; postable: boolean;
};
export type QuickBooksDiscoveredTax = { code: string; name: string; active: boolean; version?: string | null; evidenceFingerprint: string };
export interface QuickBooksDestinationDiscoveryTransport {
  discover(realmId: string): Promise<{ realmId: string; accounts: QuickBooksDiscoveredAccount[]; taxes: QuickBooksDiscoveredTax[]; fingerprint: string }>;
}
export type QuickBooksDestinationOnboardingRequest = {
  practiceId: string; clientEntityId: string; ledgerBookId: string; realmId: string; idempotencyKey: string;
  accountMappings: Array<{ financialAccountId: string; providerAccountId: string; eligibilityExpiresAt: string }>;
  taxMappings: Array<{ providerTaxCode: string; treatmentName: string; eligibilityExpiresAt: string }>;
};
export type QuickBooksDestinationOnboardingResult = { outcome: "CREATED" | "RESUMED" | "IDEMPOTENCY_CONFLICT" | "DESTINATION_REJECTED" | "OAUTH_DESTINATION_REJECTED"; operationId?: string; providerConnectionId?: string };

export interface QuickBooksDestinationOnboardingStore {
  complete(input: Record<string, unknown>): Promise<QuickBooksDestinationOnboardingResult>;
}

/** Canonical destination setup only: discovery is read-only and the store owns all DB mutation. */
export class QuickBooksDestinationOnboardingService {
  constructor(private readonly discovery: QuickBooksDestinationDiscoveryTransport, private readonly store: QuickBooksDestinationOnboardingStore) {}

  async onboard(request: QuickBooksDestinationOnboardingRequest, actor: PostingActor): Promise<QuickBooksDestinationOnboardingResult> {
    if (actor.kind !== "USER" || !request.idempotencyKey.trim()) throw new Error("A user actor and scoped onboarding idempotency key are required.");
    const discovered = await this.discovery.discover(request.realmId);
    if (discovered.realmId !== request.realmId) throw new Error("QuickBooks discovery realm does not match the requested destination.");
    const now = Date.now();
    const accounts = new Map(discovered.accounts.filter((account) => account.active && account.postable).map((account) => [account.id, account]));
    const taxes = new Map(discovered.taxes.filter((tax) => tax.active).map((tax) => [tax.code, tax]));
    const validExpiry = (value: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
    const accountMappings = request.accountMappings.map((mapping) => {
      if (!validExpiry(mapping.eligibilityExpiresAt)) throw new Error("Posting-account eligibility must be valid in the future.");
      const account = accounts.get(mapping.providerAccountId);
      if (!account) throw new Error("Every mapped QuickBooks posting account must be active and discovered.");
      return { ...mapping, providerAccountCode: account.code ?? null, providerAccountName: account.name, providerAccountType: account.type, providerAccountSubtype: account.subtype ?? null, providerVersion: account.version ?? null };
    });
    const taxMappings = request.taxMappings.map((mapping) => {
      if (!validExpiry(mapping.eligibilityExpiresAt)) throw new Error("Tax-mapping eligibility must be valid in the future.");
      const tax = taxes.get(mapping.providerTaxCode);
      if (!tax) throw new Error("Every mapped QuickBooks tax code must be active and discovered.");
      return { ...mapping, evidenceFingerprint: tax.evidenceFingerprint, providerVersion: tax.version ?? null };
    });
    const requestFingerprint = sha256Hex(canonicalJson({ ...request, accountMappings, taxMappings }));
    return this.store.complete({
      p_practice_id: request.practiceId, p_client_entity_id: request.clientEntityId, p_ledger_book_id: request.ledgerBookId,
      p_actor_user_id: actor.userId, p_realm_id: request.realmId, p_idempotency_key: request.idempotencyKey,
      p_request_fingerprint_hex: requestFingerprint, p_discovery_fingerprint_hex: discovered.fingerprint,
      p_account_mappings: accountMappings, p_tax_mappings: taxMappings,
    });
  }
}

export class SupabaseQuickBooksDestinationOnboardingStore implements QuickBooksDestinationOnboardingStore {
  constructor(private readonly db: { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> }) {}
  async complete(input: Record<string, unknown>): Promise<QuickBooksDestinationOnboardingResult> {
    const { data, error } = await this.db.rpc("complete_quickbooks_destination_onboarding_v1", input);
    if (error) throw new Error(`QuickBooks destination onboarding failed: ${error.message}`);
    return data as QuickBooksDestinationOnboardingResult;
  }
}
