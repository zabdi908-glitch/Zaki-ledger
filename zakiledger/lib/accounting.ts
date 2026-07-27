import type { DocumentType, LineItem } from "./schema";
import { createXeroDraftBill, isXeroConnected } from "./xero";
import { createQuickBooksBill, isQuickBooksConnected } from "./quickbooks";

/**
 * The bookkeeping side of the app: once an invoice is human-approved, push it as
 * a draft bill to whichever accounting platform the user has connected.
 *
 * A single normalized shape (`ApprovedBill`) is produced by the approve route
 * from the human-approved values, then handed to the connected provider. When no
 * platform is connected (the default demo state), nothing is posted — the
 * approval still succeeds, consistent with the rest of the app running keyless.
 */
export interface ApprovedBill {
  /** invoice | receipt — only affects wording on the posted line, not the shape. */
  documentType?: DocumentType;
  supplierName: string;
  invoiceNumber: string | null;
  invoiceDate: string | null; // ISO date
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  lineItems: LineItem[];
}

/**
 * Description for a single summary line, e.g. "Receipt R-88213" or, when the
 * document carries no number (common on receipts), just "Imported receipt".
 */
export function billLineDescription(bill: ApprovedBill): string {
  const noun = bill.documentType === "receipt" ? "Receipt" : "Invoice";
  return bill.invoiceNumber?.trim()
    ? `${noun} ${bill.invoiceNumber.trim()}`
    : `Imported ${noun.toLowerCase()}`;
}

/** The platform a bill was posted to, plus its id in that platform. */
export interface PostedBill {
  platform: "xero" | "quickbooks";
  billId: string;
}

// Currency rules live in lib/currency.ts (dependency-free, so the browser can use
// them too) and are re-exported here, where callers already look for bill rules.
export {
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  unsupportedCurrencyReason,
  formatMoney,
  type SupportedCurrency,
} from "./currency";

/**
 * Post the approved bill to the connected platform, if any. Xero is preferred
 * when both happen to be connected. Returns null when neither is connected, so
 * the caller can treat "not connected" and "posted" uniformly.
 */
export async function postApprovedBill(bill: ApprovedBill): Promise<PostedBill | null> {
  if (await isXeroConnected()) {
    return { platform: "xero", billId: await createXeroDraftBill(bill) };
  }
  if (await isQuickBooksConnected()) {
    return { platform: "quickbooks", billId: await createQuickBooksBill(bill) };
  }
  return null;
}
