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
export const SUPPORTED_CURRENCIES = [
  // Major world currencies (emitting currencies)
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD",
  "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK",
  "DJF", "DKK", "DOP", "DZD",
  "EGP", "ERN", "ETB", "EUR",
  "FJD", "FKP",
  "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD",
  "HKD", "HNL", "HTG", "HUF",
  "IDR", "ILS", "INR", "IQD", "IRR", "ISK",
  "JMD", "JOD", "JPY",
  "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
  "LAK", "LBP", "LKR", "LRD", "LSL", "LYD",
  "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN",
  "NAD", "NGN", "NIO", "NOK", "NPR", "NZD",
  "OMR",
  "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG",
  "QAR",
  "RON", "RSD", "RUB", "RWF",
  "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SYP", "SZL",
  "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS",
  "UAH", "UGX", "USD", "UYU", "UZS",
  "VES", "VND", "VUV",
  "WST",
  "XAF", "XCD", "XOF", "XPF",
  "YER",
  "ZAR", "ZMW", "ZWL",
] as const;
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
  // Major currencies with distinct symbols
  AED: "د.إ", AFN: "؋", ALL: "L", AMD: "֏", ANG: "ƒ", AOA: "Kz", ARS: "$", AUD: "A$", AWG: "ƒ", AZN: "₼",
  BAM: "KM", BBD: "$", BDT: "৳", BGN: "лв", BHD: ".د.ب", BIF: "FBu", BMD: "$", BND: "$", BOB: "Bs", BRL: "R$",
  BSD: "$", BTN: "Nu.", BWP: "P", BYN: "Br", BZD: "$",
  CAD: "C$", CDF: "FC", CHF: "CHF", CLP: "$", CNY: "¥", COP: "$", CRC: "₡", CUP: "$", CVE: "$", CZK: "Kč",
  DJF: "Fdj", DKK: "kr", DOP: "$", DZD: "دج",
  EGP: "£", ERN: "Nfk", ETB: "Br", EUR: "€",
  FJD: "$", FKP: "£",
  GBP: "£", GEL: "₾", GHS: "₵", GIP: "£", GMD: "D", GNF: "FG", GTQ: "Q", GYD: "$",
  HKD: "HK$", HNL: "L", HTG: "G", HUF: "Ft",
  IDR: "Rp", ILS: "₪", INR: "₹", IQD: "ع.د", IRR: "﷼", ISK: "kr",
  JMD: "$", JOD: "د.ا", JPY: "¥",
  KES: "KSh", KGS: "с", KHR: "៛", KMF: "CF", KPW: "₩", KRW: "₩", KWD: "د.ك", KYD: "$", KZT: "₸",
  LAK: "₭", LBP: "£", LKR: "Rs", LRD: "$", LSL: "L", LYD: "ل.د",
  MAD: "د.م.", MDL: "L", MGA: "Ar", MKD: "ден", MMK: "K", MNT: "₮", MOP: "MOP$", MRU: "UM", MUR: "Rs", MVR: "Rf", MWK: "MK", MXN: "Mex$", MYR: "RM", MZN: "MT",
  NAD: "$", NGN: "₦", NIO: "C$", NOK: "kr", NPR: "Rs", NZD: "NZ$",
  OMR: "ر.ع.",
  PAB: "B/.", PEN: "S/", PGK: "K", PHP: "₱", PKR: "Rs", PLN: "zł", PYG: "₲",
  QAR: "ر.ق",
  RON: "lei", RSD: "дин", RUB: "₽", RWF: "FRw",
  SAR: "﷼", SBD: "$", SCR: "Rs", SDG: "ج.س.", SEK: "kr", SGD: "S$", SHP: "£", SLE: "Le", SOS: "Sh", SRD: "$", SSP: "£", STN: "Db", SYP: "£", SZL: "E",
  THB: "฿", TJS: "ЅМ", TMT: "m", TND: "د.ت", TOP: "T$", TRY: "₺", TTD: "$", TWD: "NT$", TZS: "TSh",
  UAH: "₴", UGX: "USh", USD: "$", UYU: "$", UZS: "so'm",
  VES: "Bs.", VND: "₫", VUV: "VT",
  WST: "T",
  XAF: "FCFA", XCD: "$", XOF: "CFA", XPF: "₣",
  YER: "﷼",
  ZAR: "R", ZMW: "ZK", ZWL: "$",
};

/** e.g. "£288.00", or "JPY 1200.00" for a code we have no symbol for. */
export function formatMoney(amount: number, currency: string | null | undefined): string {
  const code = (currency ?? "").trim().toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${code || "?"} ${amount.toFixed(2)}`;
}
