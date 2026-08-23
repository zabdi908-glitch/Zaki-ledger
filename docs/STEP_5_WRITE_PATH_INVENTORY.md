# Step 5 Day 1 — Authoritative External Financial Write-Path Inventory

Date: 2026-08-22

Scope: current repository working tree at `main` / `f6a5dd5cc952f8fd318aca44ccb4569bba794bbb`. This was a read-only code investigation. No production system or provider was accessed, and no provider request was executed.

## Verdict

Day 1 exit conditions are satisfied.

- Authoritative end-to-end write-path count: **6**
- Unique external mutation primitives: **3**
- Providers with financial writes: **QuickBooks Online and Xero**
- SAFE: **0**
- NEEDS_HARDENING: **0**
- UNSAFE: **6**
- DEAD_LEGACY: **0**
- UNKNOWN: **0**

The count is by independently reachable API-route-to-external-object path. A shared provider method reached by both the single and bulk approval routes is counted twice because the evidence, approval, idempotency, error, and audit behaviour differ. UI call sites and the compiled `.next` copy are not counted again. OAuth token operations are inventoried separately as provider control-plane side effects, not financial-object writes.

## Authoritative Call Graph

```text
POST /api/approve
  -> postApprovedBill(user.id, caller-supplied approved values)
     -> Xero connected: createXeroDraftBill -> POST /Invoices
     -> otherwise QuickBooks connected:
        -> createQuickBooksBill
           -> findOrCreateVendor -> conditional POST /vendor
           -> POST /bill

POST /api/approve/bulk
  -> bulkApprove -> approveOne for each selected pending document
     -> postApprovedBill(user.id, stored extraction)
        -> Xero connected: createXeroDraftBill -> POST /Invoices
        -> otherwise QuickBooks connected:
           -> createQuickBooksBill
              -> findOrCreateVendor -> conditional POST /vendor
              -> POST /bill
```

When both providers have stored connection rows, `postApprovedBill` always selects Xero. The caller does not select a client, ledger book, provider connection, or provider destination.

## Write Paths

### WP-01 — Single approval may create a QuickBooks Vendor

- **Provider:** QuickBooks Online.
- **File/function/route:** `zakiledger/app/api/approve/route.ts` `POST` -> `zakiledger/lib/accounting.ts:postApprovedBill` -> `zakiledger/lib/quickbooks.ts:createQuickBooksBill` -> `findOrCreateVendor` -> `qboPost("vendor", ...)`.
- **Operation type:** Conditional CREATE after a name query.
- **External financial object:** QuickBooks Vendor master-data object.
- **Client binding:** Only the authenticated `user.id`; no canonical `client_entity_id` is resolved or checked.
- **Ledger-book binding:** None. No `ledger_books` row or external book namespace is supplied or checked.
- **Provider-connection binding:** `oauth_connections` is loaded by `(user_id, "quickbooks")`; its unverified `org_id` becomes the QuickBooks `realmId`. It is not linked to canonical `provider_connections`, a client, or a ledger book.
- **Account-selection logic:** Not applicable to Vendor creation.
- **Tax-selection logic:** Not applicable to Vendor creation.
- **Evidence required:** At the route, supported currency and a `ready` confidence gate. The supplier name is taken from the request extraction/edits, but the request may omit `documentId`, need not link to stored source evidence, and is not parsed with `InvoiceExtractionSchema`. A duplicate warning can be overridden with `proceedDuplicate`.
- **Approval requirement:** Any authenticated user can call `POST /api/approve`; Vendor creation is an implicit side effect of bill approval. There is no separate Vendor approval, accounting role check, policy decision, or provider-target confirmation.
- **Idempotency mechanism:** A pre-create QuickBooks query for exact `DisplayName`; this is race-prone and is not a provider idempotency key or local unique operation identity.
- **Retry behaviour:** No explicit retry. A later full approval attempt queries by name again, but no recovery operation is defined.
- **Timeout-after-success behaviour:** No explicit request timeout. If the provider creates the Vendor and the response is lost, the path reports a generic bill-posting error. It records neither `UNCERTAIN` nor the Vendor ID.
- **External-state verification:** Existing-object query before create and response-ID parsing only; no post-create GET or reconciliation by operation identity.
- **Audit behaviour:** The local invoice, corrections, and confirmations are written before provider work. No Vendor request, response, ID, realm binding, or outcome is persisted in a posting audit.
- **Risk:** **UNSAFE**.

