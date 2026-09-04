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

function qboReport(end = "2026-01-31") {
  const column = (key: string) => ({ MetaData: [{ Name: "ColKey", Value: key }] });
  return {
    Header: {
      ReportName: "GeneralLedger",
      ReportBasis: "Accrual",
      StartPeriod: "2026-01-01",
      EndPeriod: end,
      Currency: "GBP",
    },
    Columns: { Column: [column("tx_date"), column("txn_type"), column("amount"), column("balance")] },
    Rows: {
      Row: [{
        Header: { ColData: [{ value: "Proof Bank", id: "35" }] },
        Rows: { Row: [
          { ColData: [{ value: "" }, { value: "Beginning Balance" }, { value: "" }, { value: "100.00" }] },
          { ColData: [{ value: "2026-01-15" }, { value: "Deposit" }, { value: "10.00" }, { value: "110.00" }] },
        ] },
        Summary: { ColData: [{ value: "" }, { value: "Total" }, { value: "10.00" }, { value: "110.00" }] },
      }],
    },
  };
}

function qboReader(report = qboReport()) {
  const calls: Array<{ url: string; method?: string }> = [];
  const bodies = [
    { Account: { Id: "35", Active: true, CurrencyRef: { value: "GBP" } } },
    report,
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

  it("reads the exact QuickBooks account report with GET-only provider calls", async () => {
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
    expect(target.calls).toHaveLength(2);
    expect(target.calls.every((call) => call.method === "GET")).toBe(true);
    expect(target.calls[1]?.url).toContain("reports/GeneralLedger");
    expect(target.calls[1]?.url).toContain("account=35");
  });

  it("marks a report REVIEW-grade when provider cutoff completeness is not proven", async () => {
    const target = qboReader(qboReport("2026-01-30"));
    const evidence = await target.reader.read(REQUEST, SCOPE);
    expect(evidence.completenessState).toBe("incomplete");
    expect(evidence.terminalBoundarySeen).toBe(false);
    expect(evidence.incompletenessReason).toContain("QUICKBOOKS_REPORT_HEADER_UNPROVEN");
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
