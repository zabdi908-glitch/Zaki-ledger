# AI Merchant-Category Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `lib/reconciliation-insights.ts`'s `suggestCategory` a live-AI fallback tier
(Claude Sonnet 5, cached, never blocking) for merchants the hardcoded UK table
(`lib/merchant-categories.ts`) doesn't recognise, per `improvements.md` note 1.

**Architecture:** A pure Anthropic wrapper (`lib/merchant-ai.ts`) that never throws; a
global cache table + store (`merchant_ai_categories`, `lib/merchant-ai-cache.ts`) so no
merchant is ever classified twice; an auth-gated endpoint
(`POST /api/reconciliation/classify-merchants`) that checks the cache before calling
Anthropic; and a client-side effect in the review page that fetches classifications
*after* the board has already rendered, so Anthropic's latency/availability never touches
first paint. `suggestCategory`/`buildReviewRows` stay pure and synchronous — they only
ever read an already-fetched `Map`, exactly like they already do for `MerchantPreference`.

**Tech Stack:** Next.js 15, TypeScript, `@anthropic-ai/sdk` (already a dependency — see
`lib/anthropic.ts`), Zod v4 (`zod/v4` import) + `zodOutputFormat` for structured output,
Supabase, Vitest.

**Design doc:** `docs/superpowers/specs/2026-08-02-ai-merchant-fallback-design.md`

## Global Constraints

- All work happens inside `zakiledger/`. Run `npm run check` before every commit.
- Model is `claude-sonnet-5` (not `claude-opus-4-8`, which the extraction pipeline uses;
  not OpenAI/GPT). Picked for reasoning quality, not just a bare label.
- `@anthropic-ai/sdk` is already a dependency — do not add a new package for this.
- `classifyMerchant` (the one Anthropic call site) must never throw — every failure is
  caught, logged via `console.warn`, and reported as `null`.
- The AI cache is global (no `user_id`) — `GL_CATEGORIES` is a fixed shared enum, not a
  per-user chart of accounts.
- `suggestCategory`/`buildReviewRows` stay synchronous and I/O-free. All async work
  (Anthropic calls, cache reads/writes) happens in the route handler and the review page's
  effect, never inside these functions.
- Copy is accountant-friendly British English ("Uncategorised").
- SQL follows `zakiledger/db/schema.sql` conventions: lowercase, `create table if not
  exists`, append at the end of the file, followed by `notify pgrst, 'reload schema';`.
- Store modules follow the `lib/decision-store.ts` pattern: Supabase when configured via
  `getSupabase()` from `lib/supabase.ts`, else in-memory arrays on `globalThis`, with a
  `__clear*ForTests()` export.

---

### Task 1: Anthropic classification wrapper

**Files:**
- Create: `zakiledger/lib/merchant-ai.ts`
- Test: `zakiledger/tests/merchant-ai.test.ts`

**Interfaces:**
- Produces: `export interface MerchantAiCategory { category: string; confidencePct: number; reason: string }`
  and `export async function classifyMerchant(name: string): Promise<MerchantAiCategory | null>`.
  Tasks 2, 3, 4 consume both.

- [ ] **Step 1: Write the failing tests**

