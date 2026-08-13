/**
 * Reconciliation write-path compatibility matrix (unit level).
 *
 * State machine under test:
 *  - 011 / freeze OFF  -> pre-4C legacy writes: no canonical tenant
 *    resolution, no canonical fields in any SQL/RPC payload.
 *  - 011 / freeze ON   -> every writer throws the frozen error before
 *    capability detection, tenant resolution, or any DB call.
 *  - 012 / freeze OFF  -> canonical tenant resolution + stamps mandatory;
 *    resolution failure propagates (fail closed, no legacy fallback).
 *  - 012 / freeze ON   -> frozen before anything else.
 *
 * Capability is mocked here (the real detection has its own suite in
 * reconciliation-schema-capability.test.ts); the store branches are
 * exercised with a recording fake database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detectMock = vi.fn();
const resolveTenantMock = vi.fn();

vi.mock("../lib/reconciliation-schema-capability", () => ({
  detectReconciliationSchemaCapability: (...args: unknown[]) => detectMock(...args),
}));

vi.mock("../lib/tenant-context", () => ({
  resolveTenantContextForUser: (...args: unknown[]) => resolveTenantMock(...args),
}));

vi.mock("../lib/supabase", () => ({
  getSupabase: () => fakeDb,
  isSupabaseConfigured: () => true,
}));
import {
  approveMatches,
  computeAndPersistMatches,
  createManualMatch,
  saveBankStatement,
  saveQbTransactions,
  unapproveMatches,
} from "../lib/reconciliation-store";
import { isReconciliationWriteFrozen } from "../lib/reconciliation-freeze";

const U = "user-1";
const TENANT = {
  userId: U,
  practiceId: "practice-1",
  practiceMembershipId: "membership-1",
  clientEntityId: "client-1",
  internalLedgerBookId: "book-1",
};

const BANK_TXN_ROW = {
  id: "bt-1",
  statement_id: "st-1",
  transaction_date: "2026-01-05",
  posted_date: "2026-01-06",
  merchant: "SHELL",
  description: "SHELL FUEL",
  amount: 100,
  currency: "GBP",
};

const QB_TXN_ROW = {
  id: "qb-1",
  qb_transaction_id: "Q1",
  posted_date: "2026-01-06",
  amount: 100,
  description: "SHELL FUEL",
};

const MATCH_ROW = {
  id: "m-1",
  statement_id: "st-1",
  bank_transaction_id: "bt-1",
  qb_transaction_id: "qb-1",
  confidence: 0.99,
  match_reason: "test",
  flagged_level: "green",
  matched_by: "auto",
  matched_at: "2026-01-06T10:00:00Z",
  approved_by: U,
  approved_at: "2026-01-07T10:00:00Z",
  audit_memo: null,
};

const fakeDb = makeFakeDb();

const STATEMENT_ROW = {
  id: "st-1",
  file_name: "s.csv",
  file_format: "csv",
  statement_period_start: "2026-01-01",
  statement_period_end: "2026-01-31",
  currency: "GBP",
  opening_balance: 0,
  closing_balance: 0,
  transaction_count: 1,
  source_provider: "csv",
  source_organisation_id: null,
  source_account_id: null,
  source_artifact_hash: null,
};

interface FakeCall {
  method: string;
  table: string;
  payload?: Record<string, unknown>;
  args?: unknown;
}

function makeFakeDb() {
  const calls: FakeCall[] = [];
  const rpc = vi.fn(async (name: string, args: unknown) => {
    calls.push({ method: "rpc", table: name, args });
    if (name === "list_statement_bank_transactions_v1") {
      return { data: [BANK_TXN_ROW], error: null };
    }
    return { data: [], error: null };
  });

  const rowSets: Record<string, unknown[]> = {
    qb_transactions: [QB_TXN_ROW],
    reconciliation_matches: [MATCH_ROW],
  };

  function builder(table: string) {
    const b: {
      select: () => unknown;
      eq: () => unknown;
      in: () => unknown;
      not: () => unknown;
      order: () => unknown;
      limit: () => unknown;
      gte: () => unknown;
      lte: () => unknown;
      maybeSingle: () => Promise<{ data: unknown; error: null }>;
      insert: (payload: unknown) => unknown;
      update: (payload: unknown) => unknown;
      upsert: (payload: unknown, opts?: unknown) => unknown;
      delete: () => unknown;
      single: () => Promise<{ data: unknown; error: null }>;
      then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
    } = {
      select: () => b,
      eq: () => b,
      in: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      gte: () => b,
      lte: () => b,
      maybeSingle: async () => ({
        data: table === "bank_statements" ? { ...STATEMENT_ROW, user_id: U } : null,
        error: null,
      }),
      insert: (payload: unknown) => {
        calls.push({ method: "insert", table, payload: payload as Record<string, unknown> });
        return b;
      },
      update: (payload: unknown) => {
        calls.push({ method: "update", table, payload: payload as Record<string, unknown> });
        return b;
      },
      upsert: (payload: unknown, opts?: unknown) => {
        calls.push({ method: "upsert", table, payload: payload as Record<string, unknown>, args: opts });
        return b;
      },
      delete: () => {
        calls.push({ method: "delete", table });
        return b;
      },
      single: async () => ({ data: { id: "row-1" }, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rowSets[table] ?? [], error: null }).then(resolve),
    };
    return b;
  }

  return { rpc, from: (table: string) => builder(table), calls };
}

function callsFor(method: string, table: string): FakeCall[] {
  return fakeDb.calls.filter((c) => c.method === method && c.table === table);
}

const PARSED_STATEMENT = {
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  currency: "GBP",
  openingBalance: 0,
  closingBalance: 0,
  sourceProvider: "csv",
  sourceOrganisationId: null,
  sourceAccountId: null,
  sourceAccountMetadata: null,
  transactions: [
    {
      transactionDate: { value: "2026-01-05" },
      postedDate: "2026-01-06",
      merchant: { value: "SHELL" },
      description: { value: "SHELL FUEL" },
      amount: { value: 100 },
      currency: "GBP",
      transactionId: "T1",
      memo: null,
    },
  ],
};

beforeEach(() => {
  delete process.env.ZAKI_RECONCILIATION_WRITE_FREEZE;
  fakeDb.calls.length = 0;
  fakeDb.rpc.mockClear();
  detectMock.mockReset();
  resolveTenantMock.mockReset();
});

afterEach(() => {
  delete process.env.ZAKI_RECONCILIATION_WRITE_FREEZE;
});

describe("pre-012 (freeze OFF) — legacy writes, no canonical fields", () => {
  beforeEach(() => {
    detectMock.mockResolvedValue({ version: "pre-012" });
    resolveTenantMock.mockImplementation(async () => {
      throw new Error("tenant resolver must not be called on pre-012");
    });
  });

  it("saveBankStatement sends the 011 payload without canonical stamps and resolves no tenant", async () => {
    await saveBankStatement(U, "s.csv", "csv", PARSED_STATEMENT as never);
    const rpc = callsFor("rpc", "ingest_bank_statement_v1");
    expect(rpc).toHaveLength(1);
    const statement = (rpc[0].args as { p_statement: Record<string, unknown> }).p_statement;
    expect(statement).not.toHaveProperty("client_entity_id");
    expect(statement).not.toHaveProperty("ledger_book_id");
    expect(resolveTenantMock).not.toHaveBeenCalled();
    expect(detectMock).toHaveBeenCalledWith(fakeDb);
  });

  it("saveQbTransactions sends 011 payloads without canonical stamps", async () => {
    await saveQbTransactions(U, [
      { qbTransactionId: "Q1", postedDate: "2026-01-06", amount: 100 },
    ]);
    const rpc = callsFor("rpc", "ingest_accounting_transactions_v1");
    expect(rpc).toHaveLength(1);
    const items = (rpc[0].args as { p_transactions: Record<string, unknown>[] }).p_transactions;
    for (const item of items) {
      expect(item).not.toHaveProperty("client_entity_id");
      expect(item).not.toHaveProperty("ledger_book_id");
    }
    expect(resolveTenantMock).not.toHaveBeenCalled();
  });

  it("createManualMatch upserts without client_entity_id", async () => {
    await createManualMatch(U, "st-1", "bt-1", "qb-1");
    const upserts = callsFor("upsert", "reconciliation_matches");
    expect(upserts.length).toBeGreaterThan(0);
    for (const u of upserts) {
      expect(u.payload).not.toHaveProperty("client_entity_id");
    }
    expect(resolveTenantMock).not.toHaveBeenCalled();
  });

  it("approveMatches writes audit rows and report without canonical fields", async () => {
    await approveMatches(U, "st-1", ["m-1"], U);
    for (const a of callsFor("insert", "reconciliation_audit_log")) {
      const rows = a.payload as unknown as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).not.toHaveProperty("user_id");
        expect(row).not.toHaveProperty("client_entity_id");
      }
    }
    for (const r of callsFor("upsert", "reconciliation_reports")) {
      expect(r.payload).not.toHaveProperty("client_entity_id");
    }
    expect(resolveTenantMock).not.toHaveBeenCalled();
  });

  it("unapproveMatches writes audit rows without canonical fields", async () => {
    await unapproveMatches(U, "st-1", ["m-1"]);
    for (const a of callsFor("insert", "reconciliation_audit_log")) {
      const rows = a.payload as unknown as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).not.toHaveProperty("user_id");
        expect(row).not.toHaveProperty("client_entity_id");
      }
    }
    expect(resolveTenantMock).not.toHaveBeenCalled();
  });
});

describe("canonical-012 (freeze OFF) — mandatory stamps, fail closed", () => {
  beforeEach(() => {
    detectMock.mockResolvedValue({ version: "canonical-012" });
    resolveTenantMock.mockResolvedValue(TENANT);
  });

  it("saveBankStatement stamps client_entity_id and ledger_book_id", async () => {
    await saveBankStatement(U, "s.csv", "csv", PARSED_STATEMENT as never);
    const rpc = callsFor("rpc", "ingest_bank_statement_v1");
    expect(rpc).toHaveLength(1);
    const statement = (rpc[0].args as { p_statement: Record<string, unknown> }).p_statement;
    expect(statement).toMatchObject({
      client_entity_id: "client-1",
      ledger_book_id: "book-1",
    });
    expect(resolveTenantMock).toHaveBeenCalledWith(U);
  });

  it("saveQbTransactions stamps every item", async () => {
    await saveQbTransactions(U, [
      { qbTransactionId: "Q1", postedDate: "2026-01-06", amount: 100 },
    ]);
    const rpc = callsFor("rpc", "ingest_accounting_transactions_v1");
    const items = (rpc[0].args as { p_transactions: Record<string, unknown>[] }).p_transactions;
    for (const item of items) {
      expect(item).toMatchObject({
        client_entity_id: "client-1",
        ledger_book_id: "book-1",
      });
    }
  });

  it("createManualMatch upserts with client_entity_id", async () => {
    await createManualMatch(U, "st-1", "bt-1", "qb-1");
    for (const u of callsFor("upsert", "reconciliation_matches")) {
      expect(u.payload).toMatchObject({ client_entity_id: "client-1" });
    }
  });

  it("approveMatches stamps audit rows (user + client) and the report", async () => {
    await approveMatches(U, "st-1", ["m-1"], U);
    for (const a of callsFor("insert", "reconciliation_audit_log")) {
      const rows = a.payload as unknown as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatchObject({ user_id: U, client_entity_id: "client-1" });
      }
    }
    for (const r of callsFor("upsert", "reconciliation_reports")) {
      expect(r.payload).toMatchObject({ client_entity_id: "client-1" });
    }
  });

  it("unapproveMatches stamps audit rows (user + client)", async () => {
    await unapproveMatches(U, "st-1", ["m-1"]);
    for (const a of callsFor("insert", "reconciliation_audit_log")) {
      const rows = a.payload as unknown as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatchObject({ user_id: U, client_entity_id: "client-1" });
      }
    }
  });

  it("a failing tenant resolution propagates — no legacy fallback", async () => {
    resolveTenantMock.mockRejectedValue(new Error("Canonical tenant context not found for user"));
    await expect(saveBankStatement(U, "s.csv", "csv", PARSED_STATEMENT as never)).rejects.toThrow(
      "Canonical tenant context not found for user",
    );
    expect(callsFor("rpc", "ingest_bank_statement_v1")).toHaveLength(0);
  });
});

describe("freeze ON (any schema) — frozen before capability, resolution, or mutation", () => {
  beforeEach(() => {
    process.env.ZAKI_RECONCILIATION_WRITE_FREEZE = "1";
  });

  it("saveBankStatement throws frozen without touching the database", async () => {
    await expect(saveBankStatement(U, "s.csv", "csv", PARSED_STATEMENT as never)).rejects.toThrow(
      "frozen",
    );
    expect(detectMock).not.toHaveBeenCalled();
    expect(fakeDb.calls).toHaveLength(0);
    expect(isReconciliationWriteFrozen()).toBe(true);
  });

  it("saveQbTransactions throws frozen without touching the database", async () => {
    await expect(
      saveQbTransactions(U, [{ qbTransactionId: "Q1", postedDate: "2026-01-06", amount: 100 }]),
    ).rejects.toThrow("frozen");
    expect(fakeDb.calls).toHaveLength(0);
  });

  it("computeAndPersistMatches throws frozen before any read or write", async () => {
    await expect(computeAndPersistMatches(U, "st-1")).rejects.toThrow("frozen");
    expect(fakeDb.calls).toHaveLength(0);
  });

  it("createManualMatch throws frozen before any read or write", async () => {
    await expect(createManualMatch(U, "st-1", "bt-1", "qb-1")).rejects.toThrow("frozen");
    expect(fakeDb.calls).toHaveLength(0);
  });

  it("approveMatches throws frozen before any read or write", async () => {
    await expect(approveMatches(U, "st-1", ["m-1"], U)).rejects.toThrow("frozen");
    expect(fakeDb.calls).toHaveLength(0);
  });

  it("unapproveMatches throws frozen before any read or write", async () => {
    await expect(unapproveMatches(U, "st-1", ["m-1"])).rejects.toThrow("frozen");
    expect(fakeDb.calls).toHaveLength(0);
  });
});
