# Step 4B (Corrected) — Reconciliation Tenant Spine Design

Status: **DESIGN READY FOR STEP 4C IMPLEMENTATION** (adversarial review corrections applied 2026-08-11; Patch 2 — root write-guard + audit ACL corrections applied 2026-08-12)
Scope: design only. No implementation, no file changes to migrations/app code, no Migration 012 created.

Evidence basis: Migration 010 SHA `AD609305B040063A0C6186C9E3460F8BB886CE8429A1D03D8F48F6D17907902D`, Migration 011 SHA `84138BB49A51474C2B7EFDC110780A37AD293A7A5A0E63A2618480DA926D7418` (verified against working tree), Migrations 003/005/008/009 sources, `supabase/tests/011_default_tenant_contract.sql`, `zakiledger/lib/reconciliation-store.ts`, `decision-store.ts`, `nightly-match.ts`, `invoice-match-store.ts`, and all reconciliation API routes.

---

## 1. Change summary (17 corrections from adversarial review)

| # | Finding | Correction applied |
|---|---|---|
| 1 | Self-context RPC had contradictory bodies | One authoritative body adopted (Section 3) |
| 2 | Write-guard trigger conflicted with audit ON DELETE SET NULL | Trigger scoped to specific columns; FK SET NULL path exempted (Section 4) |
| 3 | QB same-client enforcement missing | Composite UNIQUE on qb_transactions + same-client validation trigger (Section 5) |
| 4 | `/invoice-match` not in freeze scope | Added to freeze list + 4C scope (Section 6) |
| 5 | Preflight and migration classifiers diverged | Unified canonical classifier (Section 7) |
| 6 | Legacy user universe incomplete | All 7 spine tables scanned (Section 8) |
| 7 | Pre-existing relationship integrity checks missing | Full preflight integrity matrix (Section 9) |
| 8 | Database guarantees overstated | Restated with precise application/DB boundary (Section 10) |
| 9 | NULL/write-guard contradictions | Exact per-table NULL transition semantics (Section 11) |
| 10 | FK validation mode contradictory | Plain ADD CONSTRAINT, immediate validation; NOT VALID documented as future only (Section 12) |
| 11 | Restore drill incomplete | Added adversarial restore + exact 012 apply test (Section 13) |
| 12 | Audit user FK semantics unspecified | RESTRICT on user_id FK; justification documented (Section 14) |
| 13 | Trigger installation order unspecified | Exact ordered sequence (Section 15) |
| 14 | Now-eligible-later lifecycle gap | Explicit quarantine + future backfill path; preflight count (Section 16) |
| 15 | Decision cascade semantics | Changed to RESTRICT; justification documented (Section 17) |
| 16 | Old-shape RPC early return bypasses validation | Validation before artifact-reuse branch; tests pinned (Section 18) |
| 17 | Missing test coverage | Full test matrix added (Section 19) |
| 18 | Root-table write guard checks only client_entity_id; prose demands ledger_book_id too | Split into `require_reconciliation_client_stamp_v1` (child) + `require_reconciliation_root_stamp_v1` (root, both stamps) (Section 4, Z8) |
| 19 | Audit log FOR ALL RLS allows authenticated to fabricate immutable evidence | FOR SELECT only; REVOKE INSERT/UPDATE/DELETE from authenticated; service_role remains sole write path (Section 20, Z12) |

---

## 2. Corrected authoritative sections

### Section 3 — Unified read-only self-context RPC

One authoritative body. All prior contradictory versions are void.

```sql
CREATE OR REPLACE FUNCTION public.canonical_default_tenant_context_for_self_v1()
RETURNS TABLE (
  practice_id            uuid,
  practice_membership_id uuid,
  client_entity_id       uuid,
  internal_ledger_book_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_reg public.default_tenant_identities%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'default tenant context requires an authenticated JWT'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_reg FROM public.default_tenant_identities WHERE user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default tenant identity not found'
      USING ERRCODE = '23503';
  END IF;

  IF v_reg.practice_id IS NULL OR v_reg.practice_membership_id IS NULL
     OR v_reg.client_entity_id IS NULL OR v_reg.internal_ledger_book_id IS NULL THEN
    RAISE EXCEPTION 'default tenant identity is incomplete'
      USING ERRCODE = '23502';
  END IF;

  -- Full graph validation
  PERFORM 1 FROM public.practices
  WHERE id = v_reg.practice_id AND created_by_user_id = v_user_id
    AND status = 'active' AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default practice identity ownership mismatch' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.practice_memberships
  WHERE id = v_reg.practice_membership_id AND practice_id = v_reg.practice_id
    AND user_id = v_user_id AND role = 'owner' AND status = 'active' AND valid_to IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default practice membership identity ownership mismatch' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.client_entities
  WHERE id = v_reg.client_entity_id AND practice_id = v_reg.practice_id
    AND status = 'active' AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default client entity identity ownership mismatch' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.ledger_books
  WHERE id = v_reg.internal_ledger_book_id AND client_entity_id = v_reg.client_entity_id
    AND book_kind = 'internal' AND status = 'active' AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default internal ledger identity ownership mismatch' USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT v_reg.practice_id, v_reg.practice_membership_id,
                      v_reg.client_entity_id, v_reg.internal_ledger_book_id;
END;
$$;

REVOKE ALL ON FUNCTION public.canonical_default_tenant_context_for_self_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canonical_default_tenant_context_for_self_v1() TO authenticated;
```

Non-negotiable behavioral contract:

- SECURITY DEFINER, STABLE
- Zero arguments — user derived only from `auth.uid()`
- Authenticated JWT required; anon denied; service_role should not use this self RPC
- Reads `default_tenant_identities` internally; no table SELECT grants added
- Full graph validation: practice exists, `created_by_user_id = auth.uid()`, active/not archived; owner membership belongs to same user/practice, active, valid_to NULL; client belongs to practice, active/not archived; internal ledger book belongs to client, `book_kind='internal'`, active/not archived
- Missing registry = deterministic error (not zero rows)
- Incomplete/invalid graph = deterministic error
- No INSERT/UPDATE/DELETE; no `ensure_*`/bootstrap calls; zero `canonical_audit_ledger` rows
- Only `authenticated` may EXECUTE; anon denied; service_role denied

Step 4C may factor the graph validation into a shared SECURITY DEFINER helper used by both this RPC and the ingestion RPCs, provided the helper has no direct EXECUTE grants and is only reachable through reviewed functions.

Tests required (Section 19):
- Authenticated user returns their own four canonical IDs
- Authenticated produces zero `canonical_audit_ledger` rows (count before/after)
- Rejects missing `auth.uid()`; anon cannot EXECUTE
- service_role cannot EXECUTE (or returns appropriate error if called)
- Missing registry raises error, not zero rows
- Incomplete registry raises error
- Graph validation failure on each of the four entities raises distinct error
- No audit delta on request-time tenant resolution
- Pin exact behavior in Migration 012 contract test

---

### Section 4 — Write-guard vs audit ON DELETE SET NULL (corrected trigger design)

Problem: generic `BEFORE INSERT OR UPDATE` trigger that rejects `client_entity_id IS NULL` conflicts with `reconciliation_audit_log.reconciliation_match_id ON DELETE SET NULL`, because FK SET NULL actions fire UPDATE triggers.

Corrected design:

**For reconciliation_audit_log:**

```sql
-- BEFORE INSERT: require user_id NOT NULL and client_entity_id NOT NULL
CREATE OR REPLACE FUNCTION public.audit_log_write_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'audit log requires user_id' USING ERRCODE = '23502';
    END IF;
    IF NEW.client_entity_id IS NULL THEN
      RAISE EXCEPTION 'audit log requires client_entity_id' USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_write_guard
  BEFORE INSERT ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_write_guard_v1();

-- BEFORE UPDATE OF client_entity_id, user_id: enforce immutability (NULL → value allowed once)
CREATE OR REPLACE FUNCTION public.audit_log_stamp_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.client_entity_id IS NOT NULL
     AND NEW.client_entity_id IS DISTINCT FROM OLD.client_entity_id THEN
    RAISE EXCEPTION 'audit log client_entity_id is immutable' USING ERRCODE = '42806';
  END IF;
  IF OLD.user_id IS NOT NULL
     AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'audit log user_id is immutable' USING ERRCODE = '42806';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_stamp_immutable
  BEFORE UPDATE OF client_entity_id, user_id ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_stamp_immutable_v1();
```

**Evidence-column immutability (unchanged but scoped):**

