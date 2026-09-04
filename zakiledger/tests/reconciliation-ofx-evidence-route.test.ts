import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  retain: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../lib/auth", () => ({ requireUser: async () => ({ id: "authenticated-user" }) }));
vi.mock("../lib/reconciliation-freeze", () => ({
  isReconciliationWriteFrozen: () => false,
  reconciliationFreezeResponse: vi.fn(),
}));
vi.mock("../lib/ofx-evidence-store", () => ({
  MAX_OFX_UPLOAD_BYTES: 10 * 1024 * 1024,
  retainOfxEvidence: mocks.retain,
}));
vi.mock("../lib/reconciliation-store", () => ({ saveBankStatement: mocks.save }));
vi.mock("../lib/bank-statement-pdf", () => ({ parsePdfStatement: vi.fn() }));

import { POST } from "../app/api/reconciliation/upload/route";

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>GBP
<BANKACCTFROM>
<BANKID>raw-bank
<ACCTID>raw-account
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260801
<DTEND>20260831
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260805
<TRNAMT>-10.00
<FITID>one
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>90.00
<DTASOF>20260831
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

function requestWith(file: File, extra?: Record<string, string>): NextRequest {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(extra ?? {})) form.append(key, value);
  return new Request("http://test/api/reconciliation/upload", {
    method: "POST",
    body: form,
  }) as unknown as NextRequest;
}

describe("reconciliation upload OFX evidence gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retain.mockImplementation(async ({ rawBytes }: { rawBytes: Uint8Array }) => ({
      artifactId: "artifact-1",
      contentSha256: (await import("../lib/financial-identity")).sha256Hex(rawBytes),
      contentLength: rawBytes.byteLength,
    }));
    mocks.save.mockResolvedValue({
      id: "statement-1",
      transactionCount: 1,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      currency: "GBP",
    });
  });

  it("returns artifactId and statementId only after evidence succeeds", async () => {
    const response = await POST(requestWith(new File([OFX], "statement.qfx", { type: "application/x-ofx" })));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ artifactId: "artifact-1", statementId: "statement-1" });
    expect(JSON.stringify(body)).not.toContain("raw-bank");
    expect(JSON.stringify(body)).not.toContain("raw-account");
    expect(mocks.retain.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0]);
  });

  it("prevents the legacy statement write when artifact registration fails", async () => {
    mocks.retain.mockRejectedValue(new Error("OFX artifact registration failed"));

    const response = await POST(requestWith(new File([OFX], "statement.ofx")));

    expect(response.status).toBe(500);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("ignores client identity supplied in multipart input", async () => {
    await POST(
      requestWith(new File([OFX], "statement.ofx"), {
        client_entity_id: "spoofed-client",
        clientEntityId: "another-spoofed-client",
      }),
    );

    expect(mocks.retain).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "authenticated-user" }),
    );
    expect(mocks.retain.mock.calls[0][0]).not.toHaveProperty("clientEntityId");
  });

  it("leaves the non-OFX ingestion path unchanged", async () => {
    const csv = "Date,Description,Amount,Currency\n01/08/2026,Test,10.00,GBP";
    const response = await POST(requestWith(new File([csv], "statement.csv", { type: "text/csv" })));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.statementId).toBe("statement-1");
    expect(body).not.toHaveProperty("artifactId");
    expect(mocks.retain).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledOnce();
  });
});
