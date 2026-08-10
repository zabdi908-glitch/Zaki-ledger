import { createHash } from "node:crypto";

export const BANK_FINGERPRINT_VERSION = 1;
export const ACCOUNTING_FINGERPRINT_VERSION = 1;

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeIdentityText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
  return normalized || null;
}

export function normalizeCurrency(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().toUpperCase() ?? "";
  return normalized || null;
}

export function currencyMinorUnitDigits(currency: string | null | undefined): number {
  const code = normalizeCurrency(currency);
  if (code && ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (code && THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

export function amountToMinorUnits(amount: number, currency: string | null | undefined): number {
  if (!Number.isFinite(amount)) throw new Error("Fingerprint amount must be finite.");
  const factor = 10 ** currencyMinorUnitDigits(currency);
  const minorUnits = Math.round((amount + Math.sign(amount) * Number.EPSILON) * factor);
  if (!Number.isSafeInteger(minorUnits)) throw new Error("Fingerprint amount exceeds safe integer precision.");
  return minorUnits;
}

function digestPayload(version: string, fields: Record<string, string | number | null>): string {
  // JSON over a fixed insertion order gives every value an explicit field name
  // and null marker, avoiding delimiter ambiguity in financial identities.
  return sha256Hex(JSON.stringify({ version, ...fields }));
}

export interface BankFingerprintInput {
  sourceProvider: string | null;
  sourceOrganisationId: string | null;
  sourceAccountId: string | null;
  transactionDate: string;
  postedDate: string | null;
  amount: number;
  currency: string | null;
  merchant: string | null;
  description: string | null;
  reference: string | null;
}

export function bankTransactionFingerprint(input: BankFingerprintInput): string {
  const currency = normalizeCurrency(input.currency);
  return digestPayload(`bank-v${BANK_FINGERPRINT_VERSION}`, {
    sourceProvider: normalizeIdentityText(input.sourceProvider),
    sourceOrganisationId: normalizeIdentityText(input.sourceOrganisationId),
    sourceAccountId: normalizeIdentityText(input.sourceAccountId),
    transactionDate: input.transactionDate,
    postedDate: input.postedDate,
    amountMinor: amountToMinorUnits(input.amount, currency),
    currency,
    merchant: normalizeIdentityText(input.merchant),
    description: normalizeIdentityText(input.description),
    reference: normalizeIdentityText(input.reference),
  });
}

export interface AccountingFingerprintInput {
  provider: string | null;
  organisationId: string | null;
  externalObjectType: string | null;
  accountId: string | null;
  postedDate: string;
  amount: number;
  currency: string | null;
  description: string | null;
}

export function accountingTransactionFingerprint(input: AccountingFingerprintInput): string {
  const currency = normalizeCurrency(input.currency);
  return digestPayload(`accounting-v${ACCOUNTING_FINGERPRINT_VERSION}`, {
    provider: normalizeIdentityText(input.provider),
    organisationId: normalizeIdentityText(input.organisationId),
    externalObjectType: normalizeIdentityText(input.externalObjectType),
    accountId: normalizeIdentityText(input.accountId),
    postedDate: input.postedDate,
    amountMinor: amountToMinorUnits(input.amount, currency),
    currency,
    description: normalizeIdentityText(input.description),
  });
}

export interface OfxAccountIdentity {
  sourceAccountId: string;
  metadata: {
    bankIdHash: string | null;
    accountLast4: string | null;
    accountType: string | null;
  };
}

export function deriveOfxAccountIdentity(input: {
  bankId?: string | null;
  accountId?: string | null;
  accountType?: string | null;
}): OfxAccountIdentity | null {
  const bankId = normalizeIdentityText(input.bankId);
  const accountId = normalizeIdentityText(input.accountId);
  const accountType = normalizeIdentityText(input.accountType);
  if (!accountId) return null;

  return {
    // The raw account number is deliberately absent from persisted/parser output.
    sourceAccountId: sha256Hex(JSON.stringify({ version: "ofx-account-v1", bankId, accountId, accountType })),
    metadata: {
      bankIdHash: bankId ? sha256Hex(bankId) : null,
      accountLast4: accountId.slice(-4),
      accountType,
    },
  };
}
