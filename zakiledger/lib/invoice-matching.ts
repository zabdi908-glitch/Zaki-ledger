import type { BankTransaction } from "./reconciliation-schema";
import type { StoredInvoiceSummary } from "./store";

/**
 * Bank line -> extracted invoice matching. Two tiers: a quoted reference plus
 * the right amount is as close to certain as bookkeeping gets (99); an
 * amount + date + supplier-name coincidence is strong but visibly weaker.
 * Signage: bank amounts are signed, invoice totals are positive — magnitude
 * is what has to agree.
 */
export interface InvoiceSuggestion {
  bankTransactionId: string;
  invoiceId: string;
  invoiceNumber: string;
  supplierName: string;
  total: number | null;
  confidencePct: number;
  matchedBy: "reference" | "amount_date";
  reason: string;
}

const REF_RE = /\b(?:INV|INVOICE)[-\s#]?(\d{2,8})\b|#(\d{2,8})\b/gi;

export function extractInvoiceRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    if (m[1]) refs.push(`INV-${m[1]}`, m[1]);
    else if (m[2]) refs.push(m[2]);
  }
  return [...new Set(refs.map((r) => r.toUpperCase()))];
}

/** "acme ltd" vs "ACME LIMITED PAYMENT" -> shared-token ratio in [0,1]. */
function nameOverlap(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

const DAY = 86_400_000;
const DATE_WINDOW_DAYS = 3;

export function matchInvoices(bank: BankTransaction[], invoices: StoredInvoiceSummary[]): InvoiceSuggestion[] {
  const out: InvoiceSuggestion[] = [];
  const claimed = new Set<string>(); // one bank line per invoice
  for (const b of bank) {
    const text = `${b.merchant ?? ""} ${b.description ?? ""} ${b.memo ?? ""}`;
    const refs = new Set(extractInvoiceRefs(text));
    let best: InvoiceSuggestion | null = null;
    for (const inv of invoices) {
      if (claimed.has(inv.id) || inv.total === null) continue;
      if (Math.abs(Math.abs(b.amount) - Math.abs(inv.total)) > 0.01) continue;
      const invRefs = extractInvoiceRefs(inv.invoiceNumber);
      const refHit = inv.invoiceNumber && (refs.has(inv.invoiceNumber.toUpperCase()) || invRefs.some((r) => refs.has(r)));
      if (refHit) {
        best = {
          bankTransactionId: b.id, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
          supplierName: inv.supplierName, total: inv.total, confidencePct: 99, matchedBy: "reference",
          reason: `Exact match: reference ${inv.invoiceNumber} quoted on the bank line, amount agrees.`,
        };
        break; // a reference hit beats any fuzzy candidate
      }
      if (!inv.invoiceDate) continue;
      const gapDays = Math.abs(Date.parse(b.transactionDate) - Date.parse(inv.invoiceDate)) / DAY;
      if (gapDays > DATE_WINDOW_DAYS) continue;
      const overlap = nameOverlap(inv.supplierName, text);
      if (overlap < 0.5) continue;
      const pct = Math.round(80 + overlap * 10 + (DATE_WINDOW_DAYS - gapDays)); // 80–93
      if (!best || pct > best.confidencePct) {
        best = {
          bankTransactionId: b.id, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
          supplierName: inv.supplierName, total: inv.total, confidencePct: pct, matchedBy: "amount_date",
          reason: `Amount matches ${inv.supplierName}'s invoice ${inv.invoiceNumber}, dated within ${DATE_WINDOW_DAYS} days.`,
        };
      }
    }
    if (best) {
      claimed.add(best.invoiceId);
      out.push(best);
    }
  }
  return out;
}
