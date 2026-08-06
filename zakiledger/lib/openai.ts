import OpenAI from "openai";
import { toJSONSchema, type ZodType } from "zod/v4";
import { InvoiceExtractionSchema, type InvoiceExtraction } from "./schema";
import { ParsedStatementSchema, type ParsedStatement } from "./reconciliation-schema";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

/**
 * gpt-4o-mini is the primary extraction model — cheap enough to run on every
 * upload, good enough on clean-to-typical invoices/receipts/statements. A
 * document it reads with low confidence escalates to Claude Sonnet (see
 * lib/anthropic.ts's extractDocumentEscalation/extractBankStatementEscalation),
 * so the expensive model only runs on the minority of documents that actually
 * need it, not on every read.
 */
const MODEL = "gpt-4o-mini";

/**
 * Build a Structured Outputs `text.format` from a zod/v4 schema.
 *
 * The OpenAI SDK ships its own `zodTextFormat`/`zodResponseFormat` helpers,
 * but they call zod-to-json-schema internally in a way that only recognises
 * plain `"zod"` schema instances — every schema in this codebase (schema.ts,
 * reconciliation-schema.ts) is built against the `"zod/v4"` subpath instead,
 * for compatibility with the Anthropic SDK's own zodOutputFormat helper (see
 * schema.ts's top comment). Handing one of those schemas to the OpenAI
 * helper silently produces an empty `{}` schema — no error, just an
 * unconstrained JSON response — so this builds the format directly with
 * zod/v4's own `toJSONSchema`, which does understand these schemas, and
 * validates the raw response against the same schema afterwards. One schema
 * definition, no duplication, no silent empty-schema failure mode.
 */
function jsonSchemaFormat(schema: ZodType, name: string) {
  return {
    type: "json_schema" as const,
    name,
    strict: true,
    schema: toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>,
  };
}

const SYSTEM_PROMPT = `You extract structured data from UK invoices and receipts for an accounting tool.
Rules:
- Extract exactly what is on the document. Never invent a value.
- Give each field a confidence from 0 to 1. Confidence measures how certain you are
  that the printed characters are what you read — NOT how normal, simple, or
  predictable the value looks. Lower it only for a genuine reading problem: smudged,
  cut off, low-resolution, handwritten, or where more than one reading is plausible.
- An unusual-looking but clearly printed value is NOT a reason to lower confidence.
  Invoice and receipt numbers routinely mix letters, digits, dashes and slashes
  (e.g. "INV-2044-A", "2024/00187", "REC-9B31") — that is the normal shape of the
  field, not ambiguity. If you can read every character with certainty, score it
  90%+ regardless of its format. The same applies to merchant/supplier names: a
  clearly printed trading name is a high-confidence read even if you don't
  recognize the business.
- Do not let one field's difficulty pull down another field's score. Confidence is
  per field, independently — a smudged tax line does not make a crisp merchant
  name any less certain.
- Every field also carries a short "reason": one plain-English clause naming what
  on the document you based the read on, e.g. "printed clearly under 'Invoice No.'"
  or "smudged, could be 5 or 6". This is what a human reviewer sees next to the
  confidence score, so make it concrete and specific to this document — never a
  generic restatement like "extracted from the document".
- Dates as ISO 8601 (YYYY-MM-DD) when you can read them unambiguously.
- Amounts as plain numbers (no currency symbols or thousands separators).
- A human reviews everything you produce, so flag what's genuinely uncertain —
  but an accurate high score is just as valuable a signal as an accurate low one.
  Under-confidence in a correct read costs the human a needless check; that is not
  the safe default, it is a different way of being wrong.

Document type — classify it in this same pass:
- "invoice": a request for payment. Usually has an invoice number, payment terms,
  a due date, "Invoice" in the heading, and bill-to details.
- "receipt": proof of a payment already made. Till/card receipts, fuel receipts,
  restaurant bills, online order confirmations. Often has "Receipt"/"Thank you",
  a card/payment line (e.g. "VISA ****1234", "CHANGE", "AUTH CODE"), and no
  payment terms.
- If genuinely ambiguous, pick the more likely one and lower documentType confidence.

supplierName — the counterparty you bought from: the supplier on an invoice, the
merchant/shop/trading name on a receipt. Use the trading name as printed.

invoiceNumber — the invoice number, or a receipt's receipt/transaction number.
Many receipts have NO number at all. If there is none, return "" with confidence 0.
Do NOT substitute a card auth code, till number, order number, or VAT number for it,
and do not invent one. An absent number is expected and handled downstream.

taxItemized — true only if the document actually states a tax/VAT amount as its own
figure. Many receipts show just a gross total, and UK receipts often print a VAT
number without breaking out the VAT amount — that is still false. When it is false,
set tax to 0 with confidence 0 and put the gross amount in total; do not derive,
back-calculate, or estimate the tax. When there is no separate subtotal line either,
set subtotal to 0 with confidence 0 rather than copying the total into it.`;

