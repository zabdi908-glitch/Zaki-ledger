import { describe, expect, it, vi } from "vitest";
import {
  BalanceReconciliationShadowExecutor,
  PairedOfxBalanceEvidenceReader,
  QuickBooksGeneralLedgerBalanceReader,
  exactDecimalToMinor,
  type BalanceShadowRequest,
  type BalanceShadowResult,
  type BalanceShadowScope,
  type BalanceShadowStore,
  type BalanceSideEvidence,
} from "../lib/balance-reconciliation-shadow";

const SCOPE: BalanceShadowScope = {
  scopeId: "31000000-0000-0000-0000-000000000001",
  clientEntityId: "31000000-0000-0000-0000-000000000002",
  accountClass: "asset",
  currencyCode: "GBP",
  minorUnitExponent: 2,
  accountTimezone: "UTC",
  sourceProvider: "ofx",
  sourceOrganisationId: null,
  sourceAccountId: "123:456",
  sourceDateBasis: "posted_date",
  sourceBalanceSignMultiplier: 1,
  ledgerProvider: "quickbooks",
  ledgerProviderConnectionId: "31000000-0000-0000-0000-000000000003",
  ledgerOrganisationId: "realm-shadow",
  ledgerAccountId: "35",
  ledgerDateBasis: "accounting_date",
  ledgerBalanceSignMultiplier: 1,
};

function ofx(
  start: string,
  end: string,
  balance: string,
  transactions = "",
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>GBP</CURDEF><BANKACCTFROM><BANKID>123</BANKID><ACCTID>456</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>${start}000000</DTSTART><DTEND>${end}000000</DTEND>${transactions}</BANKTRANLIST>
<LEDGERBAL><BALAMT>${balance}</BALAMT><DTASOF>${end}000000</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

const OPENING_OFX = ofx("20251201", "20251231", "100.00");
const CLOSING_OFX = ofx(
  "20260101",
  "20260131",
  "110.00",
  "<STMTTRN><DTPOSTED>20260115000000</DTPOSTED><TRNAMT>10.00</TRNAMT><FITID>deposit-1</FITID></STMTTRN>",
);

const REQUEST: BalanceShadowRequest = {
  actorUserId: "31000000-0000-0000-0000-000000000004",
  scopeId: SCOPE.scopeId,
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  openingArtifactId: "31000000-0000-0000-0000-000000000005",
  closingArtifactId: "31000000-0000-0000-0000-000000000006",
  openingOfx: OPENING_OFX,
  closingOfx: CLOSING_OFX,
};

function qboReport(input: {
  end?: string;
  basis?: string;
  actualColumnKeys?: boolean;
  blankSummary?: boolean;
  movements?: Array<{ date: string; amount: string; balance: string }>;
} = {}) {
  const column = (key: string) => ({ MetaData: [{ Name: "ColKey", Value: key }] });
  const actual = input.actualColumnKeys ?? true;
  const movements = input.movements ?? [{ date: "2026-01-15", amount: "10.00", balance: "110.00" }];
  return {
    Header: {
      ReportName: "GeneralLedger",
      ReportBasis: input.basis ?? "Accrual",
      StartPeriod: "2026-01-01",
      EndPeriod: input.end ?? "2026-01-31",
      Currency: "GBP",
    },
    Columns: { Column: [
      column("tx_date"), column("txn_type"),
      column(actual ? "subt_nat_amount" : "amount"),
      column(actual ? "rbal_nat_amount" : "balance"),
    ] },
    Rows: {
      Row: [{
        Header: { ColData: [{ value: "Proof Bank", id: "35" }] },
        Rows: { Row: [
          { ColData: [{ value: "" }, { value: "Beginning Balance" }, { value: "" }, { value: "100.00" }] },
          ...movements.map((movement) => ({ ColData: [
            { value: movement.date }, { value: "Deposit" },
            { value: movement.amount }, { value: movement.balance },
          ] })),
        ] },
        Summary: { ColData: input.blankSummary
          ? [{ value: "Total for Proof Bank" }, { value: "" }, { value: "" }, { value: "" }]
          : [{ value: "" }, { value: "Total" }, { value: "10.00" }, { value: "110.00" }] },
      }],
    },
  };
}

function qboTrialBalance(input: {
  cutoff: string;
  balance?: string;
  basis?: string;
  start?: string;
  currency?: string;
  accountRows?: number;
}) {
  const accountRows = input.accountRows ?? 1;
  return {
    Header: {
      ReportName: "TrialBalance",
      ReportBasis: input.basis ?? "Accrual",
      StartPeriod: input.start ?? "2026-01-01",
      EndPeriod: input.cutoff,
      Currency: input.currency ?? "GBP",
    },
    Rows: { Row: Array.from({ length: accountRows }, () => ({
      ColData: [
        { value: "Proof Bank", id: "35" },
        { value: input.balance ?? "100.00" },
        { value: "" },
      ],
    })) },
  };
}

function qboReader(input: {
  generalLedger?: ReturnType<typeof qboReport>;
  openingTrialBalance?: ReturnType<typeof qboTrialBalance>;
  closingTrialBalance?: ReturnType<typeof qboTrialBalance>;
} = {}) {
  const calls: Array<{ url: string; method?: string }> = [];
  const bodies = [
    { Account: { Id: "35", Active: true, CurrencyRef: { value: "GBP" } } },
    input.generalLedger ?? qboReport(),
    input.openingTrialBalance ?? qboTrialBalance({ cutoff: "2025-12-31", balance: "100.00", start: "2025-01-01" }),
    input.closingTrialBalance ?? qboTrialBalance({ cutoff: "2026-01-31", balance: "110.00" }),
  ];
  const http = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method });
    const body = bodies.shift();
    return {
      ok: true,
      status: 200,
      headers: { get: () => "intuit-read-id" },
      json: async () => body,
    };
  });
  const reader = new QuickBooksGeneralLedgerBalanceReader(
    { actorUserId: REQUEST.actorUserId, providerConnectionId: SCOPE.ledgerProviderConnectionId, realmId: SCOPE.ledgerOrganisationId },
    { getAccess: async () => ({ accessToken: "read-token", realmId: SCOPE.ledgerOrganisationId }) },
    http,
  );
  return { reader, calls, http };
}

