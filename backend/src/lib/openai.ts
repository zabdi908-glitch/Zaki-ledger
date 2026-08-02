import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface ExtractionResult {
  merchant: string; merchant_confidence: number; merchant_confidence_reason: string;
  invoice_number: string; invoice_number_confidence: number; invoice_number_confidence_reason: string;
  transaction_date: string; date_confidence: number; date_confidence_reason: string;
  amount: number; amount_confidence: number; amount_confidence_reason: string;
  tax_amount: number; tax_confidence: number; tax_confidence_reason: string;
  category: string; category_confidence: number; category_confidence_reason: string;
  overall_confidence: number;
  reason: string | null;
}

const SYSTEM_PROMPT = `You are an expert accounting document parser. Extract these fields from the provided document image or text:
- merchant: the vendor/merchant name
- invoice_number: the invoice or receipt number
- transaction_date: ISO date (YYYY-MM-DD)
- amount: total amount as number
- tax_amount: tax/VAT amount as number (0 if not visible)
- category: best GL category from [Software & SaaS, Travel, Meals, Office Supplies, Materials, Rent, Utilities, Fuel, Merchandise, Professional Services, Uncategorized]

For every field, also give a confidence score (0-100) AND a one-sentence reason for that score — always populated, even at high confidence (e.g. "Standard date format, clearly printed" or "Handwritten, difficult to read").

Return ONLY valid JSON with these exact keys:
{
  "merchant": "...", "merchant_confidence": 95, "merchant_confidence_reason": "...",
  "invoice_number": "...", "invoice_number_confidence": 88, "invoice_number_confidence_reason": "...",
  "transaction_date": "2026-07-24", "date_confidence": 99, "date_confidence_reason": "...",
  "amount": 184.32, "amount_confidence": 97, "amount_confidence_reason": "...",
  "tax_amount": 0, "tax_confidence": 60, "tax_confidence_reason": "...",
  "category": "Office Supplies", "category_confidence": 82, "category_confidence_reason": "...",
  "overall_confidence": 92,
  "reason": null
}

Set overall_confidence as the average of all field confidences.
Be precise. Do not guess dates or amounts. Do not guess text on damaged or illegible documents — lower the confidence and say so in the reason instead.`;

export async function extractDocument(base64Image: string, mimeType: string): Promise<ExtractionResult> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract all fields from this document.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
        ]
      }
    ],
    max_tokens: 800,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error('Empty response from OpenAI');
  return JSON.parse(content) as ExtractionResult;
}

export async function extractFromText(text: string): Promise<ExtractionResult> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Extract all fields from this text:
${text}` }
    ],
    max_tokens: 800,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error('Empty response from OpenAI');
  return JSON.parse(content) as ExtractionResult;
}