```sql
CREATE OR REPLACE FUNCTION public.audit_log_evidence_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation audit evidence is immutable' USING ERRCODE = '42806';
END $$;

CREATE TRIGGER audit_log_evidence_immutable
  BEFORE UPDATE OF action, action_by, action_at, old_confidence, new_confidence
  ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_evidence_immutable_v1();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_evidence_immutable_v1();
```

Key: `reconciliation_match_id` is NOT in the immutable column list. FK-driven SET NULL touches only `reconciliation_match_id`, which is permitted. The stamp columns (`client_entity_id`, `user_id`) are protected by `audit_log_stamp_immutable` — they can only be set on INSERT and never changed after.

**For general reconciliation tables — two explicit guard functions:**

```sql
-- =========================================================================
-- Write-guard trigger functions (INSERT-only rejection of NULL stamps)
-- =========================================================================

-- A. Child-table guard: requires client_entity_id NOT NULL on INSERT.
-- Applied to: bank_transactions, reconciliation_matches,
--             reconciliation_reports, reconciliation_decisions
CREATE OR REPLACE FUNCTION public.require_reconciliation_client_stamp_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.client_entity_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical client_entity_id'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  -- UPDATE of client_entity_id to NULL is caught by immutability trigger below.
  -- UPDATE of other columns is permitted (FK SET NULL paths on parent tables
  -- do not fire this trigger on child tables; only child's own UPDATE fires).
  RETURN NEW;
END $$;

-- B. Root-table guard: requires BOTH client_entity_id AND ledger_book_id
-- NOT NULL on INSERT.
-- Applied to: bank_statements, qb_transactions
CREATE OR REPLACE FUNCTION public.require_reconciliation_root_stamp_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.client_entity_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical client_entity_id'
        USING ERRCODE = '23502';
    END IF;
    IF NEW.ledger_book_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical ledger_book_id'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END $$;
```

**Trigger attachments (explicit per-table):**

```sql
-- Root tables: BOTH stamps required
CREATE TRIGGER write_guard_root_stamp
  BEFORE INSERT ON public.bank_statements
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_root_stamp_v1();

CREATE TRIGGER write_guard_root_stamp
  BEFORE INSERT ON public.qb_transactions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_root_stamp_v1();

-- Child tables: client_entity_id only
CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_reports
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

-- Audit log: dedicated guard (unchanged; see audit section above)
CREATE TRIGGER audit_log_write_guard
  BEFORE INSERT ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_write_guard_v1();
```

**Immutability triggers (prevent client_entity_id from being changed after insert; allow legacy NULL → canonical exactly once):**

```sql
CREATE OR REPLACE FUNCTION public.client_stamp_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- NULL → canonical UUID: ALLOWED (legacy backfill / first-time stamp)
  -- canonical UUID → same UUID: ALLOWED (no-op UPDATE)
  -- canonical UUID → different UUID: REJECT
  -- canonical UUID → NULL: REJECT
  IF OLD.client_entity_id IS NOT NULL
     AND NEW.client_entity_id IS DISTINCT FROM OLD.client_entity_id THEN
    RAISE EXCEPTION 'client_entity_id is immutable once set' USING ERRCODE = '42806';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.ledger_book_id_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Same transition semantics: NULL → value ALLOWED; value → different REJECT; value → NULL REJECT
  IF OLD.ledger_book_id IS NOT NULL
     AND NEW.ledger_book_id IS DISTINCT FROM OLD.ledger_book_id THEN
    RAISE EXCEPTION 'ledger_book_id is immutable once set' USING ERRCODE = '42806';
  END IF;
  RETURN NEW;
END $$;
```

`client_stamp_immutable_v1()` attached as `BEFORE UPDATE OF client_entity_id` on all seven tables.
`ledger_book_id_immutable_v1()` attached as `BEFORE UPDATE OF ledger_book_id` on `bank_statements` and `qb_transactions`.
Audit log immutability triggers unchanged.

Transition matrix for `client_entity_id` (identical semantics for `ledger_book_id`):

| OLD | NEW | Result |
|---|---|---|
| NULL | canonical UUID | ALLOWED (backfill, first stamp) |
| canonical UUID A | canonical UUID A | ALLOWED (no-op) |
| canonical UUID A | canonical UUID B | REJECT (immutability) |
| canonical UUID A | NULL | REJECT (immutability) |
| NULL | NULL | ALLOWED (no-op on legacy NULL row) |

**Legacy NULL-row handling:**

- Existing legacy rows with NULL `client_entity_id` survive the migration (they existed before 012 committed).
- SELECT/read of legacy NULL rows is permitted through existing `user_id`-scoped RLS.
- UPDATE of a legacy NULL row's non-stamp columns is permitted (e.g., updating a match's confidence).
- UPDATE that sets `client_entity_id` from NULL to a canonical UUID is permitted exactly once (the immutability trigger allows NULL → value; see transition matrix above). Subsequent updates that attempt to change the stamp are rejected.
- After the first non-NULL stamp, `client_entity_id` is frozen.
- DELETE of legacy NULL rows is permitted through existing cascades; the write-guard only fires on INSERT.

**Explicit test required:**
- Legacy audit row with NULL `client_entity_id` exists (fixture).
- Delete parent match → FK SET NULL fires on `reconciliation_match_id`.
- Verify `client_entity_id` and `user_id` unchanged, `reconciliation_match_id` is NULL, row survives.
- Verify evidence columns unchanged.

---

### Section 5 — QB same-client enforcement

Current state: `reconciliation_matches.qb_transaction_id` has a single-column FK `REFERENCES qb_transactions(id) ON DELETE SET NULL`. No structural binding ensuring the referenced QB transaction belongs to the same client as the match.

Add:

```sql
-- Parent unique index required for composite FK
CREATE UNIQUE INDEX uk_qb_transactions_id_client
  ON public.qb_transactions (id, client_entity_id);

-- Same-client validation trigger (does not replace the existing FK; adds client check)
CREATE OR REPLACE FUNCTION public.match_qb_same_client_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_qb_client uuid;
BEGIN
  IF NEW.qb_transaction_id IS NOT NULL AND NEW.client_entity_id IS NOT NULL THEN
    SELECT client_entity_id INTO v_qb_client
    FROM public.qb_transactions
    WHERE id = NEW.qb_transaction_id;
    IF v_qb_client IS DISTINCT FROM NEW.client_entity_id THEN
      RAISE EXCEPTION 'match QB transaction must belong to the same client'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER match_qb_same_client_check
  BEFORE INSERT OR UPDATE OF qb_transaction_id, client_entity_id
  ON public.reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.match_qb_same_client_v1();
```

Design decision: keep the existing single-column FK (`qb_transaction_id REFERENCES qb_transactions(id) ON DELETE SET NULL`) unchanged. Do NOT add a composite FK `(qb_transaction_id, client_entity_id)` because composite `ON DELETE SET NULL` would null both columns, erasing the match's client stamp. The existing FK + same-client trigger preserves `client_entity_id` while allowing `qb_transaction_id` to become NULL when the QB transaction is deleted.

Invariant: if `qb_transaction_id IS NOT NULL`, the referenced QB transaction must have the same `client_entity_id` as the match. Enforced by the trigger on INSERT and UPDATE.

Test: insert a match with `qb_transaction_id` from client A and `client_entity_id` from client B → trigger rejection. Delete the QB transaction → match's `qb_transaction_id` becomes NULL, `client_entity_id` unchanged.

---

### Section 6 — /invoice-match route in freeze + 4C scope

`POST /api/reconciliation/[id]/invoice-match` calls `recordDecision()` which writes to `reconciliation_decisions`. Therefore it is a reconciliation-spine writer and must be:

1. Added to the mandatory write-freeze list (Phase 1 returns 503).
2. Threaded with `TenantContext` in Step 4C.
3. `recordDecision` must stamp `client_entity_id` on every decision row.

Updated freeze list (additions in **bold**):

- bank upload (`POST /api/reconciliation/upload`)
- QB/Xero CSV upload (`POST /api/reconciliation/qb-transactions/upload`)
- live QB/Xero sync (`POST /api/reconciliation/qb-transactions/sync`)
- on-demand sync (`POST /api/reconciliation/on-demand`)
- automatic matching that persists matches
- manual matching (`POST /api/reconciliation/[id]/match`)
- approve (`POST /api/reconciliation/[id]/approve`)
- reject (`POST /api/reconciliation/[id]/reject`)
- unapprove (`POST /api/reconciliation/[id]/unapprove`)
- **invoice-match (`POST /api/reconciliation/[id]/invoice-match`)** — writes reconciliation_decisions
- report generation that writes `reconciliation_reports`
- nightly reconciliation jobs

