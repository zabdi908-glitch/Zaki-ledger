import { describe, expect, it } from "vitest";
import { parseOfxStatement, sgmlToXml } from "../lib/bank-parsers";

// OFX v1: SGML — leaf elements have no closing tag, container elements do.
const OFX_V1_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260731120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>GBP
<BANKACCTFROM>
<BANKID>123456
<ACCTID>00012345
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260701
<DTEND>20260731
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260705120000
<TRNAMT>-45.00
<FITID>TX001
<NAME>Coffee Shop
<MEMO>Card purchase
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260710120000
<TRNAMT>1200.00
<FITID>TX002
<NAME>Client Payment
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>5000.00
<DTASOF>20260731120000
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

// OFX v2: well-formed XML, already closed — should pass through unchanged.
const OFX_V2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKTRANLIST>
          <DTSTART>20260701</DTSTART>
          <DTEND>20260731</DTEND>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260703120000</DTPOSTED>
            <TRNAMT>-20.00</TRNAMT>
            <FITID>V2TX001</FITID>
            <NAME>Groceries</NAME>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>999.00</BALAMT>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>
`;

describe("sgmlToXml", () => {
  it("closes leaf-value tags but leaves container tags for their real closing tag", () => {
    const xml = sgmlToXml("<OFX>\n<STMTTRN>\n<TRNAMT>-45.00\n</STMTTRN>\n</OFX>");
    expect(xml).toContain("<TRNAMT>-45.00</TRNAMT>");
    expect(xml).toContain("<STMTTRN>\n"); // left open — real </STMTTRN> follows
    expect(xml).toContain("</STMTTRN>");
  });
});

describe("parseOfxStatement", () => {
  it("parses OFX v1 SGML, closing leaf tags and extracting transactions", () => {
    const result = parseOfxStatement(OFX_V1_SGML);

    expect(result.transactions).toHaveLength(2);
    expect(result.currency).toBe("GBP");
    expect(result.periodStart).toBe("2026-07-01");
    expect(result.periodEnd).toBe("2026-07-31");
    expect(result.closingBalance).toBe(5000);

    const [debit, credit] = result.transactions;
    expect(debit).toMatchObject({
      transactionDate: { value: "2026-07-05", confidence: 1, reason: "OFX parse" },
      merchant: { value: "Coffee Shop", confidence: 1, reason: "OFX parse" },
      transactionId: "TX001",
      amount: { value: 45, confidence: 1, reason: "OFX parse" }, // OFX TRNAMT -45.00 (debit) -> our positive-for-debit
      currency: "GBP",
    });
    expect(credit).toMatchObject({
      transactionDate: { value: "2026-07-10", confidence: 1, reason: "OFX parse" },
      merchant: { value: "Client Payment", confidence: 1, reason: "OFX parse" },
      transactionId: "TX002",
      amount: { value: -1200, confidence: 1, reason: "OFX parse" }, // OFX TRNAMT 1200.00 (credit) -> our negative-for-credit
    });
  });

  it("parses OFX v2 XML directly (already well-formed)", () => {
    const result = parseOfxStatement(OFX_V2_XML);

    expect(result.transactions).toHaveLength(1);
    expect(result.currency).toBe("USD");
    expect(result.closingBalance).toBe(999);
    expect(result.transactions[0]).toMatchObject({
      transactionDate: { value: "2026-07-03", confidence: 1, reason: "OFX parse" },
      merchant: { value: "Groceries", confidence: 1, reason: "OFX parse" },
      amount: { value: 20, confidence: 1, reason: "OFX parse" },
    });
  });

  it("throws a clear error for a non-OFX file", () => {
    expect(() => parseOfxStatement("not an ofx file at all")).toThrow(/OFX/i);
  });
});
