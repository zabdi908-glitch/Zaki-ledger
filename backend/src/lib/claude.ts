import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function validateLowConfidence(
  fields: Record<string, { value: any; confidence: number }>
): Promise<{ validated: boolean; corrections: Record<string, any> }> {
  const lowConfFields = Object.entries(fields).filter(([_, v]) => v.confidence < 70);
  if (lowConfFields.length === 0) return { validated: true, corrections: {} };

  const prompt = `Review these low-confidence extraction fields and provide corrected values if needed.

Fields:
${lowConfFields.map(([k, v]) => `- ${k}: "${v.value}" (confidence: ${v.confidence})`).join('\n')}

Return ONLY JSON: { "validated": true/false, "corrections": { "field_name": "corrected_value", ... } }`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { validated: false, corrections: {} };
  return JSON.parse(jsonMatch[0]);
}
