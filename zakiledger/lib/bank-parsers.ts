import Papa from "papaparse";
import { XMLParser } from "fast-xml-parser";
import type { ParsedBankTransaction, ParsedStatement } from "./reconciliation-schema";

/**
 * Bank statement parsing — CSV and OFX, no network/DB. Pure text-in,
 * structured-transactions-out, so these are trivially unit-testable and
 * reusable from both the upload route and tests/fixtures.
 *
 * Sign convention (shared with db/schema.sql `bank_transactions.amount`):
 * **positive = debit (money out), negative = credit (money in)**. Real bank
 * exports (both CSV single-Amount columns and OFX TRNAMT) conventionally do
 * the opposite — negative for a withdrawal, positive for a deposit, matching
 * how a bank shows its own ledger. Both parsers below negate that source sign
 * to land on our convention. Where a CSV gives separate Debit/Credit columns
 * instead, there's no source sign to flip — `amount = debit - credit` already
 * comes out positive-for-debit.
 */

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase();
}

/** First header (already-normalized) containing any of `needles`, or undefined. */
function findHeader(headers: string[], needles: string[]): string | undefined {
  return headers.find((h) => needles.some((n) => h.includes(n)));
}

/**
 * Parse a date in ISO (YYYY-MM-DD), DD/MM/YYYY, or MM/DD/YYYY into ISO.
 * Day-first is ambiguous with month-first for both-under-13 dates (e.g.
 * "03/04/2026"); we default to day-first (DD/MM/YYYY) since Zaki Ledger's
 * pilot bookkeeping is UK-based (see lib/currency.ts) — flip this default if
 * a US-only customer's data comes in misparsed.
 */
export function parseFlexibleDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slashOrDash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashOrDash) {
    const a = Number(slashOrDash[1]);
    const b = Number(slashOrDash[2]);
    const year = Number(slashOrDash[3]);
    // Whichever side is >12 must be the day, unambiguously.
    if (a > 12 && b <= 12) return toIsoDate(year, b, a);
    if (b > 12 && a <= 12) return toIsoDate(year, a, b);
    // Ambiguous or both invalid as a month — default to day-first.
    return toIsoDate(year, b, a);
  }

  return null;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null; // e.g. Feb 30 — Date rolled it over, so the input was invalid
  }
  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const DATE_HEADER_HINTS = ["transaction date", "trans date", "posted date", "date"];
const DESCRIPTION_HEADER_HINTS = ["description", "merchant", "payee", "narrative", "memo", "details"];
const DEBIT_HEADER_HINTS = ["debit", "withdrawal", "money out", "paid out"];
const CREDIT_HEADER_HINTS = ["credit", "deposit", "money in", "paid in"];
const AMOUNT_HEADER_HINTS = ["amount", "value"];
const CURRENCY_HEADER_HINTS = ["currency", "ccy"];

/**
 * Parse a bank statement CSV. Delimiter and headers are auto-detected
 * (Papa Parse handles comma/semicolon/tab detection); columns are matched by
 * fuzzy header name since bank exports never agree on naming.
 *
 * `defaultCurrency` is used when the file has no currency column — the
 * caller (upload route) may know it from the connected bank/account.
 */
export function parseCsvStatement(text: string, defaultCurrency: string | null = null): ParsedStatement {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: normalizeHeader,
  });

  const headers = result.meta.fields ?? [];
  const dateHeader = findHeader(headers, DATE_HEADER_HINTS);
  const descriptionHeader = findHeader(headers, DESCRIPTION_HEADER_HINTS);
  const debitHeader = findHeader(headers, DEBIT_HEADER_HINTS);
  const creditHeader = findHeader(headers, CREDIT_HEADER_HINTS);
  const amountHeader = findHeader(headers, AMOUNT_HEADER_HINTS);
  const currencyHeader = findHeader(headers, CURRENCY_HEADER_HINTS);

  if (!dateHeader) {
    throw new Error("Could not find a date column in this CSV — expected a header containing \"date\".");
  }
  if (!debitHeader && !creditHeader && !amountHeader) {
    throw new Error(
      "Could not find an amount column in this CSV — expected \"Debit\"/\"Credit\" or \"Amount\".",
    );
  }

  const transactions: ParsedBankTransaction[] = [];
  let detectedCurrency: string | null = null;

  for (const row of result.data) {
    const isoDate = parseFlexibleDate(row[dateHeader] ?? "");
    if (!isoDate) continue; // e.g. a trailing "Balance brought forward" summary row

    let amount: number | null = null;
    if (debitHeader || creditHeader) {
      const debit = parseMoney(debitHeader ? row[debitHeader] : undefined);
      const credit = parseMoney(creditHeader ? row[creditHeader] : undefined);
      if (debit === null && credit === null) continue;
      amount = (debit ?? 0) - (credit ?? 0);
    } else if (amountHeader) {
      const sourceAmount = parseMoney(row[amountHeader]);
      if (sourceAmount === null) continue;
      amount = -sourceAmount; // flip bank's negative-for-debit to our positive-for-debit
    }
    if (amount === null || !Number.isFinite(amount)) continue;

    const currency = currencyHeader ? row[currencyHeader]?.trim() || null : null;
    if (currency && !detectedCurrency) detectedCurrency = currency;

    transactions.push({
      transactionDate: isoDate,
      postedDate: null,
      merchant: descriptionHeader ? row[descriptionHeader]?.trim() || null : null,
      description: descriptionHeader ? row[descriptionHeader]?.trim() || null : null,
      amount,
      currency: currency ?? defaultCurrency,
      transactionId: null,
      memo: null,
    });
  }

  const dates = transactions.map((t) => t.transactionDate).sort();
  return {
    transactions,
    openingBalance: null, // a plain transaction CSV rarely states one
    closingBalance: null,
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
    currency: detectedCurrency ?? defaultCurrency,
  };
}

