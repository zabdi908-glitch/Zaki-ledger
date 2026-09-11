import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintSortedManifest } from "../lib/orchestration/shadow-canonicalization";
import { step4FrontierManifest } from "../lib/orchestration/reconciliation-adapter";

const resolveTenant = vi.fn();
const detectSchema = vi.fn();
const detectClaims = vi.fn();

vi.mock("../lib/tenant-context", () => ({
  resolveTenantContextForUser: (...args: unknown[]) => resolveTenant(...args),
}));
vi.mock("../lib/reconciliation-schema-capability", () => ({
  detectReconciliationSchemaCapability: (...args: unknown[]) => detectSchema(...args),
  detectReconciliationClaimGuardCapability: (...args: unknown[]) => detectClaims(...args),
}));
vi.mock("../lib/supabase", () => ({
  getSupabase: () => fakeDb,
  isSupabaseConfigured: () => true,
}));

const statement = {
  id: "statement-1", user_id: "user-1", client_entity_id: "client-1", ledger_book_id: "book-1",
  file_name: "feb.ofx", file_format: "ofx", statement_period_start: "2026-02-01",
  statement_period_end: "2026-02-28", currency: "GBP", opening_balance: 10,
  closing_balance: 20, transaction_count: 1, source_provider: "ofx",
  source_organisation_id: "bank-org", source_account_id: "bank-account", source_artifact_hash: "hash",
};
const bank = {
  id: "bank-observed", statement_id: "original-statement", transaction_date: "2026-02-02",
  posted_date: "2026-02-03", merchant: "Observed", description: "Observation-backed",
  amount: 999, currency: "GBP",
};
const qbRows = [
  { id: "qb-z", user_id: "user-1", client_entity_id: "client-1", ledger_book_id: "book-1",
    posted_date: "2026-03-05", amount: 1, description: "padded end" },
  { id: "qb-a", user_id: "user-1", client_entity_id: "client-1", ledger_book_id: "book-1",
    posted_date: "2026-01-27", amount: 2, description: "padded start" },
];
const matches = [
  match("holder-z", "other-statement", "qb-z", null),
  match("current-z", "statement-1", "qb-z", null),
  match("holder-a", "other-statement", "qb-a", null),
  match("old-holder", "other-statement", "qb-z", "2026-02-10T00:00:00Z"),
];

function match(id: string, statementId: string, qbId: string, supersededAt: string | null) {
  return {
    id, user_id: "user-1", statement_id: statementId, bank_transaction_id: `bank-${id}`, qb_transaction_id: qbId,
    confidence: 0.8, match_reason: "test", flagged_level: "yellow", matched_by: "auto",
    matched_at: "2026-02-03T00:00:00Z", approved_by: null, approved_at: null,
    audit_memo: null, superseded_at: supersededAt, superseded_by_match_id: null,
    supersede_reason: null, supersede_operation_id: null,
  };
}

type Filter = { op: "eq" | "gte" | "lte"; column: string; value: unknown };
const calls: Array<{ kind: string; table: string; filters?: Filter[]; columns?: string }> = [];

function rowsFor(table: string): Record<string, unknown>[] {
  if (table === "bank_statements") return [statement];
  if (table === "qb_transactions") return qbRows;
  if (table === "reconciliation_matches") return matches;
  return [];
}

function query(table: string) {
  const filters: Filter[] = [];
  let columns = "";
  const builder = {
    select(value = "*") { columns = value; return builder; },
    eq(column: string, value: unknown) { filters.push({ op: "eq", column, value }); return builder; },
    gte(column: string, value: unknown) { filters.push({ op: "gte", column, value }); return builder; },
    lte(column: string, value: unknown) { filters.push({ op: "lte", column, value }); return builder; },
    order() { return builder; },
    async maybeSingle() {
      const result = filtered();
      return { data: result[0] ?? null, error: null };
    },
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve({ data: filtered(), error: null }).then(resolve);
    },
  };
  function filtered() {
    calls.push({ kind: "select", table, filters: [...filters], columns });
    return rowsFor(table).filter((row) => filters.every(({ op, column, value }) => {
      if (op === "eq") return row[column] === value;
      if (op === "gte") return String(row[column]) >= String(value);
      return String(row[column]) <= String(value);
    }));
  }
  return builder;
}

const fakeDb = {
  from: vi.fn((table: string) => query(table)),
  rpc: vi.fn(async (name: string) => {
    calls.push({ kind: "rpc", table: name });
    if (name === "list_statement_bank_transactions_v1") return { data: [bank], error: null };
    return { data: [], error: null };
  }),
};

const { loadStep4ReconciliationFrontier } = await import("../lib/reconciliation-store");
const scope = { clientEntityId: "client-1", ledgerBookId: "book-1" };