### WP-02 — Single approval creates a QuickBooks Bill

- **Provider:** QuickBooks Online.
- **File/function/route:** `zakiledger/app/api/approve/route.ts` `POST` -> `zakiledger/lib/accounting.ts:postApprovedBill` -> `zakiledger/lib/quickbooks.ts:createQuickBooksBill` -> `qboPost("bill", ...)`.
- **Operation type:** CREATE.
- **External financial object:** QuickBooks Bill.
- **Client binding:** Authenticated `user.id` only; no canonical client resolution, client access check, or client stamp on the operation.
- **Ledger-book binding:** None. The destination realm is not checked against a `ledger_books` row.
- **Provider-connection binding:** The `(user_id, "quickbooks")` `oauth_connections` row supplies tokens and `org_id`/realm. There is no binding to canonical `provider_connections`, client, book, or an active connection status.
- **Account-selection logic:** Queries `Account` for `AccountType = 'Expense' maxresults 1` and silently uses the first returned ID. It does not use a provider account selected by a human, `financial_accounts`, `user_merchant_preferences`, or `merchant_ai_categories`.
- **Tax-selection logic:** None. Extracted subtotal and tax are ignored, no `TaxCodeRef` is sent, and the bill contains one expense line for `total`. Extracted currency is also not sent to QuickBooks.
- **Evidence required:** Supported currency and `ready` confidence for document type, critical fields, tax, and currency. Edits/affirmations become confidence 1.0. Arithmetic mismatch is deliberately not a server-side stop on this route. The body may be caller-fabricated and unlinked to a stored document; a non-numeric edited total becomes `null` and the provider method substitutes `0`.
- **Approval requirement:** An authenticated call to the approval route. No accountant role, canonical client permission, posting policy, separate posting authorization, target confirmation, account approval, or tax approval.
- **Idempotency mechanism:** No operation ID, provider idempotency key, or durable provider-object mapping. Optional `DocNumber` is not used as a code-enforced idempotency key. The duplicate lookup and optional pending-document `resolved` check are non-atomic, can be bypassed, and do not prevent concurrent submissions.
- **Retry behaviour:** No provider retry. The caller can repeat approval; an internal duplicate warning may intervene but can be overridden.
- **Timeout-after-success behaviour:** No explicit request timeout and no `UNCERTAIN` state. A lost success response is caught as a generic `billError`; the local invoice already exists and a supplied pending document is then resolved as approved. The external Bill ID is lost.
- **External-state verification:** Only parses `Bill.Id` from the create response; no independent GET/query or expected-state comparison.
- **Audit behaviour:** Local approval/correction/confirmation records exist, but the provider request, payload hash, realm, selected account, response, and Bill ID are not persisted. `billId` and `billPlatform` exist only in the HTTP response; single-route posting errors are not durably recorded.
- **Risk:** **UNSAFE**.

### WP-03 — Single approval creates a Xero draft ACCPAY Bill

- **Provider:** Xero.
- **File/function/route:** `zakiledger/app/api/approve/route.ts` `POST` -> `zakiledger/lib/accounting.ts:postApprovedBill` -> `zakiledger/lib/xero.ts:createXeroDraftBill` -> `POST https://api.xero.com/api.xro/2.0/Invoices`.
- **Operation type:** CREATE.
- **External financial object:** Xero Invoice with `Type=ACCPAY` and `Status=DRAFT` (a draft supplier bill).
- **Client binding:** Authenticated `user.id` only; no canonical `client_entity_id` or client access binding.
- **Ledger-book binding:** None. The Xero tenant is not checked against a `ledger_books` row.
- **Provider-connection binding:** The `(user_id, "xero")` `oauth_connections` row supplies tokens and `org_id`/tenant ID. OAuth callback selection takes the first `/connections` tenant. There is no canonical `provider_connections`/client/book binding or caller target selection.
- **Account-selection logic:** None. No Xero AccountCode/AccountID is sent. Draft status defers account treatment to a later human inside Xero.
- **Tax-selection logic:** Sends `LineAmountTypes="Exclusive"` but no line `TaxType`; the extracted tax total is not translated into provider tax treatment. This can leave provider defaults to determine treatment.
- **Evidence required:** Same single-route confidence/currency gate and weaknesses as WP-02. Line items come from caller-supplied extraction; if absent, a summary line uses `total ?? 0`. There is no durable source-evidence requirement.
- **Approval requirement:** Any authenticated caller of `POST /api/approve`; no accountant role, canonical permission, posting policy, target, account, or tax authorization.
- **Idempotency mechanism:** None. Optional `InvoiceNumber` is sent but is not treated as a code-enforced idempotency key. Local duplicate/resolution checks are non-atomic and bypassable.
- **Retry behaviour:** No provider retry. A later request can create another draft.
- **Timeout-after-success behaviour:** No explicit timeout and no `UNCERTAIN` state. A lost success response becomes generic `billError` after the local invoice has already been approved; the Xero InvoiceID is lost.
- **External-state verification:** Only parses the first returned `InvoiceID`; no GET/query or expected-state verification.
- **Audit behaviour:** No durable posting operation, tenant/payload record, provider response, or InvoiceID. The returned ID/platform exist only in the API response; single-route errors are not durably recorded.
- **Risk:** **UNSAFE**.

