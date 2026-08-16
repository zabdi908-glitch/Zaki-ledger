# Reconciliation Defect Remediation — Design (D1–D6)

Adopted 2026-08-16 after the adversarial local Supabase staging verdict.
Branch `fix/reconciliation-candidate-hardening`, base commit `b67bc99`.

Scope: DESIGN + IMPLEMENTATION + LOCAL VALIDATION only. No production access,
no production repair, no edits to migrations 010/011/012. All DB changes live
in a new migration `013_reconciliation_claim_hardening.sql`.

---

## 1. Phase-1 inventory (what the design is built on)

### 1.1 `reconciliation_matches` columns

From migrations 003 (+008/009 identity columns) and 012 (canonical spine):

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid NOT NULL → auth.users | |
| statement_id | uuid NOT NULL → bank_statements | |
| bank_transaction_id | uuid NOT NULL → bank_transactions | |
| qb_transaction_id | uuid NULL → qb_transactions ON DELETE SET NULL | |
| confidence | numeric(4,3) NULL | score/100 |
| match_reason | text | |
| flagged_level | text CHECK green/yellow/red | |
| matched_by | text CHECK auto/manual | origin discriminator |
| matched_at | timestamptz | |
| approved_by | text NULL | free-text approver |
| approved_at | timestamptz NULL | approval stamp |
| audit_memo | jsonb | structured memo |
| client_entity_id | uuid NULL (012; mandatory on canonical writes) | tenant stamp |

### 1.2 Constraints / indexes / RLS / grants (current)

- `UNIQUE (bank_transaction_id, statement_id)` — the table models **one match row
  per bank row**: a 1:1 suggestion/decision layer. Richer many:1 / 1:many /
  partial / allocation semantics live in the canonical
  `financial_relationships` / `financial_allocations` layer (010). Many:1
  *is* representable at the row level today (several bank rows may each carry
  a row pointing at one QB row) and must stay legal for manual rows.
- No QB-side uniqueness anywhere — the root of D1.
- 012 composite FKs tie match ↔ statement ↔ bank row to one `client_entity_id`;
  trigger `match_qb_same_client_v1` ties the QB endpoint to the same client.
- RLS: `FOR ALL USING (auth.uid() = user_id)` (003) — user-scoped. Tenant
  isolation at write time is enforced by composite FKs + triggers, not RLS.
- Grants: **none explicit on the four reconciliation tables** except 012's
  audit-log revokes. Migrations 008/009 only reset the four ingestion tables
  (service_role SELECT+INSERT). Everything else depended on Supabase
  base-image default privileges, which the current local base
  (`supabase/postgres:17.6.1.147`) no longer materializes — empirically
  confirmed after a fresh `supabase db reset` (see §4). This is D3.

### 1.3 Write paths into `reconciliation_matches` (complete list)

| path | statement | semantics today |
|---|---|---|
| auto persist | `computeAndPersistMatches` → upsert `onConflict bank_transaction_id+statement_id`, `ignoreDuplicates` | never clobbers an existing row |
| manual override | `createManualMatch` → upsert same conflict target (no ignore) | overwrites any row for the bank row, incl. approved rows (D4 hole) |
| approve | `approveMatches` → UPDATE `approved_by/approved_at` | raw UPDATE, audit row written after |
| unapprove | `unapproveMatches` → UPDATE `approved_by=null, approved_at=null` | raw UPDATE, audit row written after |
| reject | `rejectMatch` → DELETE | app checks `approved_at IS NULL` first; no DB guard |
| report | `generateReport` → upsert `reconciliation_reports` | |

All writes go through the **service_role** PostgREST client (`lib/supabase.ts`);
`authenticated` has its own RLS-scoped REST surface (documented in
`migration-012-tenant-isolation.test.ts` header comment: matches/reports/
decisions = ALL + RLS; audit log = SELECT only; bank tables = denied).

### 1.4 Candidate pre-read today

`listMatchedQbIds(userId)` returns every live match's `qb_transaction_id`
(auto or manual, approved or not) and excludes it from the auto candidate
pool. Two consequences:

- D1: the exclusion is a **pre-read**, not a DB invariant. Two concurrent
  workers both read "free" and both persist → two live 1:1 claims on one QB
  row.
- D2: the exclusion is **permanent while the row lives**. A weak
  evidence-floor-passing unapproved suggestion reserves its QB row forever,
  so a later exact candidate scores zero matches.