`recordDecision` in Step 4C must accept `ctx: TenantContext` and stamp `client_entity_id`:

```ts
export async function recordDecision(
  ctx: TenantContext,
  d: DecisionInput
): Promise<void> {
  // ... existing logic, with client_entity_id: ctx.clientEntityId stamped on insert
}
```

Invoice/document canonicalization remains out of scope. This change is only because the route writes `reconciliation_decisions`.

Tests: freeze probe confirms `/invoice-match` returns 503; canonical stamp on decision rows verified.

---

### Section 7 — Unified preflight/migration classifier

One canonical classification logic shared by production preflight and Migration 012. Must be identical in predicate, universe, and blocker classes.

**Eligibility predicate (exact):**
```sql
confirmed_at IS NOT NULL
AND deleted_at IS NULL
AND COALESCE(is_anonymous, false) = false
```

**Classes:**

| Class | Meaning | Migration 012 behavior | Preflight action |
|---|---|---|---|
| `ELIGIBLE + REGISTRY EXISTS` | 011-complete user, registry row present and complete | Backfill from registry; zero bootstrap calls | Count; verify registry integrity |
| `ELIGIBLE + REGISTRY MISSING` | Eligible but no registry row (011 gap user) | Bootstrap via RPC under advisory lock; stamp | Count; expected-zero for most pilots |
| `INELIGIBLE AUTH USER` | Unconfirmed / deleted / anonymous | Leave rows NULL; count; report; commit | Count; verify no eligible rows misclassified |
| `AUTH USER MISSING` | Legacy `user_id` not in `auth.users` | STOP (NO-GO) | Count; must be zero before proceeding |
| `OTHER BLOCKER` | Incomplete registry, registry integrity failure, conflicting stamp, cross-statement match, cross-user child | STOP (NO-GO) | Count; must be zero before proceeding |

**OTHER BLOCKER must include:**
- Registry row exists but incomplete (any of the four IDs NULL)
- Registry integrity check fails (practice not owned by user, membership invalid, client inactive/archived, ledger invalid)
- Pre-existing conflicting non-NULL stamp
- Cross-statement bank transaction match
- Cross-user child vs parent statement
- Orphan decision/audit rows with dangling references

The preflight query in T2 and the migration classification in E must produce identical counts for identical inputs. They must be derived from the same canonical SQL fragment (shared documentation, manually kept in sync, or extracted into a migration-role view used by both).

---

### Section 8 — Legacy user universe (all seven spine tables)

Do not classify only `bank_statements` + `qb_transactions`. Build the legacy user universe from every table that can contain user-owned rows independently.

**Production preflight runs against the 011 schema.** `reconciliation_audit_log.user_id` does not yet exist. The preflight classifier must derive audit users through the existing parent match.

**Preflight-safe classifier (011 schema):**

```sql
WITH legacy_users AS (
  SELECT DISTINCT user_id FROM public.bank_statements
  UNION
  SELECT DISTINCT user_id FROM public.bank_transactions
  UNION
  SELECT DISTINCT user_id FROM public.qb_transactions
  UNION
  SELECT DISTINCT user_id FROM public.reconciliation_matches
  UNION
  SELECT DISTINCT user_id FROM public.reconciliation_reports
  UNION
  SELECT DISTINCT user_id FROM public.reconciliation_decisions
  UNION
  -- audit log: derive user through parent match (user_id column does not exist yet)
  SELECT DISTINCT rm.user_id
  FROM public.reconciliation_audit_log ral
  JOIN public.reconciliation_matches rm ON rm.id = ral.reconciliation_match_id
)
```

**For `reconciliation_audit_log` specifically:**
- Preflight (011 schema): derive user through the live parent match (`JOIN reconciliation_matches ON reconciliation_match_id = matches.id` → `matches.user_id`).
- Audit rows without a resolvable parent match: classified separately by the orphan-audit rule (Section 9.E). If the parent match exists and has a `user_id`, the user enters the universe. If the parent match is missing, the audit row is an orphan and classified as `OTHER BLOCKER — orphan audit row`.
- Migration-side (012, after column add and backfill): the newly populated `user_id` column provides an equivalent universe. Both the preflight join-path and the backfilled column must produce the same set of distinct user IDs.

**Classifier parity test:**

Execute the preflight-safe query (join through match) against a disposable 011+data snapshot. After Migration 012 backfills `user_id`, execute `SELECT DISTINCT user_id FROM reconciliation_audit_log`. Both result sets must be identical. Any difference (user appears in one but not the other) is a classifier bug and blocks production.

**If a user exists only in `reconciliation_decisions` or `reconciliation_audit_log`** (no statements, no QB transactions), they must still be classified. The migration backfills their rows from the parent statement's (or parent match's) stamps.

---

### Section 9 — Pre-existing relationship integrity checks (preflight, read-only)

Before backfill, production preflight must detect every row shape that would cause a new FK or trigger to fail. All checks are read-only `SELECT`s.

**A. Cross-user child vs parent statement**

```sql
-- bank_transactions.user_id != parent statement.user_id
SELECT 'bank_transactions' AS tbl, bt.id, bt.user_id AS child_user, bs.user_id AS parent_user
FROM public.bank_transactions bt
JOIN public.bank_statements bs ON bs.id = bt.statement_id
WHERE bt.user_id <> bs.user_id;

-- Same for reconciliation_matches, reconciliation_reports, reconciliation_decisions
```

**B. Match bank_transaction_id belongs to different statement**

```sql
SELECT rm.id, rm.statement_id, rm.bank_transaction_id, bt.statement_id AS txn_statement_id
FROM public.reconciliation_matches rm
JOIN public.bank_transactions bt ON bt.id = rm.bank_transaction_id
WHERE rm.statement_id <> bt.statement_id;
```

**C. Match qb_transaction_id belongs to different user/client**

```sql
-- Cross-user: match.user_id != qb_transaction.user_id
SELECT rm.id, rm.user_id, qbt.user_id AS qb_user_id
FROM public.reconciliation_matches rm
JOIN public.qb_transactions qbt ON qbt.id = rm.qb_transaction_id
WHERE rm.user_id <> qbt.user_id;
```

**D. Orphan decision statement IDs**

```sql
SELECT rd.id, rd.statement_id
FROM public.reconciliation_decisions rd
LEFT JOIN public.bank_statements bs ON bs.id = rd.statement_id
WHERE bs.id IS NULL;
```

**E. Orphan audit rows / missing parent match**

```sql
SELECT ral.id, ral.reconciliation_match_id
FROM public.reconciliation_audit_log ral
LEFT JOIN public.reconciliation_matches rm ON rm.id = ral.reconciliation_match_id
WHERE rm.id IS NULL;
```

**F. Any other row shape that would cause a new FK to fail**

Including: `bank_transactions.statement_id` referencing a non-existent statement (should be impossible due to existing FK, verified); `reconciliation_matches.statement_id` referencing a non-existent statement; `reconciliation_matches.bank_transaction_id` referencing a non-existent bank transaction; `reconciliation_decisions.bank_transaction_id` referencing a non-existent bank transaction.

**Classification per finding:**

| Finding | Classification | Rationale |
|---|---|---|
| Cross-user child vs parent | **BLOCKER** — corruption; manual investigation required | Cannot "bless" by stamping parent's client; user ownership mismatch is a data integrity issue |
| Cross-statement bank transaction match | **BLOCKER** — corruption | Match claims a bank txn belongs to a statement it does not belong to |
| Cross-user QB match | **BLOCKER** — corruption | QB transaction owned by different user than the match |
| Orphan decision statement | Safe legacy orphan if statement was deleted (but statements have CASCADE FKs — should not exist). If found: **BLOCKER** | Indicates FK enforcement gap or manual DML |
| Orphan audit row (no parent match) | Expected preserved evidence if match was deleted before ON DELETE CASCADE removed. If match still exists: **BLOCKER** | Audit rows without a parent match after 012 are valid (SET NULL); pre-012 they should all have parents |

Any BLOCKER finding must be resolved before Migration 012 can proceed. Safe legacy orphans are counted and reported but do not block.

---

### Section 10 — Accurate database guarantee statement

**Database structurally guarantees (enforced by constraints, triggers, FKs):**

1. Stamped parent/child client consistency: composite FKs ensure child `(parent_id, client_entity_id)` matches parent `(id, client_entity_id)`.
2. Statement/transaction/match consistency: `fk_matches_statement_client`, `fk_matches_bank_txn_client`, `fk_matches_statement_bank_txn`.
3. Ledger/client consistency: `fk_bank_statements_ledger_client`, `fk_qb_transactions_ledger_client`.
4. QB/match same-client consistency: enforced by trigger (Section 5).
5. Non-NULL canonical stamps for new post-012 writes: enforced by write-guard triggers.
6. Immutable canonical stamps once set: enforced by immutability triggers.