function fileContentPart(base64: string, mediaType: string): OpenAI.Responses.ResponseInputContent {
  if (mediaType === "application/pdf") {
    return {
      type: "input_file",
      filename: "document.pdf",
      file_data: `data:application/pdf;base64,${base64}`,
    };
  }
  return {
    type: "input_image",
    detail: "high",
    image_url: `data:${mediaType};base64,${base64}`,
  };
}

/**
 * Extract fields from a document — invoice or receipt. One pass does both the
 * classification and the extraction; there is no separate detection call and no
 * second pipeline for receipts. Primary (cheap) read — see lib/anthropic.ts's
 * extractDocumentEscalation for the second-opinion pass on flagged documents.
 *
 * @param base64      the document bytes, base64-encoded (no data: prefix, no newlines)
 * @param mediaType   e.g. "application/pdf", "image/png", "image/jpeg"
 * @param priorHints  the learning loop — short natural-language reminders derived from
 *                    past human corrections (see lib/learning.ts). Injected as context,
 *                    NOT as commands, so the model treats them as helpful prior knowledge.
 */
export async function extractDocument(
  base64: string,
  mediaType: string,
  priorHints?: string,
): Promise<InvoiceExtraction> {
  const instruction = priorHints
    ? `Classify the document type and extract its fields.\n\nWhat we've learned from this user's past corrections (use as guidance, the document is still the source of truth):\n${priorHints}`
    : "Classify the document type and extract its fields.";

  const response = await getClient().responses.create({
    model: MODEL,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [fileContentPart(base64, mediaType), { type: "input_text", text: instruction }],
      },
    ],
    text: { format: jsonSchemaFormat(InvoiceExtractionSchema, "invoice_extraction") },
  });

  if (!response.output_text) {
    throw new Error("Extraction failed: the model did not return a valid structured result.");
  }
  return InvoiceExtractionSchema.parse(JSON.parse(response.output_text));
}

const BANK_STATEMENT_SYSTEM_PROMPT = `You extract structured transaction data from bank/credit-card statements
(PDF) for an accounting reconciliation tool.

Rules:
- Extract every transaction line on the statement — don't skip small or
  recurring-looking ones, and don't summarize/aggregate rows together.
- Never invent a transaction, date, or amount that isn't printed on the page.
- Dates as ISO 8601 (YYYY-MM-DD).
- Amount sign convention (IMPORTANT, and the opposite of how most banks print
  it): positive = a debit / money OUT of the account (a purchase, a fee, a
  withdrawal); negative = a credit / money IN to the account (a deposit, a
  refund, a paid-in transfer). If the statement itself uses "-" for
  withdrawals and no sign (or a "CR" suffix) for deposits, flip the sign
  before you output it, so your output always follows positive-out /
  negative-in regardless of how the source document shows it.
- "merchant" is the payee/description as printed (e.g. "TESCO STORES 2841",
  "SQ *BLUE BOTTLE"); "description" can repeat the same text or add the
  statement's own memo/reference if there is one.
- "transactionId" is the bank's own reference/transaction number if the
  statement prints one; otherwise null. Never invent one.
- openingBalance / closingBalance: the statement's own stated balances, or
  null if not printed. periodStart / periodEnd: the statement period's first
  and last dates (ISO 8601), or null if you can't determine them.
- currency: the ISO code (e.g. "GBP", "USD") if determinable from the
  statement, else null.`;

/**
 * Extract every transaction from a bank/credit-card statement PDF — the
 * reconciliation-side counterpart to extractDocument() above. Same
 * one-call-does-everything shape: no separate "detect the format" pass.
 * Primary (cheap) read — see lib/anthropic.ts's extractBankStatementEscalation
 * for the second-opinion pass on a statement the confidence gate flags.
 */
export async function extractBankStatement(base64: string, mediaType: string): Promise<ParsedStatement> {
  const response = await getClient().responses.create({
    model: MODEL,
    input: [
      { role: "system", content: BANK_STATEMENT_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          fileContentPart(base64, mediaType),
          { type: "input_text", text: "Extract every transaction from this bank statement." },
        ],
      },
    ],
    text: { format: jsonSchemaFormat(ParsedStatementSchema, "parsed_statement") },
  });

  if (!response.output_text) {
    throw new Error("Statement extraction failed: the model did not return a valid structured result.");
  }
  return ParsedStatementSchema.parse(JSON.parse(response.output_text));
}