---

## 2. D1 — DB-enforced exclusive auto 1:1 claim

### 2.1 Claim-class predicate (proven)

New columns on `reconciliation_matches`:

```
superseded_at            timestamptz
superseded_by_match_id   uuid REFERENCES reconciliation_matches(id) ON DELETE SET NULL
supersede_reason         text
supersede_operation_id   uuid
```

The exclusive auto-claim class is:

```
matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
```

Proof that this predicate is *exactly* the exclusive claim class:

1. `matched_by = 'auto'` — the existing, canonical origin field. Automatic
   1:1 claims are precisely the rows the auto matcher writes. No new
   discriminator column is invented.
2. `superseded_at IS NULL` — "live". Superseded rows are historical evidence,
   not claims.
3. Approval does not change `matched_by` — an approved auto row stays in the
   class, which is correct: approval must not open a second claim
   (invariant A/B).
4. Manual rows are excluded by `matched_by` — manual many:1 (two bank rows →
   one QB row) and any future explicit allocation remain legal. The canonical
   `financial_relationships` layer is untouched.
5. Tenant safety: `qb_transaction_id` values are tenant-owned row UUIDs; the
   012 composite FKs + `match_qb_same_client_v1` make it impossible for two
   tenants to reference the same QB row, so the index can never couple two
   tenants.

Index:

```sql
CREATE UNIQUE INDEX uk_matches_auto_live_qb
  ON public.reconciliation_matches (qb_transaction_id)
  WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL
    AND superseded_at IS NULL;
```

### 2.2 Concurrency protocol

Auto-match persistence moves (on canonical-013 schemas) to a single RPC
`persist_auto_matches_v1(p_user_id, p_statement_id, p_client_entity_id,
p_matches jsonb)`, SECURITY INVOKER, EXECUTE granted to `service_role` only
(same ACL pattern as the 008 ingestion RPCs). Per proposed match, inside one
transaction:

1. `SELECT ... FOR UPDATE` any live row holding the QB id (auto or manual).
   - live manual row → outcome `blocked` (human decision wins; item skipped);
   - live approved auto row → `blocked` (invariant B);
   - live green unapproved auto row → `blocked` (§3 rule — nothing replaces
     green evidence);
   - live sub-green unapproved auto row → supersession rule from §3: allowed →
     supersede (UPDATE old row `superseded_*` + INSERT audit row) then INSERT
     new row; disallowed → `blocked`;
   - no live holder → plain INSERT.
2. INSERT with `ON CONFLICT (bank_transaction_id, statement_id) DO NOTHING`
   (idempotent retry). A `unique_violation` whose detail names
   `uk_matches_auto_live_qb` is caught per-item (plpgsql subtransaction) and
   recorded as outcome `conflicted` — a concurrent writer claimed the QB row
   between our lock scan and our INSERT.
3. The RPC returns `{inserted, superseded, conflicted, blocked}` arrays.

Why this satisfies D1:

- **database-enforced**: the partial unique index is the backstop; the app's
  pre-read exclusion becomes an optimization, not the safety mechanism.
- **concurrency-safe**: W1's INSERT wins; W2's INSERT raises 23505 against the
  index and is converted to a deterministic `conflicted` outcome.
- **retry-safe**: retry re-runs the same RPC; `ON CONFLICT DO NOTHING` +
  holder scan make every item idempotent; no duplicate claims can appear.
- **deterministic failure**: W2's result is a well-defined outcome, not
  corrupted state; its bank row surfaces as unmatched in the returned picture.
- **does not depend solely on pre-read `listMatchedQbIds`**: the lock + index
  hold even if the pre-read is stale.
- **legitimate many:1 / 1:many untouched**: manual rows never enter the class.

Pre-013 schemas (011/012-without-013, in-memory store) keep today's write
path unchanged — no regression on legacy compatibility.

---

## 3. D2 — temporal stronger-evidence semantics

### 3.1 Intended semantics (deterministic, no AI judgment)

Reservation classes for the auto candidate pool (canonical-013 schemas):

| live row | reserves its QB row against auto claims? |
|---|---|
| approved (any origin) | **yes, always** (invariant B) |
| manual (any approval state) | **yes, always** (human decision) |
| auto, `round(confidence*100) ≥ 95` (green) | **yes** |
| auto, `round(confidence*100) < 95` (yellow/red), unapproved | **no — re-scored every run** |

