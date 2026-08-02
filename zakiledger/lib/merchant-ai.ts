import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { GL_CATEGORIES } from "./merchant-categories";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

/** claude-sonnet-5 — picked over Haiku 4.5 for reasoning quality: this is the
 * one place the model has to explain *why* a merchant fits a category, not
 * just emit a bare label. */
const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You classify UK bank-statement merchant names into a fixed
general-ledger category list for an accounting reconciliation tool, and briefly explain
why.

Rules:
- Pick exactly one category from the allowed list below. Never invent a category.
- The reason is one sentence, written for an accountant, naming what about the merchant
  name suggests that category (the business type, a known brand, a payment pattern).
- Be conservative with confidence: a well-known brand with an obvious category (e.g. a
  petrol station chain) should score 85-99. A generic or ambiguous name should score well
  below that, even if you still have to pick a best-guess category.
- If the name gives you nothing to go on, pick "Uncategorised" and say so plainly in the
  reason rather than guessing at a specific category.

Allowed categories: ${GL_CATEGORIES.join(", ")}`;

const MerchantCategorySchema = z.object({
  category: z.enum(GL_CATEGORIES as [string, ...string[]]),
  confidencePct: z.number().min(0).max(100),
  reason: z.string().min(1),
});

export interface MerchantAiCategory {
  category: string;
  confidencePct: number;
  reason: string;
}

/**
 * Classify one merchant name via a live Claude call — the AI fallback for
 * merchants the hardcoded table (lib/merchant-categories.ts) doesn't recognise.
 * Never throws: any failure (missing/invalid API key, network, rate limit, an
 * unparseable response) is caught, logged, and reported as `null` so callers
 * can fall through to "Uncategorised" exactly as they would have before this
 * function existed.
 */
export async function classifyMerchant(name: string): Promise<MerchantAiCategory | null> {
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Classify this bank-statement merchant name: "${name}"` }],
      output_config: { format: zodOutputFormat(MerchantCategorySchema) },
    });
    if (!response.parsed_output) {
      console.warn(`merchant classification returned no parsed output for "${name}"`);
      return null;
    }
    return response.parsed_output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`merchant classification failed for "${name}": ${message}`);
    return null;
  }
}
