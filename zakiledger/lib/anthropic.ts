import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { InvoiceExtractionSchema, type InvoiceExtraction } from "./schema";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

/** claude-opus-4-8 is the current, most capable model — correctness-first for the MVP. */
const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You extract structured data from UK invoices and receipts for an accounting tool.
Rules:
- Extract exactly what is on the document. Never invent a value.
- Give each field a confidence from 0 to 1. Be conservative: if a value is smudged,
  ambiguous, or inferred, lower the confidence.
- Dates as ISO 8601 (YYYY-MM-DD) when you can read them unambiguously.
- Amounts as plain numbers (no currency symbols or thousands separators).
- A human reviews everything you produce, so it is far better to flag low confidence
  than to guess with false confidence.

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

function documentBlock(base64: string, mediaType: string): Anthropic.ContentBlockParam {
  if (mediaType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
  }
  // Anthropic accepts png/jpeg/gif/webp for images; the cast narrows the dynamic
  // upload media type to the SDK's expected literal union.
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
      data: base64,
    },
  };
}

/**
 * Extract fields from a document — invoice or receipt. One pass does both the
 * classification and the extraction; there is no separate detection call and no
 * second pipeline for receipts.
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

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [documentBlock(base64, mediaType), { type: "text", text: instruction }],
      },
    ],
    output_config: { format: zodOutputFormat(InvoiceExtractionSchema) },
  });

  if (!response.parsed_output) {
    throw new Error("Extraction failed: the model did not return a valid structured result.");
  }
  return response.parsed_output;
}
