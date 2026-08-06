import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import type { BankTransaction, QbTransaction } from "./reconciliation-schema";

const client = new Anthropic();
const MODEL = "claude-sonnet-5";

export interface FuzzyResolution {
  bankTransactionId: string;
  qbTransactionId: string | null;
  resolvedBankMerchant: string;
  resolvedQbMerchant: string;
  confidence: number;
  explanation: string;
}

const SYSTEM_PROMPT = `You are an expert accounting reconciliation assistant. Match bank-statement transactions to QuickBooks transactions when merchant names don't exactly match but clearly refer to the same entity.

Look at amounts, dates, and raw strings. Recognize common patterns:
- AMZN, AMZN MKTP → Amazon
- SQ*, SQSP, Square → Square
- TFL → Transport for London
- USPS → United States Postal Service
- GOOGLE, GOOGL → Google
- MSFT → Microsoft

Rules:
- Only match if amount is within ~1% and date within ~7 days.
- Never invent transactions not in the provided lists.
- Return null qbTransactionId if uncertain.
- Confidence 0-1. Be conservative.`;

const FuzzyMatchSchema = z.object({
  bankTransactionId: z.string(),
  qbTransactionId: z.string().nullable(),
  resolvedBankMerchant: z.string(),
  resolvedQbMerchant: z.string(),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
});

const FuzzyMatchesOutputSchema = z.object({
  matches: z.array(FuzzyMatchSchema),
});

export async function resolveFuzzyMerchants(
  unmatchedBank: BankTransaction[],
  unmatchedQb: QbTransaction[],
): Promise<FuzzyResolution[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return [];
  }

  if (unmatchedBank.length === 0) {
    return [];
  }

  const userPrompt = `Match these unmatched bank transactions to QB transactions.

Bank transactions:
${unmatchedBank
  .map(
    (b) =>
      `- ID: ${b.id} | Date: ${b.transactionDate} | Amount: ${b.amount} | Merchant: ${b.merchant ?? b.description ?? "(none)"}`,
  )
  .join("\n")}

QB transactions:
${unmatchedQb
  .map(
    (q) =>
      `- ID: ${q.id} | Date: ${q.postedDate} | Amount: ${q.amount} | Description: ${q.description ?? "(none)"}`,
  )
  .join("\n")}

Return a matches array. Set qbTransactionId to null when uncertain.`;

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      output_config: { format: zodOutputFormat(FuzzyMatchesOutputSchema) },
    });

    if (!response.parsed_output) {
      console.warn("Claude fuzzy merchant resolution returned no parsed output");
      return [];
    }

    const bankIds = new Set(unmatchedBank.map((b) => b.id));
    const qbIds = new Set(unmatchedQb.map((q) => q.id));

    return response.parsed_output.matches.filter((m) => {
      if (!bankIds.has(m.bankTransactionId)) {
        console.warn(`Unknown bankTransactionId from Claude: ${m.bankTransactionId}`);
        return false;
      }
      if (m.qbTransactionId !== null && !qbIds.has(m.qbTransactionId)) {
        console.warn(`Unknown qbTransactionId from Claude: ${m.qbTransactionId}`);
        return false;
      }
      return true;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Fuzzy merchant resolution failed: ${message}`);
    return [];
  }
}