### WP-04 — Bulk approval may create a QuickBooks Vendor

- **Provider:** QuickBooks Online.
- **File/function/route:** `zakiledger/app/api/approve/bulk/route.ts` `POST` -> `zakiledger/lib/bulk-approve.ts:bulkApprove/approveOne` -> `postApprovedBill` -> `createQuickBooksBill` -> `findOrCreateVendor` -> `qboPost("vendor", ...)`.
- **Operation type:** Conditional CREATE after a name query.
- **External financial object:** QuickBooks Vendor master-data object.
- **Client binding:** Authenticated `user.id` and a pending document scoped to that user; no canonical client binding.
- **Ledger-book binding:** None.
- **Provider-connection binding:** User/provider `oauth_connections` row and its realm ID only; no canonical provider connection, client, or book binding.
- **Account-selection logic:** Not applicable to Vendor creation.
- **Tax-selection logic:** Not applicable to Vendor creation.
- **Evidence required:** The pending document must exist for the user and be unresolved; supported currency, a raw-confidence `ready` gate, arithmetic consistency when tax is itemised, and no local duplicate are required. The source remains an extraction blob, and `/api/pending/demo` can seed synthetic documents when `ANTHROPIC_API_KEY` is absent.
- **Approval requirement:** Authenticated submission of selected document IDs. Each passing item posts automatically; no separate provider write approval, Vendor approval, accounting role, or policy decision.
- **Idempotency mechanism:** In-request ID de-duplication, pending `resolved` check, local document duplicate check, and Vendor name lookup. None is an atomic external operation identity; concurrent requests can pass together.
- **Retry behaviour:** Batch processing is sequential and catches errors per item, but provider calls are not retried.
- **Timeout-after-success behaviour:** No explicit timeout or `UNCERTAIN`. A lost Vendor-create response is reported as a posting error with no Vendor ID or verification.
- **External-state verification:** Name query before create and response-ID parsing only.
- **Audit behaviour:** Local invoice/confirmation rows are written first. Vendor creation itself has no durable provider-target, request, response, ID, or outcome audit.
- **Risk:** **UNSAFE**.

### WP-05 — Bulk approval creates a QuickBooks Bill

- **Provider:** QuickBooks Online.
- **File/function/route:** `zakiledger/app/api/approve/bulk/route.ts` `POST` -> `zakiledger/lib/bulk-approve.ts:bulkApprove/approveOne` -> `zakiledger/lib/accounting.ts:postApprovedBill` -> `zakiledger/lib/quickbooks.ts:createQuickBooksBill` -> `qboPost("bill", ...)`.
- **Operation type:** CREATE.
- **External financial object:** QuickBooks Bill.
- **Client binding:** Authenticated user and user-owned pending row only; no canonical client binding.
- **Ledger-book binding:** None.
- **Provider-connection binding:** User/provider OAuth row and realm ID only; no canonical provider connection/client/book validation.
- **Account-selection logic:** Silently chooses the first QuickBooks Expense account; merchant preferences and AI categories are not consulted and no human-selected account is required.
- **Tax-selection logic:** None; tax/subtotal are ignored, no tax code is sent, and currency is not sent.
- **Evidence required:** Stored pending extraction, supported currency, all confidence tiers `ready`, itemised-tax arithmetic consistent, and no duplicate. These are extraction-quality gates, not evidence of account/tax treatment. Demo-seeded records can reach this route.
- **Approval requirement:** Authenticated bulk selection; no role/policy/target/account/tax authorization.
- **Idempotency mechanism:** Unique IDs within one request, pending resolved check, and local duplicate check only. There is no atomic claim, posting operation row, provider key, or stored Bill ID. Two workers/requests can create duplicates.
- **Retry behaviour:** No provider retry; one item failing does not stop later items.
- **Timeout-after-success behaviour:** No explicit timeout or `UNCERTAIN`. The local invoice is already saved. The catch attempts to resolve the pending row with outcome `error` and the invoice ID, intentionally preventing ordinary queue retry, but it cannot establish whether QuickBooks created the Bill.
- **External-state verification:** Response-ID parsing only.
- **Audit behaviour:** The pending row may durably store a generic failure reason and local invoice ID, but never the provider Bill ID, realm, account, payload, response, or verified outcome.
- **Risk:** **UNSAFE**.

