# AI Merchant-Category Fallback — Design

**Source:** `improvements.md` note 1 — "hardcoded UK merchant database (fast, free) +
fallback to [AI] for unknown merchants." Explicitly deferred by Group B's plan doc
(`docs/superpowers/plans/2026-08-01-group-b-decision-automation.md`, Global Constraints:
"No calls to external AI APIs for categorisation... the GPT fallback belongs to a later
phase"). That phase is now.

## Context

`lib/merchant-categories.ts`'s `suggestMerchantCategory(name)` is a hardcoded UK-merchant
regex table; it returns `null` for anything it doesn't recognise. `lib/reconciliation-insights.ts`'s
`suggestCategory(...)` resolves a transaction's category through a chain — learned
`MerchantPreference` (3+ approvals) → matched QB account name → statement-local majority →
`suggestMerchantCategory`'s hardcoded table → `"Uncategorised"` — and both functions are
deliberately pure and synchronous: `buildReviewRows` runs entirely in memory, no I/O, so the
review board's render path never depends on network latency.

`@anthropic-ai/sdk` is **already a runtime dependency** (`lib/anthropic.ts` uses it for
invoice/receipt/bank-statement extraction with `claude-opus-4-8` via
`client.messages.parse` + `zodOutputFormat` structured output). Group B's "no new runtime
dependencies" constraint does not block this feature — no new package is needed.

**Model:** `claude-sonnet-5` (not the extraction pipeline's `claude-opus-4-8`, and not
GPT/OpenAI despite `.env.example` having an `OPENAI_API_KEY` slot). Chosen for reasoning
quality — the model should explain *why* a merchant fits a category, not just emit a bare
label, which Haiku 4.5 would do more cheaply but without the explanation.

## Non-goals

- Not touching `suggestMerchantCategory` or the hardcoded table itself.
- Not making `suggestCategory`/`buildReviewRows` async. They stay pure, synchronous,
  no I/O — same contract as today.
- Not classifying every unmatched transaction — only distinct merchant names that would
  otherwise land on `"Uncategorised"`, and only once per merchant ever (cached
  permanently, not per-session).
- Not auto-seeding `MerchantPreference` from an AI guess. Learning still only happens
  through the existing approve-route flow, which already requires a human to click
  Approve/Accept with the category showing.

## Architecture

Four new pieces, one extended function.

### 1. `lib/merchant-ai.ts` — Anthropic wrapper

```typescript
export interface MerchantAiCategory {
  category: string;      // one of GL_CATEGORIES
  confidencePct: number; // 0-100
  reason: string;        // one sentence, accountant-facing
}

export async function classifyMerchant(name: string): Promise<MerchantAiCategory | null>
```

- Own `new Anthropic()` client instance (module-scoped, mirrors `lib/anthropic.ts` — that
  module doesn't export its client, so this module owns its own rather than reaching into
  another module's internals).
- `model: "claude-sonnet-5"`, `client.messages.parse` + `zodOutputFormat`, structured
  output schema: `z.object({ category: z.enum(GL_CATEGORIES as [string, ...string[]]), confidencePct: z.number().min(0).max(100), reason: z.string().min(1) })`
  (imported from `"zod/v4"`, matching every other Zod schema this codebase feeds to
  `zodOutputFormat`). Constraining `category` to the enum means the model physically
  cannot return a category the UI/dropdown doesn't know about.
- System prompt: short, UK-accounting context, lists `GL_CATEGORIES`, asks for the
  single best-fit category, a 0-100 confidence, and a one-sentence reason referencing
  what about the merchant name suggests that category. No `thinking` param — this is a
  short classification call, not a multi-page extraction.
- `max_tokens`: small (~300) — one category + one sentence.
- Every failure path (missing/invalid API key, network error, rate limit, malformed
  response, `!response.parsed_output`) is caught inside this function, logged via
  `console.warn(\`merchant classification failed for "${name}": ${message}\`)`, and
  returns `null`. **This function never throws.** It is the single seam the test suite
  mocks — nothing above it needs to know Anthropic exists.
- If the model itself returns `category: "Uncategorised"` (genuinely can't tell), that's
  a valid, non-null response — treated as "classified, but no better than what we had"
  by the caching layer (cached so we don't ask again) and by `suggestCategory` (falls
  through to the same `"Uncategorised"` result, no special AI label).

### 2. `merchant_ai_categories` table + `lib/merchant-ai-cache.ts`

**Global cache — no `user_id`.** `GL_CATEGORIES` is a fixed shared enum, not a per-user
chart of accounts, so one user's classification of "STRIPE PAYOUT" is equally correct for
every other user. Keying by `user_id` too would mean every user pays the classification
cost for every common merchant on their first encounter; a global cache means the second
user (of any tenant) to see a given merchant gets an instant, free hit.

```sql
-- Global cache (no user_id): merchant name -> AI-classified GL category. GL_CATEGORIES
-- is a fixed shared enum, not a per-user chart of accounts, so one user's classification
-- benefits everyone -- fewer Anthropic calls, faster cache warm-up.
create table if not exists merchant_ai_categories (
  merchant_name   text primary key,     -- normalised: trimmed, lowercased
  category        text not null,
  confidence_pct  int not null,
  reason          text not null,
  created_at      timestamptz not null default now()
);
```

Store module follows `lib/decision-store.ts`'s Supabase-or-`globalThis` pattern exactly:

```typescript
export async function getCachedCategories(names: string[]): Promise<Map<string, MerchantAiCategory>>
export async function cacheCategory(merchantName: string, result: MerchantAiCategory): Promise<void>
export function __clearMerchantAiCacheForTests(): void
```

`getCachedCategories` normalises + dedupes input, bulk-reads (`.in("merchant_name", keys)`
on Supabase, `.filter` on the in-memory array), returns a `Map` keyed by normalised name —
missing entries simply aren't in the map (no `null` placeholders). `cacheCategory` inserts
one row; on Supabase, a duplicate-key error (two concurrent `classify-merchants` requests
racing on the same never-before-seen merchant) is swallowed, not thrown — the cache
already has an equally-valid entry, which is a fine outcome for a cache.

### 3. `POST /api/reconciliation/classify-merchants`

Auth-gated (`requireUser`, matching every other reconciliation route). Body:
`{ merchantNames: string[] }`.

1. Normalise + dedupe `merchantNames`; cap to the first 50 (defensive — a statement's
   distinct unknown-merchant count is realistically single digits to low tens; this
   bounds worst-case cost per request without needing real pagination).
2. `getCachedCategories(keys)` → cache hits.
3. Misses → `Promise.all(misses.map(name => classifyMerchant(name)))`. Safe as `Promise.all`
   despite one merchant failing, because `classifyMerchant` never rejects.
4. For every non-null result, `cacheCategory(name, result)` (fire in parallel, same
   `Promise.all` safety — Supabase/in-memory writes here don't throw in ways that should
   abort the request; wrap in `try/catch` + `console.warn` regardless, since a cache-write
   failure must never prevent returning the classification result to the caller).
5. Response: `{ categories: Record<string, MerchantAiCategory> }` — merged cache hits +
   new successes, keyed by normalised merchant name. Merchants whose classification
   failed are simply absent — the client already treats "no entry for this merchant" as
   "stays Uncategorised," so no separate error signalling is needed.
6. The whole handler is wrapped so that even a total Anthropic/DB outage returns `200`
   with `{ categories: {} }` rather than a 500 — same "never break the caller" contract
   `extract-batch`'s per-file isolation already established in this codebase.

### 4. Review page trigger (`app/(app)/reconciliation/review/page.tsx`)

Progressive enhancement, added *after* today's render path — never blocks it.

- New state: `const [aiCategories, setAiCategories] = useState<Map<string, MerchantAiCategory>>(new Map())`.
- New `useEffect`, keyed off `board`: once `board` is computed, collect the distinct
  `bank.merchant ?? bank.description` values (normalised) among rows whose current
  `categoryLabel === "Uncategorised"` and that aren't already present in `aiCategories`.
  If the list is non-empty, `POST /api/reconciliation/classify-merchants` with those
  names; on success, merge the response into `aiCategories` state (triggering a
  `board` recompute, since `aiCategories` becomes a `buildReviewRows` input alongside
  `preferences`). On fetch failure, swallow it — rows simply stay `"Uncategorised"`,
  identical to today's behaviour.
- This fetch fires once per newly-seen batch of unknown merchants per statement load —
  not per row, not per render (the "already in `aiCategories`" check prevents re-fetching
  merchants already resolved in this session; the server-side cache prevents re-asking
  Anthropic across sessions/users).

### 5. `suggestCategory` — new resolution tier

Signature changes from returning `string` to returning `{ label: string; reason?: string }`
(three direct call sites: `buildReviewRows` and two assertions in
`tests/reconciliation-insights.test.ts` — each updated to read `.label`).

New optional parameter: `aiCategories?: Map<string, MerchantAiCategory>` (keyed by
normalised merchant name, built once per `buildReviewRows` call the same way
`preferencesByMerchant` already is).

Resolution order (unchanged prefix, one new tier before the terminal fallback):

1. Learned `MerchantPreference` (3+ approvals) — unchanged.
2. Matched QB account name — unchanged.
3. Statement-local majority — unchanged.
4. Hardcoded table (`suggestMerchantCategory`) — unchanged.
5. **AI cache** — `aiCategories?.get(key)`; if present *and* `category !== "Uncategorised"`,
   `{ label: \`${category} (${confidencePct}% AI suggested)\`, reason }`.
6. `{ label: "Uncategorised" }` — terminal fallback, unchanged.

Label format deliberately differs from the hardcoded table's `` `${category} (${confidencePct}% suggested)` ``
by the word "AI" — the one piece of UI text that tells an accountant this suggestion came
from a live model call, not a fixed rulebook, so they know to read the `reason` before
trusting it on anything unusual.

### 6. `ReviewRow` — new optional field

```typescript
categoryReason?: string;
```

Set by `buildReviewRows` only when tier 5 (AI) produced the row's category. Rendered in
`ReconciliationPanelBody` (review/page.tsx), directly under the existing "Suggested
category" `<select>` (`app/(app)/reconciliation/review/page.tsx` ~line 638), as small
italic text — present only when `row.categoryReason` is set, absent for every other tier
(hardcoded/learned/QB/majority rows render exactly as today, zero visual change).

### 7. Learning — no changes needed

An AI-tier category becomes the row's `categoryLabel` exactly like a hardcoded-tier one.
It only ever reaches `bumpMerchantPreference` through the existing approve-route flow
(`app/api/reconciliation/[id]/approve/route.ts`), which already requires a human to click
Approve/Accept with that category displayed. A wrong AI guess is subject to the same human
gate a wrong hardcoded guess already is — no new special-casing, no risk of an
unreviewed AI label silently seeding a "learned" preference.

## Error handling summary

| Failure point | Behaviour |
|---|---|
| `ANTHROPIC_API_KEY` unset/invalid | `classifyMerchant` catches, logs, returns `null` |
| Anthropic down/rate-limited | same — `null`, logged, not thrown |
| Model returns unparseable/off-schema output | same — `zodOutputFormat` + `!parsed_output` check, `null` |
| Cache DB read/write fails | `getCachedCategories` throwing propagates to the route handler, which catches broadly and returns `{ categories: {} }`; `cacheCategory` failures are caught+logged inline, never block the response |
| `classify-merchants` endpoint fully unreachable (client fetch fails) | swallowed in the review page's `useEffect`; rows stay `"Uncategorised"` |

At every layer, the worst case is identical to today's behaviour before this feature
existed: an unmatched merchant shows `"Uncategorised"`. Nothing about this feature can
make the review screen slower to first paint or less available than it is today.

## Testing strategy

All new tests live in `zakiledger/tests/`, run under `npm run test` (Vitest), zero real
network calls:

- **`tests/merchant-ai.test.ts`** — mocks the Anthropic SDK client (`vi.mock("@anthropic-ai/sdk", ...)`,
  `vi.hoisted` pattern as in `tests/extract-batch-failure.test.ts`) to cover: happy path
  (valid structured response → `MerchantAiCategory`), thrown error → `null` + no throw,
  `parsed_output` missing → `null` + no throw.
- **`tests/merchant-ai-cache.test.ts`** — mirrors `tests/decision-store.test.ts`'s
  in-memory setup/teardown (`beforeEach(() => __clearMerchantAiCacheForTests())`):
  write-then-read round trip, cache miss returns nothing for that key, bulk read across
  mixed hit/miss names.
- **`tests/classify-merchants.test.ts`** — mocks `@/lib/merchant-ai`'s `classifyMerchant`
  (same hoisted-mock pattern), covering: all-cache-hit (no `classifyMerchant` calls made),
  mixed hit/miss (only misses call the mock), one merchant's classification fails →
  others still returned, total mock failure → `200` with `{ categories: {} }` not a 500,
  unauthenticated → 401 (mirroring the auth pattern already used by
  `tests/*` for other reconciliation routes).
- **`tests/reconciliation-insights.test.ts`** extensions — `suggestCategory`'s new tier:
  AI cache hit below the hardcoded table in priority (hardcoded wins when both exist),
  AI cache hit used when hardcoded table returns `null`, AI category `"Uncategorised"`
  falls through to the bare terminal fallback (no `"(AI suggested)"` label on a
  non-answer), and `buildReviewRows` sets `categoryReason` only on AI-tier rows.

## Files

**New:**
- `zakiledger/lib/merchant-ai.ts`
- `zakiledger/lib/merchant-ai-cache.ts`
- `zakiledger/app/api/reconciliation/classify-merchants/route.ts`
- `zakiledger/tests/merchant-ai.test.ts`
- `zakiledger/tests/merchant-ai-cache.test.ts`
- `zakiledger/tests/classify-merchants.test.ts`

**Modified:**
- `zakiledger/db/schema.sql` (append `merchant_ai_categories` table)
- `zakiledger/lib/reconciliation-insights.ts` (`suggestCategory` new tier + return shape,
  `buildReviewRows` threads `aiCategories` + sets `categoryReason`)
- `zakiledger/components/review/ReviewBoard.tsx` (`ReviewRow.categoryReason?: string`)
- `zakiledger/app/(app)/reconciliation/review/page.tsx` (`aiCategories` state + fetch
  effect + `categoryReason` rendering)
- `zakiledger/tests/reconciliation-insights.test.ts` (existing `suggestCategory` call
  sites updated to `.label`; new AI-tier cases)

## Self-review

- No placeholders/TBDs.
- Internally consistent: the "never block render" requirement (context) is enforced by
  the trigger design (§4: fires after `board` exists) and the error-handling table
  covers every failure surface named in the original brief (down/rate-limited/
  misconfigured key never breaks the review screen; falls through to Uncategorised,
  logged not thrown).
- Scope: one cohesive feature, one implementation plan. Not decomposed further.
- Ambiguity resolved: cache scope (global), trigger mechanism (client-side, post-render),
  and reason-surfacing (yes, in the panel) were each confirmed with the user directly
  before this was written — see the three-question exchange preceding this doc.
