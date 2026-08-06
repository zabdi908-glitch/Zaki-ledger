import { NextRequest, NextResponse } from "next/server";
import { parseCsvStatement, parseOfxStatement, parsedTransactionsToQbInputs } from "@/lib/bank-parsers";
import { compareBankToQbWithAI } from "@/lib/comparison-engine";
import type { BankTransaction, QbTransaction, ParsedBankTransaction, QbTransactionInput } from "@/lib/reconciliation-schema";
import type { ComparisonResult, ComparisonFilters } from "@/lib/comparison-schema";

function detectFormat(fileName: string): "csv" | "ofx" | null {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "ofx" || ext === "qfx") return "ofx";
  return null;
}

function toBankTransactions(parsed: ParsedBankTransaction[]): BankTransaction[] {
  return parsed.map((t, i) => ({
    id: `bank-${i}`,
    statementId: "synthetic",
    transactionDate: t.transactionDate.value,
    postedDate: t.postedDate,
    merchant: t.merchant?.value ?? null,
    description: t.description?.value ?? null,
    amount: t.amount.value,
    currency: t.currency,
    transactionId: t.transactionId,
    memo: t.memo,
  }));
}

function toQbTransactions(inputs: QbTransactionInput[]): QbTransaction[] {
  return inputs.map((t, i) => ({
    id: `qb-${i}`,
    qbTransactionId: t.qbTransactionId ?? null,
    qbAccountId: t.qbAccountId ?? null,
    postedDate: t.postedDate,
    amount: t.amount,
    description: t.description ?? null,
    accountName: t.accountName ?? null,
    accountType: t.accountType ?? null,
    currency: t.currency ?? null,
  }));
}

/**
 * POST /api/reconciliation/compare
 * Body: multipart/form-data
 *   - bankFile: File (CSV or OFX)
 *   - qbFile: File (CSV or OFX)
 *   - dateStart?: string (optional, ISO 8601)
 *   - dateEnd?: string (optional, ISO 8601)
 *
 * Returns a ComparisonResult JSON object.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const bankFile = form.get("bankFile");
    const qbFile = form.get("qbFile");

    if (!(bankFile instanceof File)) {
      return NextResponse.json({ error: "Missing bankFile." }, { status: 400 });
    }
    if (!(qbFile instanceof File)) {
      return NextResponse.json({ error: "Missing qbFile." }, { status: 400 });
    }

    const bankFormat = detectFormat(bankFile.name);
    const qbFormat = detectFormat(qbFile.name);

    if (!bankFormat) {
      return NextResponse.json(
        { error: "Unsupported bankFile type — expected .csv, .ofx, or .qfx." },
        { status: 400 },
      );
    }
    if (!qbFormat) {
      return NextResponse.json(
        { error: "Unsupported qbFile type — expected .csv, .ofx, or .qfx." },
        { status: 400 },
      );
    }

    const bankText = await bankFile.text();
    const qbText = await qbFile.text();

    let bankParsed;
    try {
      bankParsed = bankFormat === "csv" ? parseCsvStatement(bankText) : parseOfxStatement(bankText);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse bank file.";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    let qbParsed;
    try {
      qbParsed = qbFormat === "csv" ? parseCsvStatement(qbText) : parseOfxStatement(qbText);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse QB file.";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const bankTransactions = toBankTransactions(bankParsed.transactions);
    const qbInputs = parsedTransactionsToQbInputs(qbParsed.transactions);
    const qbTransactions = toQbTransactions(qbInputs);

    const filters: ComparisonFilters = {};
    const dateStart = form.get("dateStart");
    const dateEnd = form.get("dateEnd");
    if (typeof dateStart === "string" && dateStart) filters.dateStart = dateStart;
    if (typeof dateEnd === "string" && dateEnd) filters.dateEnd = dateEnd;

    const result: ComparisonResult = await compareBankToQbWithAI(
      bankTransactions,
      qbTransactions,
      Object.keys(filters).length > 0 ? filters : undefined,
    );

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error during comparison.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}