```typescript
// zakiledger/tests/merchant-ai.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const anthropicMock = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse: anthropicMock.parse };
  },
}));

const { classifyMerchant } = await import("@/lib/merchant-ai");

beforeEach(() => {
  anthropicMock.parse.mockReset();
});

describe("classifyMerchant", () => {
  it("returns the parsed classification on a clean response", async () => {
    anthropicMock.parse.mockResolvedValueOnce({
      parsed_output: {
        category: "Software & SaaS",
        confidencePct: 88,
        reason: "Recurring SaaS-style billing name.",
      },
    });
    const result = await classifyMerchant("ACME CLOUD TOOLS LTD");
    expect(result).toEqual({
      category: "Software & SaaS",
      confidencePct: 88,
      reason: "Recurring SaaS-style billing name.",
    });
  });

  it("returns null, not a throw, when the API call fails", async () => {
    anthropicMock.parse.mockRejectedValueOnce(new Error("rate limited"));
    await expect(classifyMerchant("ACME CLOUD TOOLS LTD")).resolves.toBeNull();
  });

  it("returns null when the model gives no parsed output", async () => {
    anthropicMock.parse.mockResolvedValueOnce({ parsed_output: undefined });
    await expect(classifyMerchant("ACME CLOUD TOOLS LTD")).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `zakiledger/`): `npm run test -- merchant-ai` → FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// zakiledger/lib/merchant-ai.ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { GL_CATEGORIES } from "./merchant-categories";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

/** claude-sonnet-5 — picked over Haiku 4.5 for reasoning quality: this is the
 * one place the model has to explain *why* a merchant fits a category, not
 * just emit a bare label. */
const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You classify UK bank-statement merchant names into a fixed
general-ledger category list for an accounting reconciliation tool, and briefly explain
why.

Rules:
- Pick exactly one category from the allowed list below. Never invent a category.
- The reason is one sentence, written for an accountant, naming what about the merchant
  name suggests that category (the business type, a known brand, a payment pattern).
- Be conservative with confidence: a well-known brand with an obvious category (e.g. a
  petrol station chain) should score 85-99. A generic or ambiguous name should score well
  below that, even if you still have to pick a best-guess category.
- If the name gives you nothing to go on, pick "Uncategorised" and say so plainly in the
  reason rather than guessing at a specific category.

Allowed categories: ${GL_CATEGORIES.join(", ")}`;

const MerchantCategorySchema = z.object({
  category: z.enum(GL_CATEGORIES as [string, ...string[]]),
  confidencePct: z.number().min(0).max(100),
  reason: z.string().min(1),
});

export interface MerchantAiCategory {
  category: string;
  confidencePct: number;
  reason: string;
}

/**
 * Classify one merchant name via a live Claude call — the AI fallback for
 * merchants the hardcoded table (lib/merchant-categories.ts) doesn't recognise.
 * Never throws: any failure (missing/invalid API key, network, rate limit, an
 * unparseable response) is caught, logged, and reported as `null` so callers
 * can fall through to "Uncategorised" exactly as they would have before this
 * function existed.
 */