**Application/RPC guarantees (enforced by server-side code and SECURITY DEFINER RPCs):**

1. `p_user_id`/`userId` is bound to canonical context through the self-context RPC.
2. Service-role writes through supported app/RPC paths resolve registry ownership with in-RPC validation.
3. Client-supplied canonical IDs are never authoritative; server resolves and validates.

**NOT guaranteed (explicitly out of scope):**

1. Direct arbitrary service-role DML remains a trusted-operator surface and can bypass the user→registry semantic binding unless separately constrained.
2. RLS bypass by service-role is architectural and not solved by Step 4.
3. The system is not globally tenant-safe after Step 4; the reconciliation spine is structurally same-client.

---

### Section 11 — NULL transition semantics (per-table)

| Table | Legacy NULL allowed after 012? | New NULL writes after 012? | UPDATE of existing NULL row allowed? | Trigger behavior |
|---|---|---|---|---|
| `bank_statements` | Yes (ineligible/orphan users) | No (write-guard rejects NULL on INSERT) | Yes, but `client_entity_id`/`ledger_book_id` immutable once set to non-NULL | INSERT guard + immutability on UPDATE OF stamp columns |
| `bank_transactions` | Yes (parent NULL or ineligible) | No (write-guard rejects NULL on INSERT) | Yes, stamp immutable once set | INSERT guard + immutability |
| `qb_transactions` | Yes (ineligible/orphan users) | No (write-guard rejects NULL on INSERT; also requires `ledger_book_id` NOT NULL) | Yes, stamps immutable once set | INSERT guard (both columns) + immutability |
| `reconciliation_matches` | Yes (parent NULL or ineligible) | No (write-guard rejects NULL on INSERT) | Yes, stamp immutable once set | INSERT guard + immutability |
| `reconciliation_reports` | Yes | No | Yes, stamp immutable once set | INSERT guard + immutability |
| `reconciliation_decisions` | Yes | No | Yes, stamp immutable once set | INSERT guard + immutability |
| `reconciliation_audit_log` | `client_entity_id`: Yes (legacy) ; `user_id`: NOT NULL always | `client_entity_id`: No; `user_id`: No (both required on INSERT) | `client_entity_id`/`user_id` immutable; `reconciliation_match_id` allowed SET NULL by FK | INSERT guard for both stamps; immutability on UPDATE OF stamps; FK SET NULL on match_id permitted |

**For `bank_statements` and `qb_transactions` specifically:**
New writes must require BOTH `client_entity_id NOT NULL` AND `ledger_book_id NOT NULL`. The INSERT guard checks both.

**For child tables:**
New writes must require `client_entity_id NOT NULL`. NULL-parent ⇒ NULL-child is legacy state only, not a supported write path after 012.

---

### Section 12 — FK validation mode (single, consistent)

Use plain `ADD CONSTRAINT` with immediate validation inside the one migration transaction. This validates all existing rows against the new FK at creation time. For current small production tables and frozen window, this is safe and atomic.

`NOT VALID` + `VALIDATE CONSTRAINT` is documented only as a future scaling alternative if a later migration adds FKs to tables too large for a single-transaction scan. It is NOT part of Migration 012.

Rationale: the prior design contradicted itself by saying both "plain ADD CONSTRAINT" and "NOT VALID + VALIDATE CONSTRAINT in same migration." The contradiction is removed. Immediate validation is the only mode.

---

### Section 13 — Restore drill (adversarial staging)

Free-tier backup remains:
- `schema.sql`, `data.sql`, `migration-schema.sql`, `migration-data.sql`
- SHA-256 for all four artifacts
- Disposable compatible restore

**Additional required adversarial test:**

After restoring the fresh pre-012 production backup into the disposable environment:

1. Apply the exact Migration 012 artifact.
2. Verify Migration 012 completes without error.
3. Classification counts match production preflight (within ±0).
4. Backfill counts match expectation.
5. All FKs validate (no violations).
6. All triggers/functions install.
7. B1–B9 invariants pass.
8. Migration ledger becomes 012 in the restored test environment.

**Additional preflight snapshots (before production apply):**
- `default_tenant_identities` row count.
- Auth user eligibility/classification counts per class.
- Row counts per spine table.
- Record all counts in the runbook; any post-012 deviation is investigated.

---

### Section 14 — Audit user FK semantics

`reconciliation_audit_log.user_id` references `auth.users(id)`.

**Chosen: ON DELETE RESTRICT.**

Justification:
- Accounting evidence must not disappear when an auth user is deleted. ON DELETE CASCADE would silently destroy audit history.
- RESTRICT means a user cannot be deleted while they have audit rows. This is the safest default for an evidence ledger.
- If user deletion becomes necessary, audit rows must be addressed first (anonymize, reassign, or archive).
- `user_id` is stored as an immutable UUID on the audit row. Even if the referenced auth user is eventually deleted (after clearing the FK), the UUID remains as frozen evidence of who performed the action.
- NO ACTION has identical runtime behavior to RESTRICT in PostgreSQL when the FK is not DEFERRABLE. RESTRICT is preferred for clarity of intent.

If `RESTRICT` is too restrictive for the pilot, the fallback is:
- Remove the FK entirely.
- Keep `user_id` as an immutable UUID evidence column (no FK, no CASCADE, no RESTRICT).
- The write-guard trigger still requires `user_id NOT NULL` on INSERT.
- The RLS policy `USING (auth.uid() = user_id)` still scopes reads.

This is documented as a conscious tradeoff. For Migration 012, RESTRICT is the default.

---

### Section 15 — Trigger installation order

Exact sequence within Migration 012. No trigger may block Migration 012's own backfill:

1. Add columns (all nullable; `reconciliation_audit_log.user_id` is **nullable** at this point).
2. Classify users / determine backfill targets (read-only).
3. Bootstrap genuinely-missing eligible users (one-time; under advisory locks).
4. Backfill all seven tables (UPDATE from anchors/registry; includes audit `user_id` from parent match).
5. **Verify all audit rows have `user_id`** — RAISE if any NULL remains.
6. **SET NOT NULL on `reconciliation_audit_log.user_id`** (only after step 5 passes).
7. Validate backfill data (B1–B9 checks; raise on conflict).
8. Create parent unique indexes (`uk_bank_statements_id_client`, `uk_bank_transactions_id_client`, `uk_bank_transactions_statement_id`, `uk_qb_transactions_id_client`).
9. Add composite FKs (all constraint DDL updated per Sections 4/5/17).
10. Add audit log FK redesign (drop old CASCADE FK, add SET NULL FK on `reconciliation_match_id`).
11. Add `reconciliation_audit_log.user_id` FK to `auth.users(id) ON DELETE RESTRICT` (only after NOT NULL is set and rows are backfilled).
12. Install same-client guard triggers (audit log same-client, match QB same-client).
13a. Install write-guard functions (`require_reconciliation_client_stamp_v1`, `require_reconciliation_root_stamp_v1`, `audit_log_write_guard_v1`).
13b. Install write-guard triggers (root tables get root guard; child tables get client guard; audit log gets dedicated guard).
14. Install immutability triggers (UPDATE OF stamp columns on all seven tables; audit evidence immutability; audit no-delete).
15. Install audit RLS/ACL (Z12): drop old policy, create FOR SELECT only, REVOKE DML from authenticated, REVOKE ALL from anon.
16. Install/replace RPCs (`canonical_default_tenant_context_for_self_v1`, `canonical_default_tenant_ids_v1`, CREATE OR REPLACE ingestion RPCs).
17. Install read-path indexes.
18. Final invariant checks (B1–B11 re-verified post-trigger installation).
19. Migration journaling (write `migration_runtime_log` row).
20. `NOTIFY pgrst, 'reload schema'`.

---

### Section 16 — Now-eligible-later users (lifecycle gap)

Scenario: user is INELIGIBLE at Migration 012 time (e.g., unconfirmed), has legacy NULL-stamped rows, later becomes eligible (confirms email, logs in, bootstrap succeeds), but old legacy rows remain NULL and invisible to canonical queries.

**Design decision:**
- Do NOT silently repair this in ordinary read requests. The self-context RPC does not backfill.
- Do NOT backfill in the login bootstrap path (that would couple login to a data migration).
- Legacy rows for users ineligible at 012 remain quarantined (NULL stamps) until explicitly canonicalized.
- Define a controlled canonicalization path for future use: a separate admin/migration operation that reclassifies and backfills rows for now-eligible users.
- Document this as deferred future behavior (`ELIGIBLE_AFTER_012` class in a future migration).