Supersession rule (applied inside `persist_auto_matches_v1`, identically in
the in-memory store):

An auto candidate (bank B, QB X, score `S_new`) supersedes a live holder
row R_old iff **all** of:

- R_old.`matched_by = 'auto'` and R_old.`approved_at IS NULL` and
  R_old.`superseded_at IS NULL` (unresolved weak suggestion);
- same tenant/client — guaranteed by construction (statement-scoped auto
  matching + 012 composite FKs);
- `S_new ≥ 95` (`GREEN_MIN_SCORE` — the new evidence is auto-approve-grade);
- `S_new − round(R_old.confidence*100) ≥ 20` (`SUPERSEDE_MIN_DELTA` —
  materially stronger, constant, not AI judgment).

Documented behavior:

- **when an unapproved suggestion blocks**: it blocks any *weaker or equal*
  later auto candidate for its QB row, and blocks nothing else — the QB row
  stays re-scorable, and manual decisions are never blocked.
- **when it does not block**: it does not block a materially stronger
  candidate (≥95, delta ≥20), and never blocks manual allocation.
- **when it may be superseded**: exactly by the rule above.
- **minimum score delta**: 20 points, plus the 95 floor (so 90→100 with delta
  10 is *not* superseded; a strong review-grade suggestion is not churned out
  by a slightly stronger one — conservative by design).
- **equal candidates**: delta 0 → never superseded → the first claim wins;
  ordering stays deterministic (existing `score desc, bankId, qbId` tie-break).
- **approved rows**: never auto-superseded, never rewritten, never moved.
- **audit event**: `reconciliation_audit_log` row `action='match_superseded'`
  on the old match id, `old_confidence`/`new_confidence` set, plus the old
  row's `superseded_at` / `superseded_by_match_id` / `supersede_reason` /
  `supersede_operation_id` (one UUID minted per persist operation). The
  existing per-match audit infrastructure is reused; no new audit tables.
- **retry behavior**: idempotent — re-running the RPC with the same payload
  finds the holder already superseded / the claim taken and lands in
  `conflicted`/`blocked`, never duplicating.
- **manual sweep**: creating a manual match runs
  `supersede_auto_claims_v1(qb_transaction_id)` — a human decision supersedes
  live unapproved auto suggestions on the same QB row (audit-logged, same
  `superseded_*` fields). Approved auto rows are protected. The auto-matching
  run repeats this sweep before scoring, so any race converges on the next
  run without corruption.

### 3.2 Chosen approach vs alternatives

- Option C (separate tentative-suggestion table) — rejected: duplicates the
  match lifecycle, breaks every read path, and the canonical layer already
  has `financial_relationships` for richer modeling.
- Option B (supersede with deterministic rule) — chosen, with option A's
  "no exclusive reservation below the threshold" folded in: sub-green
  unapproved auto rows never reserve, so the bug cannot recur structurally.
- The threshold constants (95 floor, 20 delta) reuse the existing, tested
  bucket boundaries (`GREEN_MIN_SCORE`) and are pure constants evaluated in
  SQL and TS — no model call anywhere in the transition.

### 3.3 Amendment to the invariants doc

Invariant A's mechanism is amended from "exclusion pre-read of all live
rows" to "exclusion pre-read of reserved rows + DB-enforced
`uk_matches_auto_live_qb` partial unique index + deterministic supersession
rule". The non-goal "frozen-match upgrade" is retired for *unapproved
sub-green auto* rows specifically — this design is that task.

---

## 4. D3 — privilege / grant lineage

**Empirically confirmed on the current local base**
(`supabase/postgres:17.6.1.147`, CLI 2.114.0) after a fresh
`supabase db reset` from migrations 001–012 with **zero manual SQL**:

- `reconciliation_matches`, `reconciliation_reports`,
  `reconciliation_decisions`, `reconciliation_audit_log`,
  `user_merchant_preferences`: `service_role` and `authenticated` hold
  **no SELECT/INSERT/UPDATE/DELETE at all** (only REFERENCES/TRIGGER/TRUNCATE
  materialized by ownership). Every reconciliation store operation fails.
- The four ingestion tables hold `service_role` SELECT+INSERT (008/009) —
  those are fine.

