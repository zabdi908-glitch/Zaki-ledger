import { NextRequest, NextResponse } from "next/server";
import { parseCsvStatement, parsedTransactionsToQbInputs } from "@/lib/bank-parsers";
import { saveQbTransactions } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";

/**
 * POST /api/reconciliation/qb-transactions/upload
 * Body: multipart form with a single "file" (a QuickBooks/Xero transaction
 * export, CSV).
 *
 * There's no live QB/Xero sync yet, so this is how accounting-side
 * transactions get into the system for matching today: same CSV shape as a
 * bank statement (date + amount + description), reusing parseCsvStatement
 * rather than a second parser — see parsedTransactionsToQbInputs.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    const text = await file.text();
    const parsed = parseCsvStatement(text);
    if (parsed.transactions.length === 0) {
      return NextResponse.json(
        { error: "No transactions could be read from this file." },
        { status: 400 },
      );
    }

    const imported = await saveQbTransactions(user.id, parsedTransactionsToQbInputs(parsed.transactions));
    return NextResponse.json({ imported });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to import accounting transactions.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