**Preflight requirement:**
- Count how many legacy rows belong to INELIGIBLE users.
- If the count is zero (all current users are eligible), this is a non-blocking deferred concern.
- If the count is non-zero, the pilot must decide: accept quarantined rows as known debt, or expand eligibility before 012.
- Record the count in the runbook.

---

### Section 17 — Reconciliation decision cascade

Current 005 state: `reconciliation_decisions` has no FK to `bank_statements`. The original 4B design proposed adding:

```sql
ALTER TABLE public.reconciliation_decisions ADD CONSTRAINT fk_decisions_statement_client
  FOREIGN KEY (statement_id, client_entity_id) REFERENCES public.bank_statements(id, client_entity_id) ON DELETE CASCADE;
```

**Revised: ON DELETE RESTRICT.**

Justification:
- Decisions are learning/evidence data. If statement deletion becomes possible later, CASCADE would silently destroy decision history.
- RESTRICT prevents statement deletion while decisions reference it.
- If statement deletion is needed, decisions must be addressed first (archived, or their statement pointer SET NULL).
- The audit log already preserves the decision trail with snapshot stamps (SET NULL on match pointer), but the decision rows themselves should not be silently destroyed.
- Alternative considered and rejected: SET NULL + snapshot fields. This would require making `statement_id` nullable and adding snapshot `user_id`/`client_entity_id` columns to decisions that survive NULLing. This adds complexity for a scenario (statement deletion) that does not currently exist in the app. Revisit when statement deletion is implemented.

The composite FK `(statement_id, client_entity_id)` with RESTRICT also means: a statement cannot be deleted if decisions reference it, and a decision's `client_entity_id` must match its statement's. Both are correct accounting semantics.

---

### Section 18 — Old-shape RPC early return (validation ordering)

Both ingestion RPCs (`ingest_bank_statement_v1`, `ingest_accounting_transactions_v1`) must perform canonical ownership validation BEFORE any artifact-reuse / idempotent early-return branch.

Current code pattern (conceptual):
```
1. Parse input
2. Check idempotency key / artifact reuse → if exists, return existing
3. Validate canonical context
4. Insert
```

Step 4C must reorder to:
```
1. Parse input
2. Validate canonical context (ownership, supplied IDs vs registry) — FAIL CLOSED here
3. Check idempotency key / artifact reuse → if exists, return existing
4. Insert
```

An old-shape call without canonical keys must fail at step 2 even if the artifact already exists (step 3 would have returned it). This prevents an un-migrated caller from successfully ingesting data with NULL canonical stamps just because the artifact was previously ingested.

Tests required:
- Old-shape RPC call (no canonical keys in JSON) against an artifact that already exists → fail-closed error, zero rows.
- Old-shape RPC call against a new artifact → fail-closed error, zero rows.
- New-shape RPC call with valid canonical context against existing artifact → returns existing artifact, zero new rows.
- New-shape RPC call with valid canonical context against new artifact → succeeds with correct stamps.

---

### Section 19 — Complete test matrix

Tests marked **[NEW]** are additions from the adversarial review.

#### 19.1 Self-context RPC tests

- [NEW] Authenticated user returns own four canonical IDs
- [NEW] Authenticated call produces zero `canonical_audit_ledger` rows (count before/after)
- [NEW] Rejects missing `auth.uid()` (anon call)
- [NEW] `anon` cannot EXECUTE
- [NEW] `service_role` cannot EXECUTE (or returns controlled error)
- [NEW] Missing registry raises error, not zero rows
- [NEW] Incomplete registry raises error
- [NEW] Practice ownership validation fails → error (practice not owned by caller)
- [NEW] Membership validation fails → error (not owner, not active, valid_to set)
- [NEW] Client validation fails → error (not active, archived, wrong practice)
- [NEW] Ledger validation fails → error (not internal, not active, archived, wrong client)
- [NEW] No audit delta on request-time tenant resolution
- [NEW] Exact contract pinned in Migration 012 contract test

#### 19.2 FK SET NULL vs audit triggers

- [NEW] Legacy audit row with NULL `client_entity_id` survives delete of parent match
- [NEW] Delete parent match → `reconciliation_match_id` becomes NULL; `user_id`/`client_entity_id` unchanged
- [NEW] Evidence columns unchanged after FK SET NULL
- [NEW] Audit row with snapshot stamps survives after match deletion (SET NULL pointer, not CASCADE evidence)

#### 19.3 QB same-client enforcement

- [NEW] Insert match with QB transaction from client A and `client_entity_id` from client B → trigger rejection
- [NEW] Update match's `qb_transaction_id` to point to different-client QB transaction → trigger rejection
- [NEW] Delete QB transaction → match's `qb_transaction_id` becomes NULL, `client_entity_id` preserved

#### 19.4 Invoice-match freeze and stamping

- [NEW] `POST /api/reconciliation/[id]/invoice-match` returns 503 when freeze active
- [NEW] `recordDecision` stamps `client_entity_id` on inserted decision row
- [NEW] Decision row `client_entity_id` matches `TenantContext.clientEntityId`

#### 19.5 Cross-user / cross-statement preflight checks

- [NEW] Cross-user child vs parent statement detected in preflight (per table)
- [NEW] Cross-statement bank transaction match detected in preflight
- [NEW] Cross-user QB match detected in preflight
- [NEW] Orphan decision statement IDs detected
- [NEW] Orphan audit rows detected and classified

#### 19.6 Classifier parity

- [NEW] Preflight classification query and migration classification query produce identical results on same data
- [NEW] All five classes represented; OTHER BLOCKER includes incomplete registry

#### 19.7 Now-eligible-later lifecycle

- [NEW] Preflight counts legacy rows belonging to INELIGIBLE users
- [NEW] INELIGIBLE user's rows remain NULL after 012
- [NEW] INELIGIBLE user later becomes eligible, logs in, bootstraps → old rows still NULL (quarantined)
- [NEW] Self-context RPC does not backfill legacy rows on read

#### 19.8 Old-shape RPC reused-artifact path

- [NEW] Old-shape RPC call (no canonical keys) against existing artifact → fail-closed, zero rows
- [NEW] Old-shape RPC call against new artifact → fail-closed, zero rows
- [NEW] New-shape RPC with valid context against existing artifact → reuse success, zero new rows

#### 19.9 Statement/QB ledger_book_id non-NULL new-write enforcement

Superseded by Section 19.10a (R1–R14). The original two-line test is expanded to 14 explicit per-table, per-stamp assertions covering both root-table and child-table write guards.

#### 19.10 Audit user deletion semantics

- [NEW] Attempt to delete `auth.users` row that has audit log rows → RESTRICT rejection
- [NEW] Audit row `user_id` FK is RESTRICT (verified in information_schema)

#### 19.10a Root-table ledger_book_id write guard [PATCH 2]

- [NEW] R1: INSERT `bank_statements` with `client_entity_id` set, `ledger_book_id` NULL → REJECTED
- [NEW] R2: INSERT `bank_statements` with `ledger_book_id` set, `client_entity_id` NULL → REJECTED
- [NEW] R3: INSERT `bank_statements` with both stamps NULL → REJECTED
- [NEW] R4: INSERT `bank_statements` with both stamps valid → SUCCESS
- [NEW] R5: INSERT `qb_transactions` with `client_entity_id` set, `ledger_book_id` NULL → REJECTED
- [NEW] R6: INSERT `qb_transactions` with `ledger_book_id` set, `client_entity_id` NULL → REJECTED
- [NEW] R7: INSERT `qb_transactions` with both stamps NULL → REJECTED
- [NEW] R8: INSERT `qb_transactions` with both stamps valid → SUCCESS
- [NEW] R9: INSERT `bank_transactions` with `client_entity_id` NULL → REJECTED (child guard)
- [NEW] R10: INSERT `bank_transactions` with `client_entity_id` valid → SUCCESS
- [NEW] R11: INSERT `reconciliation_matches` with `client_entity_id` NULL → REJECTED
- [NEW] R12: INSERT `reconciliation_matches` with `client_entity_id` valid → SUCCESS
- [NEW] R13: INSERT `reconciliation_reports` with `client_entity_id` NULL → REJECTED
- [NEW] R14: INSERT `reconciliation_decisions` with `client_entity_id` NULL → REJECTED

#### 19.10b Audit log ACL/RLS [PATCH 2]