beforeEach(() => {
  calls.length = 0;
  fakeDb.from.mockClear();
  fakeDb.rpc.mockClear();
  resolveTenant.mockReset().mockResolvedValue({
    userId: "user-1", practiceId: "practice-1", practiceMembershipId: "membership-1",
    clientEntityId: "client-1", internalLedgerBookId: "book-1",
  });
  detectSchema.mockReset().mockResolvedValue({ version: "canonical-012" });
  detectClaims.mockReset().mockResolvedValue({ version: "canonical-013" });
});

describe("Step 4 / Step 9 reconciliation frontier alignment", () => {
  it("loads the complete Step 4 frontier read-only in deterministic order", async () => {
    const frontier = await loadStep4ReconciliationFrontier("user-1", "statement-1", scope);

    expect(frontier.statement).toMatchObject({ id: "statement-1", clientEntityId: "client-1", ledgerBookId: "book-1" });
    expect(frontier.bankTransactions).toMatchObject([{ id: "bank-observed", statementId: "statement-1" }]);
    expect(frontier.qbTransactions.map((row) => row.id)).toEqual(["qb-a", "qb-z"]);
    expect(frontier.currentStatementMatches.map((row) => row.id)).toEqual(["current-z"]);
    expect(frontier.liveQbClaimHolders.map((row) => row.id)).toEqual(["current-z", "holder-a", "holder-z"]);

    expect(calls).toContainEqual({ kind: "rpc", table: "list_statement_bank_transactions_v1" });
    const qbRead = calls.find((call) => call.table === "qb_transactions");
    expect(qbRead?.filters).toEqual(expect.arrayContaining([
      { op: "gte", column: "posted_date", value: "2026-01-27" },
      { op: "lte", column: "posted_date", value: "2026-03-05" },
      { op: "eq", column: "client_entity_id", value: "client-1" },
      { op: "eq", column: "ledger_book_id", value: "book-1" },
    ]));
    expect(calls.some((call) => call.table === "bank_transactions")).toBe(false);
    expect(calls.some((call) => !["select", "rpc"].includes(call.kind))).toBe(false);
  });

  it("fails closed on canonical client/book mismatch before frontier reads", async () => {
    await expect(loadStep4ReconciliationFrontier("user-1", "statement-1", {
      clientEntityId: "wrong-client", ledgerBookId: "wrong-book",
    })).rejects.toThrow("STEP4_RECONCILIATION_FRONTIER_SCOPE_FORBIDDEN");
    expect(fakeDb.from).not.toHaveBeenCalled();
  });

  it("fails closed when the statement-owned book differs from canonical scope", async () => {
    statement.ledger_book_id = "another-book";
    try {
      await expect(loadStep4ReconciliationFrontier("user-1", "statement-1", scope))
        .rejects.toThrow("STEP4_RECONCILIATION_FRONTIER_SCOPE_FORBIDDEN");
    } finally {
      statement.ledger_book_id = "book-1";
    }
    expect(calls.some((call) => call.table === "bank_transactions")).toBe(false);
  });

  it("gives Step 9 a deterministic, lossless projection of Step 4 inputs", async () => {
    const frontier = await loadStep4ReconciliationFrontier("user-1", "statement-1", scope);
    const left = step4FrontierManifest(frontier);
    const right = step4FrontierManifest({
      ...frontier,
      bankTransactions: [...frontier.bankTransactions].reverse(),
      qbTransactions: [...frontier.qbTransactions].reverse(),
      currentStatementMatches: [...frontier.currentStatementMatches].reverse(),
      liveQbClaimHolders: [...frontier.liveQbClaimHolders].reverse(),
    });
    const fingerprint = (members: typeof left) => fingerprintSortedManifest(
      "step9-reconciliation-frontier-v1", members, (member) => `${member.namespace}:${member.id}`,
    );
    expect(fingerprint(left)).toBe(fingerprint(right));
    expect(left.map((member) => member.namespace)).toEqual([
      "bank_statement", "bank_transaction", "accounting_transaction", "accounting_transaction",
      "reconciliation_match", "qb_claim_holder", "qb_claim_holder", "qb_claim_holder",
    ]);
  });

  it("keeps Step 4 and Step 9 on the shared read path and never queries bank_transactions.ledger_book_id", () => {
    const store = readFileSync(join(process.cwd(), "lib", "reconciliation-store.ts"), "utf8");
    const step9 = readFileSync(join(process.cwd(), "lib", "orchestration", "manual-shadow-entrypoint.ts"), "utf8");
    for (const sharedStep4Read of [
      "listBankTransactions(userId, statementId)",
      "listQbTransactionsForPeriod(userId, statement.periodStart, statement.periodEnd, scope)",
      "listMatchesForStatement(userId, statementId)",
      "listAllMatchesForUser(userId)",
    ]) expect(store).toContain(sharedStep4Read);
    expect(step9).toContain("loadStep4ReconciliationFrontier");
    expect(step9).not.toMatch(/from\("bank_transactions"\)/);
    expect(`${store}\n${step9}`).not.toMatch(/from\("bank_transactions"\)[\s\S]{0,500}\.eq\("ledger_book_id"/);
  });
});