export async function classifyMerchant(name: string): Promise<MerchantAiCategory | null> {
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Classify this bank-statement merchant name: "${name}"` }],
      output_config: { format: zodOutputFormat(MerchantCategorySchema) },
    });
    if (!response.parsed_output) {
      console.warn(`merchant classification returned no parsed output for "${name}"`);
      return null;
    }
    return response.parsed_output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`merchant classification failed for "${name}": ${message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run tests** → `npm run test -- merchant-ai` → PASS.

- [ ] **Step 5: Commit**

```bash
git add zakiledger/lib/merchant-ai.ts zakiledger/tests/merchant-ai.test.ts
git commit -m "feat: Claude Sonnet 5 merchant-category classification wrapper"
```

---

### Task 2: Global AI-category cache

**Files:**
- Modify: `zakiledger/db/schema.sql` (append at the end)
- Create: `zakiledger/lib/merchant-ai-cache.ts`
- Test: `zakiledger/tests/merchant-ai-cache.test.ts`

**Interfaces:**
- Consumes: `MerchantAiCategory` (Task 1).
- Produces: `getCachedCategories(names: string[]): Promise<Map<string, MerchantAiCategory>>`,
  `cacheCategory(merchantName: string, result: MerchantAiCategory): Promise<void>`,
  `__clearMerchantAiCacheForTests(): void`. Task 3 consumes all three.

- [ ] **Step 1: Append SQL to `db/schema.sql`**

```sql
-- ============================= AI merchant-category fallback =============================
-- Global cache (not scoped to user_id): merchant name -> AI-classified GL
-- category. GL_CATEGORIES is a fixed shared enum, not a per-user chart of
-- accounts, so one user's classification of a merchant benefits everyone --
-- fewer Anthropic calls, faster cache warm-up.

create table if not exists merchant_ai_categories (
  merchant_name   text primary key,     -- normalised: trimmed, lowercased
  category        text not null,
  confidence_pct  int not null,
  reason          text not null,
  created_at      timestamptz not null default now()
);

-- Sixth reload: covers the AI merchant-category cache table above.
notify pgrst, 'reload schema';
```

- [ ] **Step 2: Write failing store tests**

The in-memory fallback is what the tests exercise (no Supabase in CI) — same setup
pattern as `tests/decision-store.test.ts`.

```typescript
// zakiledger/tests/merchant-ai-cache.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { __clearMerchantAiCacheForTests, cacheCategory, getCachedCategories } from "../lib/merchant-ai-cache";

beforeEach(() => __clearMerchantAiCacheForTests());

describe("merchant AI cache", () => {
  it("returns nothing for a merchant that hasn't been cached", async () => {
    const result = await getCachedCategories(["Totally Unknown Ltd"]);
    expect(result.size).toBe(0);
  });

  it("writes then reads back, normalising the merchant name", async () => {
    await cacheCategory("  Acme Cloud Tools LTD  ", {
      category: "Software & SaaS",
      confidencePct: 88,
      reason: "Recurring SaaS billing name.",
    });
    const result = await getCachedCategories(["acme cloud tools ltd"]);
    expect(result.get("acme cloud tools ltd")).toEqual({
      category: "Software & SaaS",
      confidencePct: 88,
      reason: "Recurring SaaS billing name.",
    });
  });

  it("bulk-reads a mix of cached and uncached names, returning only the cached ones", async () => {
    await cacheCategory("Known Merchant", { category: "Office Supplies", confidencePct: 70, reason: "Generic supplier name." });
    const result = await getCachedCategories(["Known Merchant", "Unknown Merchant"]);
    expect(result.size).toBe(1);
    expect(result.has("known merchant")).toBe(true);
    expect(result.has("unknown merchant")).toBe(false);
  });

  it("does not throw when the same merchant is cached twice", async () => {
    await cacheCategory("Repeat Merchant", { category: "Meals", confidencePct: 60, reason: "Cafe-style name." });
    await expect(
      cacheCategory("Repeat Merchant", { category: "Meals", confidencePct: 60, reason: "Cafe-style name." }),
    ).resolves.not.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure** → `npm run test -- merchant-ai-cache` → FAIL.

- [ ] **Step 4: Implement the store**

```typescript
// zakiledger/lib/merchant-ai-cache.ts
import { getSupabase } from "./supabase";
import type { MerchantAiCategory } from "./merchant-ai";

/**
 * Global cache for AI-classified merchant categories (Anthropic fallback, see
 * lib/merchant-ai.ts). Deliberately not scoped to user_id — GL_CATEGORIES is
 * a fixed shared enum, not a per-user chart of accounts, so every user
 * benefits from a merchant classified once by anyone. Follows the same
 * Supabase-or-in-memory pattern as lib/decision-store.ts.
 */

interface MemEntry extends MerchantAiCategory {
  merchantName: string;
}

const globalForMerchantAi = globalThis as unknown as {
  __zakiLedgerMerchantAiCache?: MemEntry[];
};
const mem = (globalForMerchantAi.__zakiLedgerMerchantAiCache ??= []);

export function __clearMerchantAiCacheForTests(): void {
  mem.length = 0;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export async function getCachedCategories(names: string[]): Promise<Map<string, MerchantAiCategory>> {
  const keys = [...new Set(names.map(normalize).filter(Boolean))];
  const result = new Map<string, MerchantAiCategory>();
  if (keys.length === 0) return result;

  const db = getSupabase();
  if (!db) {
    for (const entry of mem) {
      if (keys.includes(entry.merchantName)) {
        result.set(entry.merchantName, { category: entry.category, confidencePct: entry.confidencePct, reason: entry.reason });
      }
    }
    return result;
  }

  const { data, error } = await db.from("merchant_ai_categories").select().in("merchant_name", keys);
  if (error) throw new Error(`Failed to load AI merchant cache: ${error.message}`);
  for (const row of data ?? []) {
    result.set(row.merchant_name as string, {
      category: row.category as string,
      confidencePct: Number(row.confidence_pct ?? 0),
      reason: row.reason as string,
    });
  }
  return result;
}

export async function cacheCategory(merchantName: string, result: MerchantAiCategory): Promise<void> {
  const key = normalize(merchantName);
  if (!key) return;

  const db = getSupabase();
  if (!db) {
    if (!mem.some((e) => e.merchantName === key)) mem.push({ merchantName: key, ...result });
    return;
  }

  const { error } = await db.from("merchant_ai_categories").insert({
    merchant_name: key,
    category: result.category,
    confidence_pct: result.confidencePct,
    reason: result.reason,
  });
  // A concurrent classify-merchants request may have already cached this
  // merchant between our read and this write; the primary key turns that
  // race into a harmless duplicate-key error, not a real failure.
  if (error && !/duplicate key/i.test(error.message)) {
    throw new Error(`Failed to cache AI merchant category: ${error.message}`);
  }
}
```

- [ ] **Step 5: Run tests** → PASS. Then `npm run check` → PASS.

- [ ] **Step 6: Commit**

```bash
git add zakiledger/lib/merchant-ai-cache.ts zakiledger/tests/merchant-ai-cache.test.ts zakiledger/db/schema.sql
git commit -m "feat: global cache for AI-classified merchant categories"
```

---

### Task 3: Classification endpoint

**Files:**
- Create: `zakiledger/app/api/reconciliation/classify-merchants/route.ts`
- Test: `zakiledger/tests/classify-merchants.test.ts`

**Interfaces:**
- Consumes: `classifyMerchant` (Task 1), `getCachedCategories`/`cacheCategory` (Task 2),
  `requireUser` (existing, `lib/auth.ts`).
- Produces: `POST /api/reconciliation/classify-merchants` — body `{ merchantNames: string[] }`
  → `{ categories: Record<string, MerchantAiCategory> }` keyed by normalised merchant
  name. Task 5 (review page) consumes this.

- [ ] **Step 1: Write failing route tests**

Mocks `@/lib/merchant-ai`'s `classifyMerchant` (same `vi.hoisted` pattern as
`tests/extract-batch-failure.test.ts`) and `@/lib/auth` (same pattern as
`tests/bulk-approve.test.ts`), so no real Anthropic/Supabase call happens.

```typescript
// zakiledger/tests/classify-merchants.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const merchantAi = vi.hoisted(() => ({ classify: vi.fn() }));

vi.mock("@/lib/merchant-ai", () => ({
  classifyMerchant: merchantAi.classify,
}));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "test-user" }),
}));