- [NEW] A1: `authenticated` SELECT own audit rows (`user_id = auth.uid()`) → rows returned
- [NEW] A2: `authenticated` SELECT audit rows where `user_id <> auth.uid()` → zero rows (RLS filter)
- [NEW] A3: `authenticated` INSERT into `reconciliation_audit_log` → REJECTED (permission denied)
- [NEW] A4: `authenticated` UPDATE on `reconciliation_audit_log` → REJECTED (permission denied)
- [NEW] A5: `authenticated` DELETE from `reconciliation_audit_log` → REJECTED (permission denied)
- [NEW] A6: `anon` SELECT from `reconciliation_audit_log` → REJECTED (permission denied)
- [NEW] A7: `anon` INSERT/UPDATE/DELETE on `reconciliation_audit_log` → REJECTED
- [NEW] A8: `service_role` INSERT audit row with valid `user_id`, `client_entity_id`, `reconciliation_match_id` (same-client) → SUCCESS
- [NEW] A9: `service_role` INSERT audit row with valid `user_id`, `client_entity_id`, NULL `reconciliation_match_id` → SUCCESS (trusted-operator surface)
- [NEW] A10: `service_role` INSERT audit row with NULL `user_id` → REJECTED (`audit_log_write_guard_v1` raises)
- [NEW] A11: `service_role` INSERT audit row with NULL `client_entity_id` → REJECTED (`audit_log_write_guard_v1` raises)
- [NEW] A12: `service_role` UPDATE audit evidence columns (`action`, `action_by`, etc.) → REJECTED (immutability trigger)
- [NEW] A13: `service_role` DELETE audit row → REJECTED (no-delete trigger)
- [NEW] A14: Existing app audit insert path (`reconciliation-store.ts` approveMatches) → SUCCESS
- [NEW] A15: Existing app audit insert path (`reconciliation-store.ts` revertMatches) → SUCCESS

#### 19.11 Restored pre-012 backup + exact 012 apply

- [NEW] Restore pre-012 production backup into disposable environment
- [NEW] Apply exact Migration 012 artifact
- [NEW] Migration 012 completes without error
- [NEW] Classification counts match production preflight
- [NEW] Backfill counts match expectation
- [NEW] All FKs validate
- [NEW] All triggers/functions install
- [NEW] B1–B11 invariants pass
- [NEW] Migration ledger shows 012

#### 19.12 Audit user_id backfill ordering

- [NEW] `reconciliation_audit_log.user_id` added as nullable (verified in information_schema before backfill)
- [NEW] Backfill populates `user_id` from parent match for all rows with a live match
- [NEW] Orphan audit rows (no parent match) detected and classified per approved policy
- [NEW] `SET NOT NULL` succeeds only after every row has `user_id`
- [NEW] Attempt to set NOT NULL with NULL rows remaining → error
- [NEW] `user_id` FK to `auth.users(id)` added only after NOT NULL

#### 19.13 Stamp transition semantics (immutability trigger)

- [NEW] NULL `client_entity_id` → canonical UUID: succeeds (backfill / first stamp)
- [NEW] NULL `ledger_book_id` → canonical UUID: succeeds
- [NEW] Canonical UUID A → same canonical UUID A: succeeds (no-op)
- [NEW] Canonical UUID A → different canonical UUID B: rejected
- [NEW] Canonical UUID A → NULL: rejected
- [NEW] `ledger_book_id` equivalent cases: value → different rejected; value → NULL rejected
- [NEW] Migration 012 backfill (NULL → value on legacy rows) succeeds
- [NEW] Rerun-idempotency (value → same value) succeeds

#### 19.14 Existing tests (unchanged from original design)

- 011 contract suite unchanged (hashes pinned)
- 012 contract: atomic/additive assertions, B1–B9, audit-noise, freeze-trigger, FK-violation probes
- Rerun-idempotency: re-execute 012 backfill → zero entity changes, zero new audit rows
- Conflict test: wrong non-NULL stamp → 012 RAISE
- Tenant-context unit tests: `resolveTenantContext` calls only read-only RPC
- Freeze tests: 503 with flag on; unchanged with flag off
- App: `npm run typecheck`, full vitest suite green
- Backup-restore drill automated

#### 19.13 Adversarial staging (unchanged from original design S.1–S.13)

All 13 adversarial probes from the original design Section S remain required, plus the additions above.

---

### Section 20 — Audit log ACL/RLS (immutable evidence privilege model)

**Problem (Patch 2, 2026-08-12):** Z12 proposed `FOR ALL` policy with `auth.uid() = user_id` check. An authenticated user could INSERT a fabricated immutable audit row:

- Set `user_id = auth.uid()` (passes WITH CHECK)
- Set `reconciliation_match_id = NULL` (evades same-client guard which requires non-NULL match pointer)
- Set arbitrary `action`, `action_by`, `action_at`, evidence fields, and `client_entity_id`

This is unacceptable for accounting evidence being promoted to immutable in Migration 012.

**Current state (Migration 003, verified):**
```sql
CREATE POLICY "Users can only access their own audit log"
  ON public.reconciliation_audit_log FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.reconciliation_matches
      WHERE reconciliation_matches.id = reconciliation_audit_log.reconciliation_match_id
        AND reconciliation_matches.user_id = auth.uid()
    )
  );
```

**Current server-side write path (verified):** `zakiledger/lib/supabase.ts:19` — `getSupabase()` uses `SUPABASE_SERVICE_ROLE_KEY`. All audit inserts in `reconciliation-store.ts:947,1009` go through `service_role`. No authenticated-user DML on audit log is ever performed by the application.

**Corrected design:**

```sql
-- =========================================================================
-- reconciliation_audit_log — privilege model (immutable accounting evidence)
-- =========================================================================

-- Step 1. Drop the old FOR ALL policy (both the existing 003 shape and the
-- proposed 012 shape — either may be present depending on prior migration state)
DROP POLICY IF EXISTS "Users can only access their own audit log"
  ON public.reconciliation_audit_log;

-- Step 2. Read-only SELECT policy: authenticated may read own audit rows only.
-- A user sees audit rows where they are the recorded actor (user_id).
CREATE POLICY "Users can read their own audit log"
  ON public.reconciliation_audit_log FOR SELECT
  USING (auth.uid() = user_id);

-- Step 3. Revoke direct DML from authenticated.
-- Immutable evidence MUST NOT be writable through the authenticated role.
-- All audit inserts happen through the trusted server/service_role path
-- (zakiledger/lib/reconciliation-store.ts uses SUPABASE_SERVICE_ROLE_KEY).
REVOKE INSERT, UPDATE, DELETE ON public.reconciliation_audit_log FROM authenticated;

-- Step 4. anon gets no audit access of any kind (belt-and-suspenders).
REVOKE ALL ON public.reconciliation_audit_log FROM anon;

-- Step 5. service_role retains full access (default Supabase grants).
-- No explicit GRANT needed; service_role bypasses RLS by design.
-- Immutability triggers (Section 4) remain the DB-level backstop against
-- any misconfigured service_role write path.

-- Step 6. Immutability triggers (unchanged from Section 4):
--   - audit_log_write_guard_v1:      BEFORE INSERT  → user_id + client_entity_id NOT NULL
--   - audit_log_stamp_immutable_v1:  BEFORE UPDATE OF client_entity_id, user_id
--   - audit_log_evidence_immutable_v1: BEFORE UPDATE OF action, action_by, action_at,
--                                      old_confidence, new_confidence  → RAISE
--   - audit_log_no_delete:           BEFORE DELETE  → RAISE
```

**Behavioral contract:**

