/**
 * Hardcoded UK merchant knowledge base — fast, free, explainable. First rule
 * to match wins, so more specific patterns must sit above broader ones
 * (AMAZON WEB above AMAZON). Confidence is per-rule: how unambiguous that
 * merchant string is about the spend category, not how sure the regex is.
 */
interface Rule {
  pattern: RegExp;
  category: string;
  confidencePct: number;
}

const RULES: Rule[] = [
  { pattern: /amazon web|aws\b/i, category: "Software & SaaS", confidencePct: 96 },
  { pattern: /google workspace|google gsuite|microsoft 365|msft.*365|adobe|zoom\.us|slack|notion|dropbox|figma|github|atlassian/i, category: "Software & SaaS", confidencePct: 96 },
  { pattern: /hmrc.*vat|vat.*hmrc/i, category: "VAT Control Account", confidencePct: 98 },
  { pattern: /hmrc.*paye|hmrc.*ni\b/i, category: "PAYE/NI Liability", confidencePct: 97 },
  { pattern: /\bshell\b|\bbp\b|esso|texaco|petrol|\bfuel\b/i, category: "Motor Expenses", confidencePct: 94 },
  { pattern: /\btesco\b|sainsbury|asda|morrisons|aldi|\blidl\b|waitrose/i, category: "Subsistence", confidencePct: 85 },
  { pattern: /wise transfer|transferwise|revolut.*transfer|\bxfer\b/i, category: "Transfer", confidencePct: 99 },
  { pattern: /amazon/i, category: "Office Supplies", confidencePct: 92 },
  { pattern: /trainline|\btfl\b|national rail|uber\b|bolt\b|addison lee/i, category: "Travel", confidencePct: 93 },
  { pattern: /pret a manger|costa coffee|starbucks|greggs|deliveroo|just eat/i, category: "Meals", confidencePct: 90 },
  { pattern: /british gas|edf energy|octopus energy|thames water|severn trent/i, category: "Utilities", confidencePct: 96 },
  { pattern: /vodafone|\bee\b|o2\b|three\.co|virgin media|\bbt\b/i, category: "Telephone & Internet", confidencePct: 93 },
  { pattern: /screwfix|b&q|wickes|toolstation|travis perkins/i, category: "Materials", confidencePct: 92 },
];

/** Dropdown list for manual override. Superset of the rules' categories plus
 * the extraction pipeline's GL list (lib/schema.ts) so both flows agree. */
export const GL_CATEGORIES: string[] = [
  "Software & SaaS", "Travel", "Meals", "Office Supplies", "Materials", "Rent",
  "Utilities", "Fuel", "Motor Expenses", "Merchandise", "Professional Services",
  "Subsistence", "Telephone & Internet", "Transfer", "VAT Control Account",
  "PAYE/NI Liability", "Uncategorised",
];

export function suggestMerchantCategory(name: string | null): { category: string; confidencePct: number } | null {
  if (!name) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(name)) return { category: rule.category, confidencePct: rule.confidencePct };
  }
  return null;
}