describe("Step 6 read-only balance shadow path", () => {
  it("uses exact minor-unit conversion without floating point rounding", () => {
    expect(exactDecimalToMinor("90071992547409.93", 2)).toBe(9007199254740993n);
    expect(() => exactDecimalToMinor("1.001", 2)).toThrow(/precision/i);
  });

  it("reads paired OFX opening/closing balances and proves its complete movement set", async () => {
    const evidence = await new PairedOfxBalanceEvidenceReader().read(REQUEST, SCOPE);
    expect(evidence).toMatchObject({
      side: "source",
      provider: "ofx",
      accountId: "123:456",
      movementTotalMinor: "1000",
      completenessState: "complete",
      paginationComplete: true,
      terminalBoundarySeen: true,
      coverageComplete: true,
      returnedCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
    });
    expect(evidence.opening).toMatchObject({ balanceMinor: "10000", asOfExclusive: "2026-01-01T00:00:00.000Z" });
    expect(evidence.closing).toMatchObject({ balanceMinor: "11000", asOfExclusive: "2026-02-01T00:00:00.000Z" });
  });

  it("retains incomplete OFX pagination/coverage evidence instead of claiming complete", async () => {
    const duplicate = CLOSING_OFX.replace(
      "</BANKTRANLIST>",
      "<STMTTRN><DTPOSTED>20260116000000</DTPOSTED><TRNAMT>1.00</TRNAMT><FITID>deposit-1</FITID></STMTTRN></BANKTRANLIST>",
    );
    const evidence = await new PairedOfxBalanceEvidenceReader().read({ ...REQUEST, closingOfx: duplicate }, SCOPE);
    expect(evidence.completenessState).toBe("incomplete");
    expect(evidence.duplicateCount).toBe(1);
    expect(evidence.coverageComplete).toBe(false);
    expect(evidence.incompletenessReason).toContain("OFX_ROWS_INCOMPLETE");
  });

  it("reads exact-period GL movements using actual QuickBooks column keys and Trial Balance cutoffs", async () => {
    const target = qboReader();
    const evidence = await target.reader.read(REQUEST, SCOPE);
    expect(evidence).toMatchObject({
      side: "ledger",
      provider: "quickbooks",
      organisationId: "realm-shadow",
      accountId: "35",
      movementTotalMinor: "1000",
      completenessState: "complete",
      paginationMode: "not_applicable",
      pageCount: 1,
      paginationComplete: true,
    });
    expect(evidence.opening.balanceMinor).toBe("10000");
    expect(evidence.closing.balanceMinor).toBe("11000");
    expect(target.calls).toHaveLength(4);
    expect(target.calls.every((call) => call.method === "GET")).toBe(true);
    expect(target.calls[1]?.url).toContain("reports/GeneralLedger");
    expect(target.calls[1]?.url).toContain("account=35");
    expect(target.calls[2]?.url).toContain("reports/TrialBalance");
    expect(target.calls[2]?.url).toContain("start_date=2025-01-01");
    expect(target.calls[2]?.url).toContain("end_date=2025-12-31");
    expect(target.calls[3]?.url).toContain("start_date=2026-01-01");
    expect(target.calls[3]?.url).toContain("end_date=2026-01-31");
    expect(evidence.providerRequestId?.split(",")).toHaveLength(4);
    expect(evidence.responseFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.opening.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.closing.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks a report REVIEW-grade when provider cutoff completeness is not proven", async () => {
    const target = qboReader({ generalLedger: qboReport({ end: "2026-01-30" }) });
    const evidence = await target.reader.read(REQUEST, SCOPE);
    expect(evidence.completenessState).toBe("incomplete");
    expect(evidence.terminalBoundarySeen).toBe(false);
    expect(evidence.incompletenessReason).toContain("QUICKBOOKS_REPORT_HEADER_UNPROVEN");
  });

  it("fails closed as incomplete when the General Ledger basis is not Accrual", async () => {
    const target = qboReader({ generalLedger: qboReport({ basis: "Cash" }) });
    const evidence = await target.reader.read(REQUEST, SCOPE);
    expect(evidence.completenessState).toBe("incomplete");
    expect(evidence.incompletenessReason).toContain("QUICKBOOKS_REPORT_HEADER_UNPROVEN");
  });

  it("supports a blank GL summary and no movements when Trial Balance proves equal boundaries", async () => {
    const target = qboReader({
      generalLedger: qboReport({ blankSummary: true, movements: [] }),
      openingTrialBalance: qboTrialBalance({ cutoff: "2025-12-31", balance: "100.00", start: "2025-01-01" }),
      closingTrialBalance: qboTrialBalance({ cutoff: "2026-01-31", balance: "100.00" }),
    });
    const evidence = await target.reader.read(REQUEST, SCOPE);
    expect(evidence).toMatchObject({
      movementTotalMinor: "0", returnedCount: 0, acceptedCount: 0,
      completenessState: "complete",
    });
    expect(evidence.opening.balanceMinor).toBe("10000");
    expect(evidence.closing.balanceMinor).toBe("10000");
  });

  it("continues to accept the canonical GL amount and balance aliases", async () => {
    const evidence = await qboReader({
      generalLedger: qboReport({ actualColumnKeys: false }),
    }).reader.read(REQUEST, SCOPE);
    expect(evidence.movementTotalMinor).toBe("1000");
    expect(evidence.completenessState).toBe("complete");
  });

  it("binds Account, GL, and both Trial Balance responses into retained fingerprints", async () => {
    const baseline = await qboReader().reader.read(REQUEST, SCOPE);
    const changedClosing = await qboReader({
      closingTrialBalance: qboTrialBalance({ cutoff: "2026-01-31", balance: "111.00" }),
    }).reader.read(REQUEST, SCOPE);
    expect(changedClosing.responseFingerprint).not.toBe(baseline.responseFingerprint);
    expect(changedClosing.opening.rawPayloadHash).toBe(baseline.opening.rawPayloadHash);
    expect(changedClosing.closing.rawPayloadHash).not.toBe(baseline.closing.rawPayloadHash);
    expect(changedClosing.setFingerprint).not.toBe(baseline.setFingerprint);
  });

  it.each([
    ["opening", qboTrialBalance({ cutoff: "2025-12-30", balance: "100.00", start: "2025-01-01" }), undefined],
    ["closing", undefined, qboTrialBalance({ cutoff: "2026-01-30", balance: "110.00" })],
  ] as const)("fails closed when the %s Trial Balance cutoff is wrong", async (_boundary, opening, closing) => {
    const target = qboReader({
      ...(opening ? { openingTrialBalance: opening } : {}),
      ...(closing ? { closingTrialBalance: closing } : {}),
    });
    await expect(target.reader.read(REQUEST, SCOPE)).rejects.toThrow(/exact cutoff/i);
  });

  it("fails closed when a Trial Balance uses the wrong accounting basis", async () => {
    const target = qboReader({
      openingTrialBalance: qboTrialBalance({
        cutoff: "2025-12-31", balance: "100.00", start: "2025-01-01", basis: "Cash",
      }),
    });
    await expect(target.reader.read(REQUEST, SCOPE)).rejects.toThrow(/exact cutoff/i);
  });

  it.each([0, 2])("fails closed when Trial Balance returns %i exact account rows", async (accountRows) => {
    const target = qboReader({
      openingTrialBalance: qboTrialBalance({
        cutoff: "2025-12-31", balance: "100.00", start: "2025-01-01", accountRows,
      }),
    });
    await expect(target.reader.read(REQUEST, SCOPE)).rejects.toThrow(/one exact account row/i);
  });

  it("rejects provider/account ownership drift before any QuickBooks request", async () => {
    const target = qboReader();
    await expect(target.reader.read(REQUEST, { ...SCOPE, ledgerAccountId: "99" }))
      .rejects.toThrow(/identity/i);
    expect(target.http).toHaveBeenCalledTimes(1);
    expect(target.calls[0]?.url).toContain("account/99");
    expect(target.calls.some((call) => call.url.includes("GeneralLedger"))).toBe(false);
  });

  it("rejects provider currency drift before reading the QuickBooks ledger report", async () => {
    const target = qboReader();
    await expect(target.reader.read(REQUEST, { ...SCOPE, currencyCode: "USD" }))
      .rejects.toThrow(/currency mismatch/i);
    expect(target.http).toHaveBeenCalledTimes(1);
    expect(target.calls.some((call) => call.url.includes("GeneralLedger"))).toBe(false);
  });

  it("persists evidence and invokes only a SHADOW result", async () => {
    const source = new PairedOfxBalanceEvidenceReader();
    const ledger = qboReader().reader;
    let recorded: Parameters<BalanceShadowStore["record"]>[0] | null = null;
    const store: BalanceShadowStore = {
      prepareScope: vi.fn(async () => SCOPE),
      record: vi.fn(async (input) => {
        recorded = input;
        const state: BalanceShadowResult["state"] =
          input.source.completenessState === "complete" && input.ledger.completenessState === "complete"
            ? "RECONCILED"
            : "REVIEW";
        return {
          mode: "SHADOW" as const,
          state,
          reasonCode: "RECONCILED_EXACT_ZERO_RESIDUAL",
          runId: "run-1",
          revisionId: "revision-1",
          frozenInputFingerprint: "a".repeat(64),
          sourceCompleteness: "OK",
          ledgerCompleteness: "OK",
          residualMinor: "0",
        };
      }),
    };
    const result = await new BalanceReconciliationShadowExecutor(store, source, ledger).execute(REQUEST);
    expect(result).toMatchObject({ mode: "SHADOW", state: "RECONCILED", residualMinor: "0" });
    expect(recorded).not.toBeNull();
    expect((recorded as unknown as { source: BalanceSideEvidence }).source.completenessState).toBe("complete");
    expect((recorded as unknown as { ledger: BalanceSideEvidence }).ledger.completenessState).toBe("complete");
  });
});
