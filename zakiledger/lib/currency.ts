/**
 * Currency rules — which ones we can post a bill in, and how to render an amount.
 *
 * A standalone, dependency-free module on purpose: the browser needs `formatMoney`
 * to render the queue, and importing it from lib/accounting.ts would drag the Xero
 * and QuickBooks OAuth chain into the client bundle for the sake of a "£".
 */

/**
 * Currencies we will post a bill in. A code outside this list is a hard stop, not
 * a low-confidence read: the accounting platform would either reject the bill or
 * silently book it in the org's base currency at the wrong amount, and neither is
 * something a human reviewing confidence scores would catch. So it fails fast and
 * says why, rather than going out as a plausible-looking wrong number.
 *
 * Narrow on purpose — these are the currencies a UK bookkeeping pilot actually
 * sees. Widening it is a one-line change once an org has the currency enabled on
 * their side (Xero rejects a CurrencyCode the organisation hasn't added).
 */
export const SUPPORTED_CURRENCIES = ["GBP", "EUR", "USD", "AUD", "NZD", "CAD"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** True when we can post a bill in this currency. Case/whitespace tolerant. */
export function isSupportedCurrency(code: string | null | undefined): boolean {
  if (!code) return false;
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.trim().toUpperCase());
}

/** Why an unsupported currency was rejected, in words a bookkeeper can act on. */
export function unsupportedCurrencyReason(code: string | null | undefined): string {
  const shown = code?.trim() ? `"${code.trim()}"` : "(none detected)";
  return `Unsupported currency ${shown} — bills can only be posted in ${SUPPORTED_CURRENCIES.join(", ")}.`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£",
  EUR: "€",
  USD: "$",
  AUD: "A$",
  NZD: "NZ$",
  CAD: "C$",
};

/** e.g. "£288.00", or "JPY 1200.00" for a code we have no symbol for. */
export function formatMoney(amount: number, currency: string | null | undefined): string {
  const code = (currency ?? "").trim().toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${code || "?"} ${amount.toFixed(2)}`;
}
