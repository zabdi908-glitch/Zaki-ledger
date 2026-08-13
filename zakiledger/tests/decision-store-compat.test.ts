/**
 * Decision-store compatibility: the canonical client stamp must be omitted
 * from the SQL payload on pre-012 schemas (the column does not exist) and
 * present on canonical-012. Callers decide via capability detection
 * (resolveTenantClientEntityIdForWrite); recordDecision must never invent
 * or fake the stamp itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface InsertCall {
  table: string;
  payload: Record<string, unknown>;
}

const calls: InsertCall[] = [];

function builder(table: string) {
  const b: {
    insert: (payload: unknown) => unknown;
    then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
  } = {
    insert: (payload: unknown) => {
      calls.push({ table, payload: payload as Record<string, unknown> });
      return b;
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve),
  };
  return b;
}

const fakeDb = { from: (t: string) => builder(t) };

vi.mock("../lib/supabase", () => ({
  getSupabase: () => fakeDb,
  isSupabaseConfigured: () => true,
}));

import { recordDecision } from "../lib/decision-store";

const INPUT = {
  statementId: "st-1",
  matchId: "m-1",
  bankTransactionId: "bt-1",
  decisionType: "approve" as const,
  merchantName: "SHELL",
  suggestedCategory: null,
  userChoiceCategory: null,
};

beforeEach(() => {
  calls.length = 0;
});

describe("recordDecision schema compatibility", () => {
  it("omits client_entity_id from the payload when the caller passed null (pre-012)", async () => {
    await recordDecision("user-1", null, INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("reconciliation_decisions");
    expect(calls[0].payload).not.toHaveProperty("client_entity_id");
  });

  it("stamps client_entity_id when the caller resolved it (canonical-012)", async () => {
    await recordDecision("user-1", "client-1", INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({ client_entity_id: "client-1" });
  });
});