### WP-06 — Bulk approval creates a Xero draft ACCPAY Bill

- **Provider:** Xero.
- **File/function/route:** `zakiledger/app/api/approve/bulk/route.ts` `POST` -> `zakiledger/lib/bulk-approve.ts:bulkApprove/approveOne` -> `zakiledger/lib/accounting.ts:postApprovedBill` -> `zakiledger/lib/xero.ts:createXeroDraftBill` -> `POST /Invoices`.
- **Operation type:** CREATE.
- **External financial object:** Xero draft ACCPAY Bill.
- **Client binding:** Authenticated user and user-owned pending document only; no canonical client binding.
- **Ledger-book binding:** None.
- **Provider-connection binding:** User/provider OAuth row and first-captured tenant ID only; no canonical provider connection/client/book validation.
- **Account-selection logic:** None; no account code is supplied.
- **Tax-selection logic:** `Exclusive` line amounts with no selected tax type; extracted tax is not mapped.
- **Evidence required:** Stored extraction, supported currency, fully `ready` confidence gate, itemised-tax arithmetic consistency, and no local duplicate. No account/tax evidence is required; demo-seeded documents can qualify.
- **Approval requirement:** Authenticated bulk selection; no accountant role, canonical permission, posting policy, provider target, account, or tax approval.
- **Idempotency mechanism:** In-request document de-duplication and non-atomic local queue/document guards only; no posting identity, provider idempotency key, or stored InvoiceID.
- **Retry behaviour:** No provider retry; per-item error isolation only.
- **Timeout-after-success behaviour:** No explicit timeout or `UNCERTAIN`. A lost success response leaves an approved local invoice and a resolved/error pending record, without knowing whether the Xero draft exists.
- **External-state verification:** Response-ID parsing only.
- **Audit behaviour:** Generic error reason may be stored for the pending document, but provider tenant/payload/response/InvoiceID and verified outcome are absent from durable audit.
- **Risk:** **UNSAFE**.

## Explicit Legacy and Binding Inspection

| Area | Finding | Effect on external writes |
|---|---|---|
| `extracted_items.posted_to_qb_at` | Defined in `supabase/migrations/001_initial_schema.sql`; no application read or write reference exists. | Dead legacy marker, not an active write path and not an idempotency control. |
| `extracted_items.qb_txn_id` | Defined beside `posted_to_qb_at`; no application read or write reference exists. | Dead legacy marker; active Bill/Invoice IDs are not persisted here or elsewhere. |
| `user_merchant_preferences` | Written by reconciliation approval/preferences flows in `lib/decision-store.ts`. | Internal-only. It does not feed `postApprovedBill`, QuickBooks account selection, or Xero line account codes. |
| `merchant_ai_categories` | Global internal AI category cache in `lib/merchant-ai-cache.ts`. | Internal-only. Its fixed category enum does not bind to a provider chart-of-accounts and is not consumed by posting. |
| `oauth_connections` | Active credential store keyed only by `(user_id, provider)`, with `org_id` for realm/tenant. | It is the sole provider binding for all six paths and is not connected to canonical `client_entities`, `ledger_books`, or `provider_connections`. |
| Canonical `provider_connections` / `ledger_books` / `financial_accounts` | Defined in migration 010 and enforced in canonical ingestion procedures. | Completely bypassed by the posting routes and provider clients. |
| Reconciliation approval/match/reject/unapprove routes | Mutate only Zaki's database and audit records. | No QuickBooks/Xero financial mutation. Matching is not posting. |
| `qb_transactions` sync/upload and nightly matcher | Provider API activity is read-only for purchases/bank transactions, followed by internal DB ingestion/matching. | No provider financial write. |

