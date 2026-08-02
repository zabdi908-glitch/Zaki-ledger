import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface ExtractionResult {
  merchant: string; merchant_confidence: number;
  invoice_number: string; invoice_number_confidence: number;
  transaction_date: string; date_confidence: number;
  amount: number; amount_confidence: number;
  tax_amount: number; tax_confidence: number;
  category: string; category_confidence: number;
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

Return ONLY valid JSON with these exact keys and confidence scores (0-100):
{
  "merchant": "...", "merchant_confidence": 95,
  "invoice_number": "...", "invoice_number_confidence": 88,
  "transaction_date": "2026-07-24", "date_confidence": 99,
  "amount": 184.32, "amount_confidence": 97,
  "tax_amount": 0, "tax_confidence": 60,
  "category": "Office Supplies", "category_confidence": 82,
  "overall_confidence": 92,
  "reason": null
}

Set overall_confidence as the average of all field confidences.
If any field is unclear, set its confidence below 70 and provide a reason string explaining the ambiguity.
Be precise. Do not guess dates or amounts.`;

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