/** Strips thousands separators/currency symbols/whitespace; "" and "-" → null. */
function parseMoney(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// OFX
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // dates like "20230715" would otherwise become numbers
  trimValues: true,
  isArray: (name) => name === "STMTTRN",
});

/**
 * OFX v1 is SGML, not XML: leaf elements (`<DTPOSTED>20230715`) have no
 * closing tag, though container elements (`<STMTTRN>...</STMTTRN>`) do. This
 * auto-closes leaf tags so a standard XML parser can read it — the standard
 * technique for OFX v1, since a from-scratch OFX parser would just be
 * reimplementing this. OFX v2 is already well-formed XML and passes through
 * this function unrecognized-and-unchanged (no line matches "tag with a
 * trailing value and no closing tag" once real closing tags are present).
 */
export function sgmlToXml(raw: string): string {
  const ofxStart = raw.indexOf("<OFX>");
  const body = ofxStart >= 0 ? raw.slice(ofxStart) : raw;
  return body.replace(/<([A-Za-z0-9.]+)>([^<\r\n]*)\r?\n/g, (match, tag: string, value: string) => {
    if (value.trim().length === 0) return match; // container open tag — leave for its real closing tag
    return `<${tag}>${value.trim()}</${tag}>\n`;
  });
}

function isOfxV2(text: string): boolean {
  return text.trimStart().startsWith("<?xml");
}

/** "20230715120000[-5:EST]" or "20230715" → "2023-07-15". */
function parseOfxDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.trim().slice(0, 8);
  const m = digits.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Parse an OFX (v1 SGML or v2 XML) bank statement export. */
export function parseOfxStatement(text: string): ParsedStatement {
  const xml = isOfxV2(text) ? text : sgmlToXml(text);
  const parsed = xmlParser.parse(xml);

  const ofx = parsed.OFX;
  if (!ofx) throw new Error("Not a recognizable OFX file — no <OFX> root element found.");

  const stmtrs = ofx.BANKMSGSRSV1?.STMTTRNRS?.STMTRS ?? ofx.CREDITCARDMSGSRSV1?.CCSTMTTRNRS?.CCSTMTRS;
  if (!stmtrs) throw new Error("OFX file has no bank statement response (STMTRS) section.");

  const currency: string | null = stmtrs.CURDEF ?? null;
  const tranList = stmtrs.BANKTRANLIST ?? stmtrs.CCTRANLIST;
  const rawTxns = asArray(tranList?.STMTTRN);

  const transactions: ParsedBankTransaction[] = [];
  for (const t of rawTxns) {
    const isoDate = parseOfxDate(t.DTPOSTED);
    const sourceAmount = t.TRNAMT !== undefined ? Number(t.TRNAMT) : null;
    if (!isoDate || sourceAmount === null || !Number.isFinite(sourceAmount)) continue;

    transactions.push({
      transactionDate: isoDate,
      postedDate: isoDate,
      merchant: t.NAME?.trim() || t.PAYEE?.NAME?.trim() || null,
      description: t.MEMO?.trim() || t.NAME?.trim() || null,
      amount: -sourceAmount, // OFX: negative = debit; flip to our positive-for-debit
      currency,
      transactionId: t.FITID?.trim() || null,
      memo: t.MEMO?.trim() || null,
    });
  }

  return {
    transactions,
    openingBalance: null, // OFX has no "opening balance" element — only a closing LEDGERBAL
    closingBalance: stmtrs.LEDGERBAL?.BALAMT !== undefined ? Number(stmtrs.LEDGERBAL.BALAMT) : null,
    periodStart: parseOfxDate(tranList?.DTSTART),
    periodEnd: parseOfxDate(tranList?.DTEND),
    currency,
  };
}