**Root cause**: migrations 003/005/001 created these tables relying on
Supabase base-image default privileges (`arwdDxtm` to
anon/authenticated/service_role). The new base image no longer materializes
those defaults, and no migration ever granted the reconciliation tables
explicitly (008/009 covered only the ingestion tables; 012 only revoked on
the audit log). This is a **missing repository migration requirement** (1),
triggered by a base change (2) — not a test-harness artifact.

**Migration 013 grant design** (explicit REVOKE then GRANT — idempotent,
reset-safe, normalizes both old and new bases):

| table | service_role | authenticated | anon |
|---|---|---|---|
| reconciliation_matches | SELECT, INSERT, UPDATE, DELETE | SELECT, INSERT, UPDATE, DELETE | — |
| reconciliation_reports | SELECT, INSERT, UPDATE, DELETE | SELECT, INSERT, UPDATE, DELETE | — |
| reconciliation_decisions | SELECT, INSERT, UPDATE, DELETE | SELECT, INSERT, UPDATE, DELETE | — |
| reconciliation_audit_log | SELECT, INSERT, UPDATE, DELETE | SELECT only | — |
| user_merchant_preferences | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE | — |

- `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` first on
  each table.
- `authenticated` on matches/reports/decisions = the documented ALL+RLS
  contract (tenant-isolation suite header); audit log = SELECT only (012
  Z12 contract retained: authenticated DML denied, service_role DML present —
  actual mutation stays blocked by the 012 evidence-immutability triggers).
- RLS policies are untouched; tenant isolation is unchanged (composite FKs +
  write-guard triggers + same-client trigger keep doing the real work).
- No PUBLIC grants anywhere; `anon` explicitly gets nothing.

The 013 contract tests re-assert the 012 Z12/B11 invariants plus the new
grants, and the tenant-isolation suite re-proves authenticated cannot gain
privileged mutation access (its "authenticated direct audit DML denied" and
cross-tenant cases must still pass).

---

## 5. D4 — approved-match immutability at the DB layer

Trigger `reconciliation_match_approved_guard` (function
`reconciliation_match_guard_v1`, BEFORE UPDATE OR DELETE on
`reconciliation_matches`), enforced regardless of application role:

- **DELETE**: `OLD.approved_at IS NOT NULL` → 42806 raise (approved rows are
  not deletable); `OLD.superseded_at IS NOT NULL` → 42806 raise (historical
  evidence is not deletable). Unapproved live rows remain deletable
  (`rejectMatch`).
- **UPDATE** of a superseded row → 42806 raise (supersession is final).
- **UPDATE** that changes any `superseded_*` column → allowed only when a
  controlled 013 RPC has minted the matching one-shot transaction capability;
  raw PostgREST DML cannot mint one.
- **UPDATE** of an approved row → allowed only when
  `zaki.reconciliation_correction = 'on'` (set exclusively by the unapprove
  RPC), **and** the only changed columns are `approved_by`/`approved_at`,
  **and** the transition clears approval (`NEW.approved_at IS NULL`,
  `NEW.approved_by IS NULL`). Everything else — repointing
  `qb_transaction_id`, `bank_transaction_id`, `statement_id`, mutating
  confidence/reason/memo, re-stamping approval — raises 42806.

So: **immutable-by-default + explicit controlled correction path**, not
absolute irreversibility. The controlled path is
`unapprove_reconciliation_matches_v1(p_user_id uuid, p_match_ids uuid[])`
(SECURITY INVOKER; EXECUTE `service_role` only):

1. caller is `service_role` (auth guard like the 008 RPCs);
2. per id: lock the row, verify `user_id = p_user_id` (tenant ownership) and
   the row is live;
3. mint a one-shot correction capability, clear approval, and write
   `reconciliation_audit_log` `action='match_unapproved'` atomically;
4. idempotent: already-unapproved rows are reported as skipped.

After unapproval the row is an ordinary live row again — it can be re-matched
or manually repointed, with every step audited. `unapproveMatches` (app)
switches to this RPC when the 013 probe succeeds; pre-013 schemas keep the
legacy direct UPDATE (old semantics, no guard present). `createManualMatch`
refuses to overwrite an approved row with a controlled error instead of
hitting the trigger. Superseded rows are filtered out of approve/reject
surfaces.

---

## 6. D5 — ledger book boundary (investigation + recommendation)

Facts:

- `reconciliation_matches` has **no** `ledger_book_id`; 012 deliberately
  stamped matches with `client_entity_id` only (book is one hop away via the
  statement).
