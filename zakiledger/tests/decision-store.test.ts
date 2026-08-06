import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => ({
  getSupabase: () => null,
  isSupabaseConfigured: () => false,
}));

import {
  bumpMerchantPreference, getMerchantPreferences, listDecisionsForStatement,
  recordDecision, setMerchantDefault, __clearDecisionMemForTests,
} from "../lib/decision-store";

const U = "user-1";

beforeEach(() => __clearDecisionMemForTests());

describe("decision log", () => {
  it("records and lists decisions scoped by user and statement", async () => {
    await recordDecision(U, {
      statementId: "s1", matchId: "m1", bankTransactionId: "b1",
      decisionType: "approve", merchantName: "SHELL", suggestedCategory: "Motor Expenses", userChoiceCategory: null,
    });
    await recordDecision("other-user", {
      statementId: "s1", matchId: "m2", bankTransactionId: "b2",
      decisionType: "reject", merchantName: null, suggestedCategory: null, userChoiceCategory: null,
    });
    const mine = await listDecisionsForStatement(U, "s1");
    expect(mine).toHaveLength(1);
    expect(mine[0].decisionType).toBe("approve");
  });
});

describe("merchant preferences", () => {
  it("bump upserts and increments, normalising the merchant name", async () => {
    await bumpMerchantPreference(U, "  SHELL Petrol  ", "Motor Expenses");
    await bumpMerchantPreference(U, "shell petrol", "Motor Expenses");
    const prefs = await getMerchantPreferences(U);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ merchantName: "shell petrol", category: "Motor Expenses", approvalCount: 2 });
  });
  it("a category change resets the count to 1 for the new category", async () => {
    await bumpMerchantPreference(U, "amazon", "Office Supplies");
    await bumpMerchantPreference(U, "amazon", "Software & SaaS");
    const prefs = await getMerchantPreferences(U);
    expect(prefs[0]).toMatchObject({ category: "Software & SaaS", approvalCount: 1 });
  });
  it("setMerchantDefault jumps straight to learned (count 3)", async () => {
    await setMerchantDefault(U, "wise transfer", "Transfer");
    const prefs = await getMerchantPreferences(U);
    expect(prefs[0].approvalCount).toBe(3);
  });
});