| Actor | SELECT own | SELECT other's | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| `authenticated` (own rows) | ALLOWED | — | REJECTED | REJECTED | REJECTED |
| `authenticated` (other's rows) | — | REJECTED | REJECTED | REJECTED | REJECTED |
| `anon` | REJECTED | REJECTED | REJECTED | REJECTED | REJECTED |
| `service_role` (valid path) | ALLOWED | ALLOWED | ALLOWED (through reviewed app code + trigger backstop) | REJECTED (immutability triggers, except `reconciliation_match_id` SET NULL) | REJECTED (no-delete trigger) |
| `service_role` (invalid same-client) | — | — | REJECTED (write-guard trigger: user_id + client_entity_id NOT NULL) | — | — |

**Rationale:**
- `reconciliation_audit_log` is promoted to immutable accounting evidence in Migration 012.
- A `FOR ALL` RLS policy with `auth.uid() = user_id` is a self-consistency wall, not a proof-of-legitimacy wall. It proves the caller set `user_id` to themselves — not that the event actually happened.
- The only trusted audit writer is the application server operating under `service_role`, which resolves canonical context through reviewed RPCs and validates cross-entity consistency before inserting.
- The immutability triggers are a backstop, not the primary defense. The primary defense is: authenticated cannot write at all.
- Existing application audit inserts (`reconciliation-store.ts:947,1009`) use `service_role` and are unaffected.

---


---

## 3. Final unified Migration 012 specification

One transaction, `supabase/migrations/012_reconciliation_canonical_tenant_spine.sql`.

### Z1. Additive columns

```sql
ALTER TABLE public.bank_statements
  ADD COLUMN client_entity_id uuid,
  ADD COLUMN ledger_book_id uuid;

ALTER TABLE public.bank_transactions
  ADD COLUMN client_entity_id uuid;

ALTER TABLE public.qb_transactions
  ADD COLUMN client_entity_id uuid,
  ADD COLUMN ledger_book_id uuid;

ALTER TABLE public.reconciliation_matches
  ADD COLUMN client_entity_id uuid;

ALTER TABLE public.reconciliation_reports
  ADD COLUMN client_entity_id uuid;

ALTER TABLE public.reconciliation_decisions
  ADD COLUMN client_entity_id uuid;

ALTER TABLE public.reconciliation_audit_log
  ADD COLUMN client_entity_id uuid,
  ADD COLUMN user_id uuid;  -- nullable initially; backfilled, then SET NOT NULL
```

### Z2. Classify and bootstrap (read-only + RPC calls)

Per the unified classifier (Section 7) and legacy user universe (Section 8). Bootstrap only ELIGIBLE + REGISTRY MISSING users under advisory lock with absence re-check.

### Z3. Backfill

Per original design Section G (three-case rule: NULL → backfill, correct → leave, conflicting → RAISE). Updated to use the unified classifier and full seven-table universe.

**Audit log backfill (MUST precede SET NOT NULL on user_id):**

```sql
-- Backfill reconciliation_audit_log.user_id from parent match
UPDATE public.reconciliation_audit_log ral
SET user_id = rm.user_id
FROM public.reconciliation_matches rm
WHERE ral.reconciliation_match_id = rm.id
  AND ral.user_id IS NULL;

-- STOP if any audit row cannot be resolved (orphan without parent match).
-- Orphan audit rows without a resolvable parent match are classified per
-- the orphan-audit rule (Section 9.E): BLOCKER if match still exists;
-- expected preserved evidence if match was deleted.
-- In either case the row must have a user_id before SET NOT NULL can run.
-- If any ral.user_id IS NULL row remains at this point, RAISE EXCEPTION.

-- Verify
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reconciliation_audit_log WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'NO-GO: audit rows with unresolvable user_id'
      USING HINT = 'Resolve orphan audit rows before retrying';
  END IF;
END $$;
```

### Z4. Parent unique indexes

```sql
CREATE UNIQUE INDEX uk_bank_statements_id_client ON public.bank_statements (id, client_entity_id);
CREATE UNIQUE INDEX uk_bank_transactions_id_client ON public.bank_transactions (id, client_entity_id);
CREATE UNIQUE INDEX uk_bank_transactions_statement_id ON public.bank_transactions (statement_id, id);
CREATE UNIQUE INDEX uk_qb_transactions_id_client ON public.qb_transactions (id, client_entity_id);
```

### Z5. Composite FKs

All FKs use `ADD CONSTRAINT` with immediate validation. Per Sections 4, 5, 12, 14, 17.

```sql
-- bank_transactions → bank_statements
ALTER TABLE public.bank_transactions ADD CONSTRAINT fk_bank_transactions_statement_client
  FOREIGN KEY (statement_id, client_entity_id) REFERENCES public.bank_statements(id, client_entity_id) ON DELETE CASCADE;

-- bank_statements → ledger_books, client_entities
ALTER TABLE public.bank_statements ADD CONSTRAINT fk_bank_statements_ledger_client
  FOREIGN KEY (ledger_book_id, client_entity_id) REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT;
ALTER TABLE public.bank_statements ADD CONSTRAINT fk_bank_statements_client
  FOREIGN KEY (client_entity_id) REFERENCES public.client_entities(id) ON DELETE RESTRICT;

-- qb_transactions → ledger_books, client_entities
ALTER TABLE public.qb_transactions ADD CONSTRAINT fk_qb_transactions_ledger_client
  FOREIGN KEY (ledger_book_id, client_entity_id) REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT;
ALTER TABLE public.qb_transactions ADD CONSTRAINT fk_qb_transactions_client
  FOREIGN KEY (client_entity_id) REFERENCES public.client_entities(id) ON DELETE RESTRICT;

-- reconciliation_matches → bank_statements, bank_transactions
ALTER TABLE public.reconciliation_matches ADD CONSTRAINT fk_matches_statement_client
  FOREIGN KEY (statement_id, client_entity_id) REFERENCES public.bank_statements(id, client_entity_id) ON DELETE CASCADE;
ALTER TABLE public.reconciliation_matches ADD CONSTRAINT fk_matches_bank_txn_client
  FOREIGN KEY (bank_transaction_id, client_entity_id) REFERENCES public.bank_transactions(id, client_entity_id) ON DELETE CASCADE;
ALTER TABLE public.reconciliation_matches ADD CONSTRAINT fk_matches_statement_bank_txn
  FOREIGN KEY (statement_id, bank_transaction_id) REFERENCES public.bank_transactions(statement_id, id) ON DELETE CASCADE;

-- reconciliation_reports → bank_statements
ALTER TABLE public.reconciliation_reports ADD CONSTRAINT fk_reports_statement_client
  FOREIGN KEY (statement_id, client_entity_id) REFERENCES public.bank_statements(id, client_entity_id) ON DELETE CASCADE;

-- reconciliation_decisions → bank_statements (RESTRICT, per Section 17)
ALTER TABLE public.reconciliation_decisions ADD CONSTRAINT fk_decisions_statement_client
  FOREIGN KEY (statement_id, client_entity_id) REFERENCES public.bank_statements(id, client_entity_id) ON DELETE RESTRICT;
```

### Z6. Audit log redesign (ordered)

```sql
-- Step 6a. Make match pointer nullable
ALTER TABLE public.reconciliation_audit_log ALTER COLUMN reconciliation_match_id DROP NOT NULL;

-- Step 6b. Drop old CASCADE FK
ALTER TABLE public.reconciliation_audit_log DROP CONSTRAINT IF EXISTS reconciliation_audit_log_reconciliation_match_id_fkey;

-- Step 6c. Add SET NULL FK on match pointer
ALTER TABLE public.reconciliation_audit_log ADD CONSTRAINT fk_audit_log_match
  FOREIGN KEY (reconciliation_match_id) REFERENCES public.reconciliation_matches(id) ON DELETE SET NULL;

-- Step 6d. Backfill user_id (must precede SET NOT NULL; see Z3 audit backfill above)

-- Step 6e. SET NOT NULL on user_id (only after every row has a user_id)
ALTER TABLE public.reconciliation_audit_log ALTER COLUMN user_id SET NOT NULL;

-- Step 6f. Add user_id FK (RESTRICT, per Section 14)
ALTER TABLE public.reconciliation_audit_log ADD CONSTRAINT fk_audit_log_user
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
```

### Z7. QB same-client guard

Unique index + validation trigger per Section 5.

### Z8. Write-guard triggers

Two explicit guard functions per corrected Section 4:

```sql
-- A. Child-table guard: requires client_entity_id NOT NULL on INSERT.
CREATE OR REPLACE FUNCTION public.require_reconciliation_client_stamp_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.client_entity_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical client_entity_id'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- B. Root-table guard: requires BOTH client_entity_id AND ledger_book_id NOT NULL on INSERT.
CREATE OR REPLACE FUNCTION public.require_reconciliation_root_stamp_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.client_entity_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical client_entity_id'
        USING ERRCODE = '23502';
    END IF;
    IF NEW.ledger_book_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical ledger_book_id'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Trigger attachments
CREATE TRIGGER write_guard_root_stamp
  BEFORE INSERT ON public.bank_statements
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_root_stamp_v1();

CREATE TRIGGER write_guard_root_stamp
  BEFORE INSERT ON public.qb_transactions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_root_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_reports
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

-- Audit log: dedicated guard (unchanged from Section 4)
CREATE TRIGGER audit_log_write_guard
  BEFORE INSERT ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_write_guard_v1();
```

### Z9. Immutability triggers

UPDATE OF stamp columns on all seven tables + audit evidence immutability + audit no-delete per Section 4.

### Z10. RPCs

- `canonical_default_tenant_context_for_self_v1()` — per Section 3 (one authoritative body).
- `canonical_default_tenant_ids_v1(p_user_id uuid)` — service-only helper; returns the four registry IDs; RAISE if missing/incomplete.
- `CREATE OR REPLACE` both ingestion RPCs with validation-before-idempotency ordering (Section 18).

### Z11. Read-path indexes

Per original design Section C8.

### Z12. Audit log privilege model (immutable accounting evidence)

```sql
-- =========================================================================
-- Z12. Audit log privilege model (immutable accounting evidence)
-- =========================================================================

-- Step 1. Drop the old FOR ALL policy (both the existing 003 shape and any
-- prior 012 draft — either may be present depending on migration state)
DROP POLICY IF EXISTS "Users can only access their own audit log"
  ON public.reconciliation_audit_log;

-- Step 2. Read-only SELECT policy: authenticated may read own audit rows only.
-- A user sees audit rows where they are the recorded actor (user_id).
CREATE POLICY "Users can read their own audit log"
  ON public.reconciliation_audit_log FOR SELECT
  USING (auth.uid() = user_id);

-- Step 3. Revoke direct DML from authenticated.
-- Immutable evidence MUST NOT be writable through the authenticated role.
-- All audit inserts happen through the trusted server/service_role path
-- (zakiledger/lib/reconciliation-store.ts uses SUPABASE_SERVICE_ROLE_KEY).
REVOKE INSERT, UPDATE, DELETE ON public.reconciliation_audit_log FROM authenticated;

-- Step 4. anon gets no audit access of any kind (belt-and-suspenders).
REVOKE ALL ON public.reconciliation_audit_log FROM anon;

-- Step 5. service_role retains full access (default Supabase grants).
-- No explicit GRANT needed; service_role bypasses RLS by design.
-- Immutability triggers (Section 4) remain the DB-level backstop against
-- any misconfigured service_role write path.
```

### Z13. End-of-migration assertions

B1–B11 re-verified post-trigger-install. Migration journaling row written. `NOTIFY pgrst, 'reload schema'`.

**B10 — Root-table write guard trigger existence:**
```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'write_guard_root_stamp'
      AND event_object_table = 'bank_statements'
  ) THEN
    RAISE EXCEPTION 'Missing write_guard_root_stamp on bank_statements';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'write_guard_root_stamp'
      AND event_object_table = 'qb_transactions'
  ) THEN
    RAISE EXCEPTION 'Missing write_guard_root_stamp on qb_transactions';
  END IF;
END $$;
```

**B11 — Audit log authenticated DML blocked:**
```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_name = 'reconciliation_audit_log'
      AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'authenticated must not have INSERT/UPDATE/DELETE on reconciliation_audit_log';
  END IF;
END $$;
```

---

## 4. Updated production deployment sequence

Unchanged from original Section N/O/P except:

1. **Phase 1 freeze scope** includes `POST /api/reconciliation/[id]/invoice-match` (Section 6).
2. **Preflight** uses the unified classifier (Section 7) and includes all integrity checks (Section 9).
3. **Restore drill** includes adversarial 012 apply test (Section 13).
4. **Preflight snapshots** include `default_tenant_identities` count, eligibility counts, per-table row counts.

Sequence:

1. Step 4C code green locally; 012 artifact frozen with reviewed SHA; staging adversarial suite green.
2. **Preflight** (read-only, freeze NOT yet enabled):
   - Capture SHA-256 of Migration 010/011 working-tree files.
   - Run unified classifier → record counts per class.
   - Run integrity checks (Section 9) → zero BLOCKER findings.
   - Capture `default_tenant_identities` row count, eligibility counts, per-table row counts.
   - Capture backup dumps (schema, data, migration-schema, migration-data) + SHA-256.
   - Execute restore drill into disposable environment.
   - Execute adversarial staging (apply 012 to restored backup, verify all gates).
3. **Phase 1 deploy**: freeze-capable app (backward compatible, flag off).
4. **Phase 2**: enable freeze (`ZAKI_RECONCILIATION_WRITE_FREEZE=1`); verify all mutation endpoints (including `/invoice-match`) return 503; verify read routes 200; pause scheduler; verify no in-flight writes.
5. **Phase 3**: apply Migration 012; run postchecks (U1–U4).
6. **Phase 4**: deploy 4C app.
7. **Phase 5**: read-only smoke → controlled write smoke → stamp verification → cross-tenant probes.
8. All gates pass: disable freeze, redeploy, resume scheduler.

---

## 5. Updated test matrix

See Section 19 for complete matrix. Summary of NEW tests:

| Category | Count | Key additions |
|---|---|---|
| Self-context RPC contract | 12 | Exact error contract, graph validation failures, no audit delta |
| FK SET NULL vs triggers | 4 | Legacy NULL audit row survives match delete |
| QB same-client | 3 | Cross-client QB match rejected |
| Invoice-match freeze | 3 | 503 on freeze, canonical stamp on decision |
| Cross-user preflight | 5 | Per-table cross-user, cross-statement, orphan detection |
| Classifier parity | 2 | Preflight = migration classifier |
| Now-eligible-later | 4 | Quarantine behavior, preflight count |
| Old-shape RPC | 4 | Validation before artifact reuse |
| ledger_book_id write guard | 14 | Root tables require both stamps; child tables require client_entity_id only (R1–R14) |
| Audit ACL/RLS | 15 | authenticated SELECT own OK, authenticated INSERT/UPDATE/DELETE rejected, service_role write path OK (A1–A15) |
| Audit user FK | 2 | RESTRICT semantics |
| Restore + 012 apply | 8 | Full adversarial staging |
| Audit user_id backfill order | 6 | Nullable add → backfill → NOT NULL → FK |
| Stamp transition semantics | 8 | NULL→value succeeds; value→different rejects; value→NULL rejects |
| Migration B-checks | 2 | B10 root guard existence, B11 audit DML revoked |
| **Total NEW** | **92** | |

Plus all existing tests from original design (011 contract, 012 contract, rerun-idempotency, conflict, tenant-context, freeze, typecheck, vitest, backup-restore, 13 adversarial probes).

---

## 6. Remaining risks after Step 4

Unchanged from original Section Y, plus:

10. **Now-eligible-later quarantine**: users ineligible at 012 time who later become eligible will have legacy rows with NULL stamps. These rows are invisible to canonical queries until a future explicit canonicalization pass. If the preflight shows zero such rows, this is deferred; if non-zero, the pilot must accept it as known debt.
11. **Audit user FK RESTRICT**: prevents auth user deletion while audit rows exist. If user deletion is required before a cleanup path exists, the FK must be dropped (keeping the UUID as evidence without referential integrity).
12. **Decision RESTRICT**: prevents statement deletion while decisions reference it. Acceptable because statement deletion is not a current feature.
13. **Trusted-operator surface on audit NULL-match inserts**: `service_role` can insert an audit row with `reconciliation_match_id = NULL` and arbitrary evidence fields. The same-client validation trigger cannot guard a NULL match pointer. This is accepted because `service_role` is the trusted server path; the alternative (adding a cryptographic chain-of-custody per audit row with merkle proofs) is out of scope for Step 4. The immutability triggers prevent post-hoc tampering. Audit integrity relies on the server-side code path being the only writer, enforced by the REVOKE from authenticated.
14. **Audit authenticated DML enforcement depends on REVOKE**: The design relies on `REVOKE INSERT, UPDATE, DELETE ON reconciliation_audit_log FROM authenticated` to prevent direct user fabrication. If a future migration or manual DBA action grants these back, the protection is silently lost. PostgreSQL REVOKE is not a constraint and can be overridden by any superuser or migration author. Acceptable because the same trust boundary already applies to all schema objects.

---

## 7. Final decision

**DESIGN READY FOR STEP 4C IMPLEMENTATION**

All 19 findings resolved (17 adversarial review + 2 Patch 2 corrections applied 2026-08-12). No blockers remain. Migration 012 must be implemented exactly to this specification.

Patch 2 corrections (2026-08-12):
1. Root write guard split into `require_reconciliation_client_stamp_v1` (child tables) + `require_reconciliation_root_stamp_v1` (bank_statements, qb_transactions — both stamps). Prose and trigger SQL now agree.
2. Audit RLS downgraded from `FOR ALL` to `FOR SELECT` only. `REVOKE INSERT, UPDATE, DELETE FROM authenticated`. Application audit inserts through `service_role` path unaffected. Immutability triggers remain as DB backstop.

No file modifications, no production changes, no Migration 010/011 edits are authorized by this design step.