- Same-client multiple books legitimately exist: `ledger_books` with
  `book_kind` (canonical registry points at one `internal` book today).
- One QB observation belongs to exactly one ledger book
  (`qb_transactions.ledger_book_id`, mandatory on canonical rows).
- A match's book is derivable unambiguously from **both** endpoints:
  statement side `bank_statements.ledger_book_id`, QB side
  `qb_transactions.ledger_book_id`. Nothing today verifies they agree — a
  same-client/different-book match can be written.

**Recommendation**: do **not** add `ledger_book_id` to
`reconciliation_matches` (duplicated derivable state, backfill + immutability
cost, 012 pattern already derives book through the statement FK). Instead,
013 adds trigger `match_book_alignment_v1` (BEFORE INSERT OR UPDATE OF
`qb_transaction_id`, `statement_id`, `bank_transaction_id`): resolve both
endpoint books; if both are non-NULL and differ → 23514 raise. Legacy rows
with NULL books are skipped, historical rows are never re-validated, and
pre-012 schemas never see the trigger — fully backward compatible. This is
implemented in 013.

---

## 7. D6 — manual override window (decision)

**Decision: yes — manual override intentionally searches outside ±5 days.**
The ±5-day window is a matching heuristic (`DATE_PENDING_DAYS`, pending
clearance), not an accounting boundary; a human reconciling a late-paid bill
must be able to pick any QB row. `createManualMatch` now looks up the QB
candidate in the tenant's **full client/book pool** (no date window) on
canonical-012 schemas, and the full user pool on pre-012. Nothing about
tenant, client, authorization, or ledger book is bypassed: the 012 composite
FKs, same-client trigger, and the new book-alignment trigger still enforce
every boundary at write time.

---

## 8. Files the implementation will touch

- `supabase/migrations/013_reconciliation_claim_hardening.sql` (new)
- `zakiledger/lib/reconciliation-matching.ts` (constants + pure rule helpers)
- `zakiledger/lib/reconciliation-store.ts` (persist/manual/approve/reject
  flows, reservation classes, RPC usage, type mapping)
- `zakiledger/lib/reconciliation-schema.ts` (superseded_* fields on
  `ReconciliationMatch`)
- `zakiledger/lib/reconciliation-schema-capability.ts` (013 capability probe,
  same deterministic PGRST202 pattern)
- `zakiledger/tests/reconciliation-supersession-rule.test.ts` (new, pure unit)
- `zakiledger/tests/reconciliation-defect-regression.test.ts` (new, DB-gated,
  the 13 mandatory regression tests)
- `zakiledger/tests/migration-013-contract.test.ts` (new, DB-gated contract)
- `docs/RECONCILIATION_MATCHING_INVARIANTS.md` (invariant A amendment)
- `docs/RECONCILIATION_HARDENING_REPORT.md` is *not* edited; this design and
  the remediation report stand on their own.

Migration hashes for 010/011/012 re-verified before any change:
`ad609305…`, `84138bb4…`, `a7e25fa3…` — all match the authoritative values.

---

## 9. Atomic manual/automatic correction (invariant M)

Artifact review found that the original canonical-013 application path still
performed manual upsert, automatic-claim sweep, and manual audit insertion as
three PostgREST transactions. Its automatic holder scan also locked only rows
that already existed, so an empty endpoint had no shared serialization object.
A stale automatic decision could therefore insert after a completed manual
transition.

The corrected migration uses the stable endpoint rows as the lock objects.
All controlled reconciliation transitions acquire locks in this order:

1. distinct bank transaction rows, UUID ascending;
2. distinct QB transaction rows, UUID ascending;
3. relationship rows required by the transition.

`persist_auto_matches_v1` locks the complete batch endpoint set before any
manual/automatic relationship read. `create_manual_match_v1` is the single
service-only manual operation: it validates actor, statement, bank and QB
ownership plus client/book alignment; locks and revalidates the endpoints;
fails on protected approved automatic state; supersedes eligible unapproved
automatic state; writes the manual relationship; and appends manual and
supersession audit evidence in one transaction. The approval core uses the
same endpoint locks and refuses to protect an automatic row if a live manual
relationship already exists for that QB endpoint. It does not repair history.

The partial `uk_matches_auto_live_qb` index is unchanged and remains an
additional auto-vs-auto guarantee. No global `UNIQUE(qb_transaction_id)` is
introduced, so manual many:1 and canonical allocation relationships remain
valid.
