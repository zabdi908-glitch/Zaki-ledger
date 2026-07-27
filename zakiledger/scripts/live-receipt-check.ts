/**
 * Live document-type accuracy check.
 *
 * Runs REAL receipts and invoices through the REAL extraction path (the same
 * `extractDocument` the app uses, live Claude, no demo samples) and scores how
 * often the invoice-vs-receipt classification is right — plus how confident it
 * was, which is what the new type gate keys on.
 *
 * Usage:
 *   1. Put documents in scripts/fixtures/receipts/ and scripts/fixtures/invoices/
 *      (png/jpg/webp/pdf). The FOLDER is the ground-truth label — that's the whole
 *      labelling scheme, so a file in the wrong folder scores as a miss.
 *   2. Export a real key:  ANTHROPIC_API_KEY=sk-ant-...
 *   3. npm run receipts:live
 *
 * Costs one vision call per document (~$0.03 each) and makes no writes: nothing
 * is approved, stored, or posted. Read-only against the model.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { extractDocument } from "../lib/anthropic";
import { CRITICAL_THRESHOLD } from "../lib/validation";
import type { DocumentType } from "../lib/schema";

const FIXTURES = join(import.meta.dirname, "fixtures");
const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

interface Row {
  file: string;
  expected: DocumentType;
  got: DocumentType;
  confidence: number;
  correct: boolean;
  gated: boolean;
  merchant: string;
  hasNumber: boolean;
  taxItemized: boolean;
  total: number;
  error?: string;
}

function collect(label: DocumentType): { path: string; label: DocumentType }[] {
  const dir = join(FIXTURES, label === "receipt" ? "receipts" : "invoices");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => MEDIA[extname(f).toLowerCase()])
    .map((f) => ({ path: join(dir, f), label }));
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — this script only runs against live Claude.");
    process.exit(2);
  }

  const docs = [...collect("receipt"), ...collect("invoice")];
  if (docs.length === 0) {
    console.error(`No documents found under ${FIXTURES}/{receipts,invoices}/`);
    console.error("Add real files first — synthetic ones would make the accuracy number meaningless.");
    process.exit(2);
  }

  console.log(`Running ${docs.length} document(s) through live extraction...\n`);
  const rows: Row[] = [];

  for (const { path, label } of docs) {
    const name = path.split(/[\\/]/).pop()!;
    process.stdout.write(`  ${name} ... `);
    try {
      const base64 = readFileSync(path).toString("base64");
      // No prior hints: this measures the prompt itself, not the learning loop.
      const x = await extractDocument(base64, MEDIA[extname(path).toLowerCase()]);
      const row: Row = {
        file: name,
        expected: label,
        got: x.documentType.value,
        confidence: x.documentType.confidence,
        correct: x.documentType.value === label,
        gated: x.documentType.confidence < CRITICAL_THRESHOLD,
        merchant: x.supplierName.value,
        hasNumber: x.invoiceNumber.value.trim() !== "",
        taxItemized: x.taxItemized,
        total: x.total.value,
      };
      rows.push(row);
      console.log(
        `${row.correct ? "OK  " : "MISS"} ${row.got} @ ${(row.confidence * 100).toFixed(0)}%` +
          `${row.gated ? "  [gated]" : ""}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({
        file: name, expected: label, got: label, confidence: 0, correct: false,
        gated: true, merchant: "", hasNumber: false, taxItemized: false, total: 0, error: message,
      });
      console.log(`ERROR ${message}`);
    }
  }

  const ok = rows.filter((r) => r.correct);
  const misses = rows.filter((r) => !r.correct && !r.error);
  const errors = rows.filter((r) => r.error);
  const gated = rows.filter((r) => r.gated && !r.error);
  const confidences = rows.filter((r) => !r.error).map((r) => r.confidence);
  const mean = confidences.reduce((a, b) => a + b, 0) / (confidences.length || 1);

  console.log("\n" + "=".repeat(66));
  console.log(`Document-type accuracy : ${ok.length}/${rows.length} (${((ok.length / rows.length) * 100).toFixed(0)}%)`);
  console.log(`Mean type confidence   : ${(mean * 100).toFixed(1)}%`);
  console.log(`Lowest                 : ${(Math.min(...confidences) * 100).toFixed(0)}%`);
  console.log(`Would hit the type gate: ${gated.length}/${rows.length} (< ${CRITICAL_THRESHOLD * 100}%)`);
  if (errors.length) console.log(`Extraction errors      : ${errors.length}`);

  if (misses.length) {
    console.log("\nMISCLASSIFIED:");
    for (const m of misses) {
      console.log(`  ${m.file}: expected ${m.expected}, got ${m.got} @ ${(m.confidence * 100).toFixed(0)}%`);
    }
  }

  // A miss the gate would have caught is a very different risk from a confident
  // miss, which reaches the human already committed to the wrong ruleset.
  const confidentMisses = misses.filter((m) => !m.gated);
  if (confidentMisses.length) {
    console.log(`\n⚠ ${confidentMisses.length} CONFIDENT misclassification(s) — the gate would NOT catch these.`);
  }

  console.log("\nPer-document detail:");
  console.table(
    rows.map((r) => ({
      file: r.file,
      expected: r.expected,
      got: r.got,
      conf: `${(r.confidence * 100).toFixed(0)}%`,
      gated: r.gated,
      merchant: r.merchant.slice(0, 24),
      num: r.hasNumber,
      vat: r.taxItemized,
      total: r.total,
    })),
  );

  process.exit(misses.length + errors.length > 0 ? 1 : 0);
}

main();