const { POST: classifyRoute } = await import("@/app/api/reconciliation/classify-merchants/route");
const { __clearMerchantAiCacheForTests } = await import("@/lib/merchant-ai-cache");

beforeEach(() => {
  __clearMerchantAiCacheForTests();
  merchantAi.classify.mockReset();
});

async function classify(merchantNames: string[]) {
  const req = new Request("http://test/api/reconciliation/classify-merchants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchantNames }),
  });
  const res = await classifyRoute(req as unknown as NextRequest);
  return { status: res.status, body: (await res.json()) as { categories: Record<string, unknown> } };
}

describe("POST /api/reconciliation/classify-merchants", () => {
  it("classifies a new merchant and returns it", async () => {
    merchantAi.classify.mockResolvedValueOnce({ category: "Software & SaaS", confidencePct: 88, reason: "Recurring SaaS billing name." });
    const { status, body } = await classify(["Acme Cloud Tools"]);
    expect(status).toBe(200);
    expect(body.categories["acme cloud tools"]).toEqual({ category: "Software & SaaS", confidencePct: 88, reason: "Recurring SaaS billing name." });
    expect(merchantAi.classify).toHaveBeenCalledTimes(1);
  });

  it("never re-classifies a merchant already cached", async () => {
    merchantAi.classify.mockResolvedValueOnce({ category: "Meals", confidencePct: 70, reason: "Cafe-style name." });
    await classify(["Repeat Cafe"]);
    merchantAi.classify.mockClear();
    const { body } = await classify(["Repeat Cafe"]);
    expect(body.categories["repeat cafe"]).toEqual({ category: "Meals", confidencePct: 70, reason: "Cafe-style name." });
    expect(merchantAi.classify).not.toHaveBeenCalled();
  });

  it("omits a merchant whose classification fails, without failing the request", async () => {
    merchantAi.classify.mockResolvedValueOnce(null);
    const { status, body } = await classify(["Unclassifiable Ltd"]);
    expect(status).toBe(200);
    expect(body.categories["unclassifiable ltd"]).toBeUndefined();
  });

  it("returns the successful one and omits the failed one in a mixed batch", async () => {
    merchantAi.classify
      .mockResolvedValueOnce({ category: "Travel", confidencePct: 91, reason: "Named taxi operator." })
      .mockResolvedValueOnce(null);
    const { body } = await classify(["Good Cabs", "Bad Merchant"]);
    expect(body.categories["good cabs"]).toBeTruthy();
    expect(body.categories["bad merchant"]).toBeUndefined();
  });

  it("returns empty categories for an empty merchant list, without calling the classifier", async () => {
    const { status, body } = await classify([]);
    expect(status).toBe(200);
    expect(body.categories).toEqual({});
    expect(merchantAi.classify).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const req = new Request("http://test/api/reconciliation/classify-merchants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchantNames: "not-an-array" }),
    });
    const res = await classifyRoute(req as unknown as NextRequest);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure** → `npm run test -- classify-merchants` → FAIL.

- [ ] **Step 3: Implement the route**

```typescript
// zakiledger/app/api/reconciliation/classify-merchants/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { classifyMerchant, type MerchantAiCategory } from "@/lib/merchant-ai";
import { cacheCategory, getCachedCategories } from "@/lib/merchant-ai-cache";
import { z } from "zod/v4";

const BodySchema = z.object({
  merchantNames: z.array(z.string()).max(50),
});

/**
 * POST /api/reconciliation/classify-merchants { merchantNames } ->
 * { categories: Record<string, MerchantAiCategory> }
 *
 * The AI fallback tier for lib/reconciliation-insights.ts's suggestCategory:
 * classifies merchants the hardcoded table (lib/merchant-categories.ts)
 * doesn't recognise, via a global cache (lib/merchant-ai-cache.ts) so no
 * merchant is ever classified by Anthropic more than once. Beyond request
 * validation, this always returns 200 — a merchant that fails to classify
 * (Anthropic down, rate-limited, misconfigured key) is simply absent from
 * the response, and the caller already treats "no entry" as "stays
 * Uncategorised."
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let names: string[];
  try {
    const body = BodySchema.parse(await req.json());
    names = [...new Set(body.merchantNames.map((n) => n.trim()).filter(Boolean))];
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (names.length === 0) return NextResponse.json({ categories: {} });

  try {
    const cached = await getCachedCategories(names);
    const misses = names.filter((n) => !cached.has(n.toLowerCase()));

    const classified = await Promise.all(
      misses.map(async (name) => ({ name, result: await classifyMerchant(name) })),
    );

    const categories: Record<string, MerchantAiCategory> = {};
    for (const [key, value] of cached) categories[key] = value;

    for (const { name, result } of classified) {
      if (!result) continue;
      categories[name.toLowerCase()] = result;
      try {
        await cacheCategory(name, result);
      } catch (err) {
        console.warn(`failed to cache AI category for "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return NextResponse.json({ categories });
  } catch (err) {
    console.warn(`classify-merchants failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ categories: {} });
  }
}
```

- [ ] **Step 4: Run tests** → `npm run test -- classify-merchants` → PASS. Then `npm run check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add zakiledger/app/api/reconciliation/classify-merchants/route.ts zakiledger/tests/classify-merchants.test.ts
git commit -m "feat: merchant classification endpoint with cache-first lookup"
```

---

### Task 4: AI resolution tier in `suggestCategory`

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts` (`suggestCategory` ~line 114-153,
  `buildReviewRows` ~line 404-490)
- Modify: `zakiledger/components/review/ReviewBoard.tsx` (`ReviewRow` interface, ~line 53-77)
- Modify: `zakiledger/tests/reconciliation-insights.test.ts` (3 existing `suggestCategory`
  call sites, ~line 130-143; new describe block after line 160)

**Interfaces:**
- Consumes: `MerchantAiCategory` (Task 1).
- Produces: `suggestCategory(...)` now returns `{ label: string; reason?: string }` instead
  of `string` (breaking change to its 2 callers, both updated in this task).
  `buildReviewRows`'s input gains `aiCategories?: Map<string, MerchantAiCategory>`.
  `ReviewRow` gains `categoryReason?: string`. Task 5 consumes both new fields.

- [ ] **Step 1: Add `categoryReason` to `ReviewRow`**

In `zakiledger/components/review/ReviewBoard.tsx`, in the `ReviewRow` interface:

```typescript
export interface ReviewRow {
  id: string;
  section: ReviewSectionKey;
  date: string;
  title: string;
  subtitle: string;
  amountLabel: string;
  amountSubLabel: string;
  categoryLabel: string;
  /** Why an AI-tier suggestion picked this category — set only when
   * categoryLabel came from the AI fallback (see suggestCategory in
   * lib/reconciliation-insights.ts). Unset for every other resolution tier. */
  categoryReason?: string;
  confidencePct: number;
  confidenceLabel: string;
  confidenceColor: string;
  reason: string;
  badges: string[];
  comparePair?: { aLabel: string; a: string; bLabel: string; b: string };
  detection?: ReviewDetection;
  approvable?: boolean;
  notApprovableReason?: string;
}
```

- [ ] **Step 2: Write failing tests**

In `zakiledger/tests/reconciliation-insights.test.ts`, update the 3 existing direct
`suggestCategory` assertions (the function's return shape is changing) — replace the
`describe("suggestCategory", ...)` block:

```typescript
describe("suggestCategory", () => {
  it("uses the matched QB transaction's account name when there is a match", () => {
    expect(suggestCategory(bank(), qb({ accountName: "Software & Hosting" }), [], []).label).toBe("Software & Hosting");
  });
  it("falls back to the most common category this merchant has been matched to before", () => {
    const priorMatch = match({ bankTransactionId: "b-other", qbTransactionId: "q-other" });
    const priorQb = qb({ id: "q-other", accountName: "Office Supplies" });
    const result = suggestCategory(bank({ id: "b2", merchant: "AWS EMEA" }), null, [priorMatch], [priorQb]);
    expect(result.label).toBe("Office Supplies");
  });
  it("falls back to Uncategorised when there is nothing to go on", () => {
    expect(suggestCategory(bank({ merchant: "Totally New Merchant" }), null, [], []).label).toBe("Uncategorised");
  });
});
```

Then add a new describe block immediately after the `describe("learned and hardcoded
category suggestions", ...)` block (which ends at line 160) and before `describe("factorBreakdown", ...)`:

```typescript
describe("AI merchant-category fallback", () => {
  it("uses the AI cache when the hardcoded table has nothing", () => {
    const ai = new Map([["totally new merchant", { category: "Software & SaaS", confidencePct: 88, reason: "Recurring SaaS billing name." }]]);
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "Totally New Merchant" })], qbTransactions: [], matches: [],
      aiCategories: ai,
    });
    expect(rows[0].row.categoryLabel).toBe("Software & SaaS (88% AI suggested)");
    expect(rows[0].row.categoryReason).toBe("Recurring SaaS billing name.");
  });

  it("prefers the hardcoded table over an AI suggestion when both exist", () => {
    const shellAi = new Map([["shell 4471", { category: "Software & SaaS", confidencePct: 60, reason: "Ambiguous name." }]]);
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "SHELL 4471" })], qbTransactions: [], matches: [],
      aiCategories: shellAi,
    });
    expect(rows[0].row.categoryLabel).toBe("Motor Expenses (94% suggested)");
    expect(rows[0].row.categoryReason).toBeUndefined();
  });

  it("falls through to plain Uncategorised when the AI itself couldn't tell", () => {
    const unknownAi = new Map([["totally new merchant", { category: "Uncategorised", confidencePct: 0, reason: "No signal in the name." }]]);
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "Totally New Merchant" })], qbTransactions: [], matches: [],
      aiCategories: unknownAi,
    });
    expect(rows[0].row.categoryLabel).toBe("Uncategorised");
    expect(rows[0].row.categoryReason).toBeUndefined();
  });

  it("leaves categoryReason unset for rows resolved by any other tier", () => {
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "SHELL 4471" })], qbTransactions: [], matches: [],
    });
    expect(rows[0].row.categoryReason).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify failure** → `npm run test -- reconciliation-insights` → FAIL
  (return-shape mismatch, `aiCategories` unknown field).

- [ ] **Step 4: Implement**

In `zakiledger/lib/reconciliation-insights.ts`, add the import and replace `suggestCategory`:

```typescript
import type { MerchantAiCategory } from "./merchant-ai";
```

```typescript
/** Resolution order: a learned merchant preference (3+ approvals) beats
 * everything, since it is the accountant's own past decision. Below that:
 * the matched QB account name -> the most common account name this merchant
 * has been matched to elsewhere in this statement -> the hardcoded UK
 * merchant table -> a live AI classification (cached, see lib/merchant-ai.ts)
 * for merchants the hardcoded table doesn't recognise -> "Uncategorised". A
 * real cross-statement lookup is a follow-up, not needed to ship this
 * screen. */
export function suggestCategory(
  bank: BankTransaction,
  qb: QbTransaction | null,
  matches: ReconciliationMatch[],
  qbTxns: QbTransaction[],
  /** Accounting entries indexed by id. Callers categorising a whole statement
   * pass theirs so it is built once rather than per row. */
  qbById?: Map<string, QbTransaction>,
  /** Merchant key (normalised) -> the learned preference. Callers
   * categorising a whole statement pass theirs so it is built once. */
  preferences?: Map<string, MerchantPreference>,
  /** Merchant key (normalised) -> a cached AI classification. Callers
   * categorising a whole statement pass theirs so it is built once. */
  aiCategories?: Map<string, MerchantAiCategory>,
): { label: string; reason?: string } {
  const key = normalizeMerchant(bank);
  const pref = key ? preferences?.get(key) : undefined;
  if (pref && pref.approvalCount >= 3) return { label: `${pref.category} (learned from ${pref.approvalCount} approvals)` };

  if (qb?.accountName) return { label: qb.accountName };
  if (!key) return { label: "Uncategorised" };
  const index = qbById ?? new Map(qbTxns.map((q) => [q.id, q]));
  const counts = new Map<string, number>();
  for (const m of matches) {
    if (!m.qbTransactionId) continue;
    const matchedQb = index.get(m.qbTransactionId);
    if (!matchedQb?.accountName) continue;
    counts.set(matchedQb.accountName, (counts.get(matchedQb.accountName) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return { label: top[0] };

  const hardcoded = suggestMerchantCategory(bank.merchant ?? bank.description);
  if (hardcoded) return { label: `${hardcoded.category} (${hardcoded.confidencePct}% suggested)` };

  const ai = aiCategories?.get(key);
  if (ai && ai.category !== "Uncategorised") {
    return { label: `${ai.category} (${ai.confidencePct}% AI suggested)`, reason: ai.reason };
  }

  return { label: "Uncategorised" };
}
```

In `buildReviewRows`'s input type, add the field:

```typescript
export function buildReviewRows(data: {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
  preferences?: MerchantPreference[];
  aiCategories?: Map<string, MerchantAiCategory>;
}): { id: string; row: ReviewRow; matchId: string | null }[] {
```

And update the per-row category call + row construction (replace the existing `const
category = suggestCategory(...)` line and the `categoryLabel: category,` field):

```typescript
    const { label: categoryLabel, reason: categoryReason } = suggestCategory(
      bank, qb, sameMerchantMatches, data.qbTransactions, qbById, preferencesByMerchant, data.aiCategories,
    );
```

```typescript
      categoryLabel,
      categoryReason,
```

(placed where `categoryLabel: category,` previously sat in the `row` object literal —
`categoryReason` goes on its own line immediately after).

- [ ] **Step 5: Run tests** → `npm run test -- reconciliation-insights` → PASS. Then `npm run check` → PASS.

- [ ] **Step 6: Commit**

```bash
git add zakiledger/lib/reconciliation-insights.ts zakiledger/components/review/ReviewBoard.tsx zakiledger/tests/reconciliation-insights.test.ts
git commit -m "feat: AI-classified category as the final suggestCategory tier"
```

---

### Task 5: Review page — progressive fetch + display

**Files:**
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx`

**Interfaces:**
- Consumes: `POST /api/reconciliation/classify-merchants` (Task 3), `buildReviewRows`'s
  `aiCategories` field and `ReviewRow.categoryReason` (Task 4).
- Produces: nothing further consumed by other tasks — this is the last task.

- [ ] **Step 1: Add state and import**

Near the top imports (alongside `import type { MerchantPreference } from "@/lib/decision-store";`):

```typescript
import type { MerchantAiCategory } from "@/lib/merchant-ai";
```

Near the existing `const [preferences, setPreferences] = useState<MerchantPreference[]>([]);`:

```typescript
  const [aiCategories, setAiCategories] = useState<Map<string, MerchantAiCategory>>(new Map());
```

- [ ] **Step 2: Thread `aiCategories` into the `board` memo**

In the `board` useMemo, add `aiCategories` to the `buildReviewRows` call and the
dependency array:

```typescript
    const built = buildReviewRows({
      bankTransactions: openBanks,
      qbTransactions: review.qbTransactions,
      matches: review.matches.filter((m) => m.approvedAt === null),
      preferences,
      aiCategories,
    });
```

```typescript
  }, [review, preferences, aiCategories]);
```

- [ ] **Step 3: Add the progressive-classification effect**

Immediately after the `board` useMemo (before `function openCount`):

```typescript
  /**
   * Progressive AI fallback: once the board is built, any row still showing
   * "Uncategorised" gets its merchant name sent for classification. This
   * runs after the initial render, not before, so Anthropic's latency or
   * downtime never delays the page's first paint — rows simply update in
   * place if and when a suggestion comes back.
   */
  useEffect(() => {
    if (!board) return;
    const candidates = board.rows
      .filter((r) => r.categoryLabel === "Uncategorised")
      .map((r) => r.title)
      .filter((name) => name && name !== "(no description)");
    const names = [...new Set(candidates)].filter((name) => !aiCategories.has(name.trim().toLowerCase()));
    if (names.length === 0) return;

    let cancelled = false;
    fetch("/api/reconciliation/classify-merchants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchantNames: names }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.categories) return;
        const entries = Object.entries(data.categories) as [string, MerchantAiCategory][];
        if (entries.length === 0) return;
        setAiCategories((prev) => new Map([...prev, ...entries]));
      })
      .catch(() => {
        // Best-effort — a network failure here just leaves these rows
        // Uncategorised, same as before this feature existed.
      });
    return () => {
      cancelled = true;
    };
  }, [board, aiCategories]);
```

- [ ] **Step 4: Render the reason in the detail panel**

In `ReconciliationPanelBody`, immediately after the "Suggested category" row's closing
`</div>` (the one right after the `<select>`'s `</select>`, still inside the
"Transaction details" wrapper):

```tsx
        {row.categoryReason && (
          <div style={{ fontSize: 12.5, fontStyle: "italic", color: shellColor.inkSoft, padding: "8px 0 0" }}>
            {row.categoryReason}
          </div>
        )}
```

- [ ] **Step 5: Verify**

`npm run check` → PASS (typecheck + full test suite, including Task 4's new tests).

Then `npm run dev` and open the review screen for a statement with at least one
unmatched transaction whose merchant isn't in the hardcoded table: confirm the row shows
"Uncategorised" on first paint (no delay), and — if `ANTHROPIC_API_KEY` is configured —
updates in place to an AI suggestion shortly after, with the reason visible in the detail
panel. Without a key configured, confirm the row simply stays "Uncategorised" with no
console errors — the required "never breaks the screen" behaviour.

- [ ] **Step 6: Commit**

```bash
git add "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "feat: progressive AI category suggestions on the review screen"
```

---

## Self-review notes

- Task order: 1 → 2 → 3 → 4 → 5. Task 2 needs Task 1's type; Task 3 needs Tasks 1+2; Task
  4 needs Task 1's type (for the new parameter/field) and is independent of Task 3's
  route; Task 5 needs Task 3 (the endpoint) and Task 4 (`aiCategories` input,
  `categoryReason` field) and reads nicest last since it's the only user-visible task.
- Every design-doc requirement has a task: wrapper + never-throws (Task 1), global cache +
  never-reclassify (Task 2), cache-first endpoint + always-200 (Task 3), new resolution
  tier + distinct label + reason field (Task 4), progressive non-blocking trigger +
  reason display (Task 5).
- No production code calls `@anthropic-ai/sdk` or hits a network socket during `npm run
  test` — every test mocks at the `@anthropic-ai/sdk` boundary (Task 1) or the
  `@/lib/merchant-ai` boundary (Task 3), matching this codebase's existing
  `extract-batch-failure.test.ts`/`bulk-approve.test.ts` conventions.
- Learning (`bumpMerchantPreference`) is untouched by this plan — no task modifies the
  approve route, confirming the design doc's "no changes needed" call.
