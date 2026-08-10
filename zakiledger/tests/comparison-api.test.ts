import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// Auth and the comparison engine are mocked so this suite never needs credentials or network access.
const requireUserMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth", () => ({
  requireUser: requireUserMock,
}));

const compareBankToQbWithAIMock = vi.hoisted(() =>
  vi.fn<typeof import("../lib/comparison-engine")["compareBankToQbWithAI"]>(),
);

vi.mock("../lib/comparison-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/comparison-engine")>();
  return { ...actual, compareBankToQbWithAI: compareBankToQbWithAIMock };
});

let compareRoute: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  compareRoute = (await import("../app/api/reconciliation/compare/route")).POST;
});

beforeEach(() => {
  requireUserMock.mockResolvedValue({ id: "test-user" });
  compareBankToQbWithAIMock.mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../lib/comparison-engine")>("../lib/comparison-engine");
    return actual.compareBankToQbWithAI(...args);
  });
  compareBankToQbWithAIMock.mockClear();
});

function makeCsv(date: string, description: string, amount: number, currency = "GBP"): string {
  return [
    "Date,Description,Amount,Currency",
    `${date},${description},${amount.toFixed(2)},${currency}`,
  ].join("\n");
}

function makeOfx(date: string, name: string, amount: number): string {
  const dt = date.replace(/-/g, "");
  return `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n\n<OFX>\n<BANKMSGSRSV1>\n<STMTTRNRS>\n<STMTRS>\n<CURDEF>GBP</CURDEF>\n<BANKTRANLIST>\n<DTSTART>${dt}</DTSTART>\n<DTEND>${dt}</DTEND>\n<STMTTRN>\n<TRNTYPE>DEBIT</TRNTYPE>\n<DTPOSTED>${dt}</DTPOSTED>\n<TRNAMT>${amount}</TRNAMT>\n<FITID>${dt}01</FITID>\n<NAME>${name}</NAME>\n</STMTTRN>\n</BANKTRANLIST>\n<LEDGERBAL>\n<BALAMT>0.00</BALAMT>\n<DTASOF>${dt}</DTASOF>\n</LEDGERBAL>\n</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>`;
}

function buildRequest(form: FormData): NextRequest {
  return new Request("http://test/api/reconciliation/compare", {
    method: "POST",
    body: form,
  }) as unknown as NextRequest;
}

describe("POST /api/reconciliation/compare", () => {
  it("returns 401 and does not call the comparison engine when unauthenticated", async () => {
    requireUserMock.mockResolvedValueOnce(null);
    const form = new FormData();
    form.append("bankFile", new File(["not read"], "bank.csv", { type: "text/csv" }));
    form.append("qbFile", new File(["not read"], "qb.csv", { type: "text/csv" }));

    const res = await compareRoute(buildRequest(form));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(compareBankToQbWithAIMock).not.toHaveBeenCalled();
  });

  it("returns a valid ComparisonResult for two matching CSV files", async () => {
    const bankCsv = makeCsv("15/07/2026", "Vendor X", -100.0);
    const qbCsv = makeCsv("15/07/2026", "Vendor X", -100.0);

    const form = new FormData();
    form.append("bankFile", new File([bankCsv], "bank.csv", { type: "text/csv" }));
    form.append("qbFile", new File([qbCsv], "qb.csv", { type: "text/csv" }));

    const res = await compareRoute(buildRequest(form));
    expect(res.status).toBe(200);
    expect(compareBankToQbWithAIMock).toHaveBeenCalledTimes(1);

    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].matchType).toBe("exact");
    expect(body.missingInBank).toHaveLength(0);
    expect(body.missingInQb).toHaveLength(0);
    expect(body.duplicates).toHaveLength(0);
    expect(body.amountMismatches).toHaveLength(0);
    expect(body.unmatchedItems).toHaveLength(0);
    expect(body.summary).toContain("Matched: 1");
  });

  it("returns 400 when bankFile is missing", async () => {
    const form = new FormData();
    form.append("qbFile", new File(["Date,Description,Amount\n01/01/2026,X,10"], "qb.csv", { type: "text/csv" }));

    const res = await compareRoute(buildRequest(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing bankFile/i);
  });

  it("returns 400 when qbFile is missing", async () => {
    const form = new FormData();
    form.append("bankFile", new File(["Date,Description,Amount\n01/01/2026,X,10"], "bank.csv", { type: "text/csv" }));

    const res = await compareRoute(buildRequest(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing qbFile/i);
  });

  it("returns 400 for an invalid CSV (no date column)", async () => {
    const badCsv = "Foo,Bar,Baz\n1,2,3";
    const goodCsv = makeCsv("15/07/2026", "Vendor X", -100.0);

    const form = new FormData();
    form.append("bankFile", new File([badCsv], "bank.csv", { type: "text/csv" }));
    form.append("qbFile", new File([goodCsv], "qb.csv", { type: "text/csv" }));

    const res = await compareRoute(buildRequest(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/date column/i);
  });

  it("returns 400 for an invalid CSV on the QB side", async () => {
    const goodCsv = makeCsv("15/07/2026", "Vendor X", 100.0);
    const badCsv = "Foo,Bar,Baz\n1,2,3";

    const form = new FormData();
    form.append("bankFile", new File([goodCsv], "bank.csv", { type: "text/csv" }));
    form.append("qbFile", new File([badCsv], "qb.csv", { type: "text/csv" }));

    const res = await compareRoute(buildRequest(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/date column/i);
  });

  it("applies dateStart and dateEnd filters", async () => {
    const bankCsv = [
      "Date,Description,Amount,Currency",
      "15/07/2026,Vendor A,-100.00,GBP",
      "01/08/2026,Vendor B,-200.00,GBP",
    ].join("\n");
    const qbCsv = [
      "Date,Description,Amount,Currency",
      "15/07/2026,Vendor A,-100.00,GBP",
      "01/08/2026,Vendor B,-200.00,GBP",
    ].join("\n");

    const form = new FormData();
    form.append("bankFile", new File([bankCsv], "bank.csv", { type: "text/csv" }));
    form.append("qbFile", new File([qbCsv], "qb.csv", { type: "text/csv" }));
    form.append("dateStart", "2026-07-01");
    form.append("dateEnd", "2026-07-31");

    const res = await compareRoute(buildRequest(form));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].bankTransaction.merchant).toBe("Vendor A");
    expect(body.missingInBank).toHaveLength(0);
    expect(body.unmatchedItems).toHaveLength(0);
  });

  it("handles OFX bank + CSV QB", async () => {
    const bankOfx = makeOfx("2026-07-15", "Vendor X", -100.0);
    const qbCsv = makeCsv("15/07/2026", "Vendor X", -100.0);

    const form = new FormData();
    form.append("bankFile", new File([bankOfx], "bank.ofx", { type: "application/x-ofx" }));
    form.append("qbFile", new File([qbCsv], "qb.csv", { type: "text/csv" }));

    const res = await compareRoute(buildRequest(form));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].matchType).toBe("exact");
    expect(body.missingInBank).toHaveLength(0);
    expect(body.unmatchedItems).toHaveLength(0);
  });
});