## Provider Control-Plane Side Effects (Excluded From Financial Count)

These calls alter credentials or local connection state, not a client's accounting objects:

- QuickBooks and Xero OAuth callbacks exchange authorization codes with provider token endpoints and upsert `oauth_connections`.
- `getValidQboAccess` and `getValidXeroAccess` can refresh tokens and update `oauth_connections`; consequently nominally read-only status, sync, on-demand, and nightly flows can rotate provider credentials.
- Xero may recover a missing tenant ID via `/connections` and update the local `org_id`.
- Disconnect routes delete only the local `oauth_connections` row; they do not call a provider revocation/disconnect endpoint.

They are not counted among the six financial write paths because they create/update no Vendor, Bill, Invoice, Purchase, Payment, Journal, Transfer, account, or tax object.

## Workers and Background Jobs

- `zakiledger/lib/nightly-match.ts:runNightlyMatch` and `zakiledger/scripts/nightly-match.ts:main` read QuickBooks Purchases and Xero BankTransactions, then write only Zaki's internal reconciliation tables.
- `/api/reconciliation/on-demand` and `/api/reconciliation/qb-transactions/sync` do the same on demand.
- No worker, cron entry, webhook handler, queue consumer, or background job calls `postApprovedBill`, `createQuickBooksBill`, `createXeroDraftBill`, or an external mutation endpoint.
- No provider webhook route exists in the current API route tree.

## Independent Hidden/Direct-Write Search

A second search was performed independently of the first symbol/call-graph pass:

1. Scanned all non-dependency source and scripts for outbound HTTP calls, provider hostnames, write methods, SDK-style create/update/delete/void methods, and accounting object names.
2. Enumerated all 39 compiled server API routes and searched ignored `.next/server` output directly. The sole provider-host chunk, `.next/server/chunks/4984.js`, contains the same QuickBooks Vendor/Bill and Xero Invoice implementations; no extra/stale provider route was found.
3. Searched every local and remote Git ref for provider endpoints, posting method names, and the legacy QuickBooks marker columns. Other refs contain the same three primitives or no provider writer.
4. Inspected both package manifests and lockfile dependency declarations. There is no QuickBooks, Xero, Sage, Stripe, Plaid, payment, banking, or generic accounting provider SDK; provider access uses native `fetch` in `lib/quickbooks.ts` and `lib/xero.ts`.
5. Searched SQL migrations, scripts, repair assets, and application database calls. They mutate only Zaki/Postgres state; none issues an external accounting request.
6. Searched for create, update, delete, void, bills, invoices, purchases, expenses, payments, journals, transfers, account/tax selectors, webhooks, workers, retries, and direct Authorization-bearing provider calls.

Result: **no omitted current external financial write path found**. No external update, void, delete, payment, journal, transfer, purchase/expense, account, tax-code, or webhook-triggered mutation implementation exists.

## Highest-Risk Findings

1. **No tenant/client/book boundary:** every path binds only an authenticated user to one OAuth row per provider and bypasses the canonical client, ledger-book, provider-connection, and financial-account model.
2. **No idempotency or uncertain-outcome protocol:** external IDs are not persisted, provider state is not verified, timeouts are not bounded, and a success with a lost response becomes a generic failure rather than `UNCERTAIN`.
3. **Unsafe accounting treatment:** QuickBooks silently chooses the first Expense account and ignores tax and currency; Xero supplies no account code or tax type and does not map extracted tax.
4. **Approval is not a posting authorization boundary:** the single route accepts caller-supplied extraction/confidence, can omit source `documentId`, permits duplicate override without posting audit, and performs no canonical role/policy check.
5. **Hidden compound mutation:** QuickBooks bill approval may create a Vendor before Bill creation; a later failure can leave an unaudited orphan Vendor.
6. **No durable posting audit:** provider IDs, targets, request identity, payload, chosen account/tax, responses, and outcome verification are absent. The legacy posted markers are unused.
7. **Synthetic evidence can reach a live connection:** `/api/pending/demo` can seed fixture documents whenever `ANTHROPIC_API_KEY` is absent; subsequent bulk approval uses the ordinary posting path.

## Day 1 Exit Check

- All external financial write paths inventoried: **YES**
- Independent hidden-write search complete: **YES**
- Risk classification complete: **YES**
- Implementation performed: **NO**
- Production/provider access performed: **NO**
- Blocker: **None**
