import { describe, expect, it } from "vitest";
import { QuickBooksDestinationOnboardingService, type QuickBooksDestinationOnboardingStore } from "../lib/quickbooks-destination-onboarding";

const actor = { kind: "USER" as const, userId: "actor-1" };
const request = { practiceId: "practice-1", clientEntityId: "client-1", ledgerBookId: "book-1", realmId: "realm-1", idempotencyKey: "pilot-onboarding-1", accountMappings: [{ financialAccountId: "account-1", providerAccountId: "qb-6000", eligibilityExpiresAt: "2030-01-01T00:00:00Z" }], taxMappings: [{ providerTaxCode: "S20", treatmentName: "UK standard", eligibilityExpiresAt: "2030-01-01T00:00:00Z" }] };
const discovery = { discover: async () => ({ realmId: "realm-1", fingerprint: "a".repeat(64), accounts: [{ id: "qb-6000", name: "Office costs", type: "Expense", active: true, postable: true }], taxes: [{ code: "S20", name: "Standard", active: true, evidenceFingerprint: "b".repeat(64) }] }) };

describe("QuickBooks canonical destination onboarding", () => {
  it("binds only discovered active account/tax identities to the selected realm", async () => {
    let input: Record<string, unknown> | undefined;
    const store: QuickBooksDestinationOnboardingStore = { complete: async (value) => { input = value; return { outcome: "CREATED", operationId: "op-1", providerConnectionId: "connection-1" }; } };
    const result = await new QuickBooksDestinationOnboardingService(discovery, store).onboard(request, actor);
    expect(result.outcome).toBe("CREATED");
    expect(input?.p_realm_id).toBe("realm-1");
    expect((input?.p_account_mappings as Array<Record<string, unknown>>)[0].providerAccountName).toBe("Office costs");
    expect((input?.p_tax_mappings as Array<Record<string, unknown>>)[0].evidenceFingerprint).toBe("b".repeat(64));
  });
  it("rejects undiscovered account selection before any DB mutation", async () => {
    const store: QuickBooksDestinationOnboardingStore = { complete: async () => { throw new Error("must not write"); } };
    await expect(new QuickBooksDestinationOnboardingService(discovery, store).onboard({ ...request, accountMappings: [{ ...request.accountMappings[0], providerAccountId: "first-expense" }] }, actor)).rejects.toThrow("active and discovered");
  });
  it("rejects realm substitution before any DB mutation", async () => {
    const store: QuickBooksDestinationOnboardingStore = { complete: async () => { throw new Error("must not write"); } };
    const badDiscovery = { ...discovery, discover: async () => ({ ...(await discovery.discover()), realmId: "other-realm" }) };
    await expect(new QuickBooksDestinationOnboardingService(badDiscovery, store).onboard(request, actor)).rejects.toThrow("realm does not match");
  });
  it("rejects inactive or non-postable accounts and expired tax eligibility before DB mutation", async () => {
    const store: QuickBooksDestinationOnboardingStore = { complete: async () => { throw new Error("must not write"); } };
    const inactive = { discover: async () => ({ ...(await discovery.discover()), accounts: [{ ...(await discovery.discover()).accounts[0], postable: false }] }) };
    await expect(new QuickBooksDestinationOnboardingService(inactive, store).onboard(request, actor)).rejects.toThrow("active and discovered");
    await expect(new QuickBooksDestinationOnboardingService(discovery, store).onboard({ ...request, taxMappings: [{ ...request.taxMappings[0], eligibilityExpiresAt: "2020-01-01T00:00:00Z" }] }, actor)).rejects.toThrow("Tax-mapping eligibility");
  });
  it("does not write if the provider discovery read fails", async () => {
    let writes = 0;
    const store: QuickBooksDestinationOnboardingStore = { complete: async () => { writes += 1; return { outcome: "CREATED" }; } };
    await expect(new QuickBooksDestinationOnboardingService({ discover: async () => { throw new Error("read failed"); } }, store).onboard(request, actor)).rejects.toThrow("read failed");
    expect(writes).toBe(0);
  });
});
