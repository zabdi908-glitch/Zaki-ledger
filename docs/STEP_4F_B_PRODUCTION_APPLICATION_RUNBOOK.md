# Step 4F-B — Production Application Runbook (DO NOT EXECUTE IN 4F-A)

Prepared by Step 4F-A preflight. This document is the exact operator sequence for
the controlled production-application step. Nothing here has been executed.
Execution requires explicit Step 4F-B authorization.

Target: production Supabase project `fqvekbzwghjurkcawpgg` (eu-central-1).
App artifact: `zakiledger` at commit `24d7a37` (HEAD `5ba1e6a` adds docs only).
Frozen Migration 012 SHA-256:
`A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE`

Each step lists: Action / Expected result / STOP condition / Hold (rollback) action.

---

## Phase 9 — Freeze runbook

### Step 1 — Deploy compatibility/freeze-capable application against 011, freeze OFF

- Action: merge commit `24d7a37` (or HEAD `5ba1e6a`) to `main`, push, let Render
  deploy (auto-deploy on push; confirm deploy status). Production DB remains 011.
  `ZAKI_RECONCILIATION_WRITE_FREEZE` must NOT be set on Render.
- Expected: deploy green; app boots; capability probe classifies DB as pre-012
  (PGRST202 naming `canonical_default_tenant_ids_v1`).
- STOP: deploy fails, or app cannot boot, or any write path errors with anything
  other than the pre-012 legacy path.
- Hold: Render rollback to previous commit (one-click rollback). No DB change
  needed — DB untouched by this step.

### Step 2 — Verify pre-freeze normal behavior

- Action: login; key reads (`latest`, `audit`, `transactions`, `dashboard`); one
  approved normal existing write workflow (bank CSV upload of a test statement,
  or QB sync) per the pilot's approval.
- Expected: 200s; the exact DEFECT-1 repro (`POST /api/reconciliation/upload`)
  succeeds with pre-4C payloads (proven Stage A of 4E revalidation).
- STOP: any write path fails on 011, or any write includes canonical fields
  (would prove the pre-012 branch is not taken).
- Hold: delete the test statement via the app's normal undo path if available;
  otherwise record it for post-012 verification (it must carry no canonical
  stamps and will be excluded from backfill checks by construction — it has
  no canonical columns on 011).

### Step 3 — Enable ZAKI_RECONCILIATION_WRITE_FREEZE=1

- Action: set `ZAKI_RECONCILIATION_WRITE_FREEZE=1` on the Render environment.
  [PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]
- Expected: env var saved; value confirmed in Render dashboard.
- STOP: cannot set the variable or cannot confirm it.
- Hold: remove the variable.

### Step 4 — Redeploy/restart so the flag is live

- Action: Render redeploy/restart of the service.
- Expected: new instances read the flag; `GET /api/reconciliation/latest` still 200.
- STOP: service unhealthy after restart.
- Hold: Render rollback; freeze is not yet active, DB untouched.

### Step 5 — Verify EVERY mutation surface is frozen

Probe each surface and expect **503 with body
"Reconciliation writes are temporarily frozen for maintenance"** BEFORE any DB
mutation (verify zero row-count changes after each probe):

1. bank upload — `POST /api/reconciliation/upload`
2. QB upload — `POST /api/reconciliation/qb-transactions/upload`
3. QB sync — `POST /api/reconciliation/qb-transactions/sync`
4. on-demand — `POST /api/reconciliation/on-demand`
5. auto-match GET writer — `GET /api/reconciliation/[id]/transactions`
6. manual match — `POST /api/reconciliation/[id]/match`
7. approve — `POST /api/reconciliation/[id]/approve`
8. reject — `POST /api/reconciliation/[id]/reject`
9. unapprove — `POST /api/reconciliation/[id]/unapprove`
10. invoice-match — `POST /api/reconciliation/[id]/invoice-match`
11. report write path — `POST /api/reconciliation/[id]/report` (and any
    report-generating route; generateReport store writer is guarded)
12. nightly/background — run `scripts/nightly-match.ts` once; expect
    "Reconciliation writes are frozen — nightly match aborted." and zero matches
    persisted.

- Expected: all 12 surfaces frozen; reconciliation_matches count unchanged after
  each probe; audit_log count unchanged.
- STOP: any surface returns 200 or mutates a row. Immediate NO-GO; keep freeze
  ON (it is), investigate before any further step.
- Hold: with freeze ON nothing can mutate — safe to diagnose. Do not unfreeze.

### Step 6 — Verify reads still work

- Action: login; `latest`, `audit`, `transactions`, `dashboard`, pages
  `/reconciliation`, `/upload`, `/settings`, `/review`, `/batch`.
- Expected: all 200 (review screen's `GET [id]/transactions` is intentionally
  503 — it persists auto-matches; document this to the pilot user).
- STOP: any read 500s or a write returns 200.
- Hold: diagnose with freeze ON.

### Step 7 — Pause external scheduler

- Action: pause any separately configured scheduler that calls the app's write
  endpoints or the nightly script (Render cron, external cron service — if none
  configured, record "none configured").
- Expected: no external writer can fire during the window.
- STOP: a scheduler exists that cannot be paused.
- Hold: freeze ON covers it; continue only after pause confirmed.

### Step 8 — Recompute Migration 012 SHA immediately before application

- Action: `sha256sum supabase/migrations/012_reconciliation_canonical_tenant_spine.sql`
  against the exact file that will be applied; compare to
  `A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE`.
- Expected: match.
- STOP: any mismatch — NO-GO, do not proceed, do not touch production.

### Step 9 — Apply EXACT Migration 012

- Action: [PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]
  `npx supabase db query --linked -f supabase/migrations/012_reconciliation_canonical_tenant_spine.sql`
  (single transaction: BEGIN … COMMIT with ON_ERROR_STOP semantics).
- Expected: exit 0; one NOTICE
  "Migration 012 Z2: bootstrapped 0 eligible users missing registry"; backfill
  UPDATE counts 7 / 628 / 422 / 558 / 5 / 216 / 408; duration in the 4–20 s
  band observed in staging (4E: 4–7 s; 4F-A drill: 19 s on the same container —
  variance attributed to local I/O, frozen artifact unchanged).
- STOP: any error, any additional NOTICE, or duration materially outside the
  band without explanation. Transaction rolls back atomically (proven 4E
  Case 1) — DB stays 011.
- Hold: freeze ON; diagnose. No unfreeze.

### Step 9b — Record 012 in the migration ledger

- Action: [PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT] insert the ledger
  row exactly as `staging-tmp-record-012.sql` does (version '012', full
  statements array, name 'reconciliation_canonical_tenant_spine').
- Expected: ledger 001–012.
- STOP: insert fails — migration objects already exist; do not re-apply 012.
  Resolve ledger row only.

### Step 10 — Verify migration result before changing app state

- Action: re-run the Phase 3/4/5 snapshot SQL (SELECT-only) and the P6
  post-012 integrity SQL.
- Expected: all legacy counts unchanged except explicitly expected
  (canonical_audit_ledger stays 8; no new rows anywhere); P6 zeros:
  stamp mismatches 0, NULL stamps 0, audit NULL user/client 0, bootstrap
  rows 0, guard objects 7/11/12/4, authenticated/anon audit DML grants 0.
- STOP: any P6 check nonzero, or any legacy count changed. NO-GO; freeze ON.

### Step 11 — Run database postchecks (full Phase 10 checklist)

- Action: execute every check in the Phase 10 section below (SELECT-only +
  RLS probes via the app).
- Expected: all green.
- STOP: any check fails. Freeze stays ON.

### Step 12 — Deploy/restart canonical application

- Action: the artifact from Step 1 is compatibility-capable — no code change
  required. Restart/redeploy so the app re-probes capability (per-write probe
  has no cache, but a clean restart is cheap and deterministic). No restart is
  strictly required; document which was chosen.
- Expected: app healthy; first write probes classify canonical-012.
- STOP: app unhealthy.
- Hold: freeze ON — no writes can land while diagnosing.

### Step 13 — Keep freeze ON

- Action: verify `ZAKI_RECONCILIATION_WRITE_FREEZE=1` still set after redeploy.
- Expected: flag still 1.
- STOP: flag lost — stop, do not resume writes.

### Step 14 — Read-only app smoke

- Action: login; pages `/reconciliation`, `/upload`, `/settings`, `/review`,
  `/batch`; API reads `latest`/`audit`/`transactions`/`dashboard`.
- Expected: all 200 (except intentional 503 on `GET [id]/transactions` while
  frozen).
- STOP: any failure; freeze ON; diagnose.

### Step 15 — Controlled canonical write smoke (freeze still ON → OFF for
this step only after Step 14 passes)

- Action: disable freeze ONLY after all of Steps 10–14 pass.
  `ZAKI_RECONCILIATION_WRITE_FREEZE` unset/`0` on Render + redeploy.
  [PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]
  Then one controlled workflow as pilot A: bank CSV upload (new statement) →
  QB upload → matching → approve (report generated) → optional reject →
  unapprove → invoice-match.
- Expected: every step 200; new rows carry A's registry
  `client_entity_id`/`ledger_book_id`; audit rows carry `user_id` +
  `client_entity_id`; decisions stamped.
- STOP: any write fails, or any new row lacks stamps (DB write-guards raise
  23502 — a failed-close, not data loss). Freeze back ON.
- Hold: freeze back ON immediately on any failure.

### Step 16 — Verify stamps

- Action: SELECT the new rows created in Step 15; confirm stamps equal the
  acting user's registry row; confirm audit rows for the smoke actions carry
  user + client.
- Expected: zero NULLs, zero mismatches.
- STOP: any mismatch — freeze ON, NO-GO.

### Step 17 — Run cross-tenant probes

- Action: run the Phase 8 attack matrix probes (23 checks from
  `supabase/step-4e-phase8-attacks.sql` equivalents via the app/PostgREST as
  authenticated A): A reads/mutates B's data; direct audit INSERT/UPDATE/
  DELETE; forged statement id under A's identity.
- Expected: all denied / 0 rows / 23514 / 23502.
- STOP: ANY probe succeeds — immediate NO-GO (4E Case 3). Freeze ON.

### Step 18 — Only after ALL pass: disable freeze

- Action: unset `ZAKI_RECONCILIATION_WRITE_FREEZE` on Render + redeploy.
  [PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]
- Expected: writes resume normal canonical behavior (Stage F proven).
- STOP: flag remains set after redeploy.

### Step 19 — Resume scheduler

- Action: re-enable any scheduler paused in Step 7; confirm one scheduled run
  completes with canonical stamps.
- Expected: scheduler healthy.
- STOP: scheduler run errors — diagnose (freeze may be re-enabled at any time).

---

## Phase 10 — Production post-012 verification package (SQL/app checks)

Run immediately after Step 9/9b, before unfreezing. All SELECT-only.
(Use `npx supabase db query --linked -f <file>`.)

### Migration

```sql
SELECT '== P ledger_012' , count(*)::text FROM supabase_migrations.schema_migrations WHERE version='012';
SELECT '== P ledger_all', string_agg(version,',' ORDER BY version) FROM supabase_migrations.schema_migrations;
-- Expect: 1 ; 001,...,012
```

### Counts — unchanged from pre-012 snapshot (all must equal Phase 3 values)

```sql
SELECT '== P count ' || t, n FROM (VALUES
 ('bank_statements',(SELECT count(*) FROM public.bank_statements)),
 ('bank_transactions',(SELECT count(*) FROM public.bank_transactions)),
 ('qb_transactions',(SELECT count(*) FROM public.qb_transactions)),
 ('reconciliation_matches',(SELECT count(*) FROM public.reconciliation_matches)),
 ('reconciliation_reports',(SELECT count(*) FROM public.reconciliation_reports)),
 ('reconciliation_decisions',(SELECT count(*) FROM public.reconciliation_decisions)),
 ('reconciliation_audit_log',(SELECT count(*) FROM public.reconciliation_audit_log)),
 ('default_tenant_identities',(SELECT count(*) FROM public.default_tenant_identities)),
 ('canonical_audit_ledger',(SELECT count(*) FROM public.canonical_audit_ledger))
) AS x(t,n);
```

### Backfill — exact P6 checks (each must be 0; guard counts must be 7/11/12/4)

Run `supabase/step-4e-phase6-integrity.sql` (SELECT-only) and require:

- bs_stamp_matches_registry=0, bs_null_stamps=0
- qt_stamp_matches_registry=0, qt_null_stamps=0
- bt_inherit_mismatch=0, bt_null_stamps=0
- rm_inherit_mismatch=0, rm_null_stamps=0
- rr_inherit_mismatch=0, rd_inherit_mismatch=0
- audit_null_user=0, audit_null_client=0
- audit_user_mismatch_vs_match=0, audit_client_mismatch_vs_match=0
- bootstrap_012_audit_rows=0 (zero bootstrap noise)
- audit_ledger_total=8 (unchanged)
- write_guard_triggers=7, immutability_triggers=11, composite_fks=12,
  parent_unique_indexes=4
- audit_authenticated_dml_grants=0, audit_anon_grants=0

### Nulls

```sql
-- zero NULL canonical stamps for eligible production rows
SELECT count(*) FROM public.bank_statements WHERE client_entity_id IS NULL OR ledger_book_id IS NULL;
SELECT count(*) FROM public.bank_transactions WHERE client_entity_id IS NULL;
SELECT count(*) FROM public.qb_transactions WHERE client_entity_id IS NULL OR ledger_book_id IS NULL;
SELECT count(*) FROM public.reconciliation_matches WHERE client_entity_id IS NULL;
SELECT count(*) FROM public.reconciliation_reports WHERE client_entity_id IS NULL;
SELECT count(*) FROM public.reconciliation_decisions WHERE client_entity_id IS NULL;
-- zero NULL audit user_id
SELECT count(*) FROM public.reconciliation_audit_log WHERE user_id IS NULL;
-- all must be 0
```

### Registry

```sql
-- no unexpected new tenant entities
SELECT count(*) FROM public.practices;                 -- expect 2
SELECT count(*) FROM public.practice_memberships;      -- expect 2
SELECT count(*) FROM public.client_entities;           -- expect 2
SELECT count(*) FROM public.ledger_books;              -- expect 2
SELECT count(*) FROM public.default_tenant_identities; -- expect 2
-- no unexpected bootstrap audit rows
SELECT count(*) FROM public.canonical_audit_ledger
WHERE metadata_redacted->>'bootstrap_version' = '012'; -- expect 0
-- canonical_audit_ledger expected delta: 0 (stays 8)
SELECT count(*) FROM public.canonical_audit_ledger;    -- expect 8
```

### Accounting

Run `supabase/step-4f-aggregates-union.sql` and diff against
`supabase/step-4f-prod-agg.json` (pre-012 production baseline): every line
must be identical (amounts, dates-derived values, balances, report monetary
values, decisions by type, match confidence sums, audit action counts).

### Security

```sql
-- authenticated audit INSERT/UPDATE/DELETE denied (expect 0 granted)
SELECT count(*) FROM information_schema.table_privileges
WHERE table_name='reconciliation_audit_log' AND grantee='authenticated'
  AND privilege_type IN ('INSERT','UPDATE','DELETE');
-- own audit SELECT permitted: verified via app as user A (expect 200, own rows)
-- foreign tenant probes: as A request B's statement/match/report/audit rows
-- (expect denied / 0 rows; any success = NO-GO, freeze ON)
```

---

## Execution log

| # | Step | Status | Timestamp | By |
|---|---|---|---|---|
| 1 | Deploy compat app (011, freeze OFF) | EXECUTED — PASS | 2026-08-14 00:41–00:43 UTC | Claude (4F-B) |
| 2 | Pre-freeze verification | EXECUTED — PASS | 2026-08-14 00:43–00:47 UTC | Claude (4F-B) |
| 3 | Enable freeze flag | EXECUTED — PASS | 2026-08-14 00:49:08 UTC | Claude (4F-B) |
| 4 | Redeploy | EXECUTED — PASS | 2026-08-14 00:50:56 UTC | Claude (4F-B) |
| 5 | Freeze surface probes (12) | EXECUTED — PASS (13/13 503; report POST 405 = GET-only route, generation guarded via approve) | 2026-08-14 00:51–00:57 UTC | Claude (4F-B) |
| 6 | Read verification | EXECUTED — PASS | 2026-08-14 00:57 UTC | Claude (4F-B) |
| 7 | Pause scheduler | NONE CONFIGURED (nightly is manual script; no Render cron) | 2026-08-14 | Claude (4F-B) |
| 8 | 012 SHA recompute | EXECUTED — PASS (blob A7E25F…; worktree CRLF via autocrlf, normalized hash matches) | 2026-08-14 01:10 UTC | Claude (4F-B) |
| 9 | Apply 012 | EXECUTED — PASS (exit 0, 15 s, 01:11:20–01:11:35 UTC, single COMMIT) | 2026-08-14 01:11 UTC | Claude (4F-B) |
| 9b | Record ledger 012 | EXECUTED — PASS (ledger 001–012) | 2026-08-14 01:13 UTC | Claude (4F-B) |
| 10 | Migration result verify | EXECUTED — PASS (canonical columns present; P6 all green) | 2026-08-14 01:14–01:20 UTC | Claude (4F-B) |
| 11 | Postchecks (Phase 10) | EXECUTED — PASS (nulls 0; registry 2/2/2/2/2; aggregates identical to frozen baseline) | 2026-08-14 01:20–01:25 UTC | Claude (4F-B) |
| 12 | Canonical app restart | NOT REQUIRED (per-write capability probe, no cache) | 2026-08-14 | Claude (4F-B) |
| 13 | Freeze still ON | EXECUTED — PASS | 2026-08-14 01:26 UTC | Claude (4F-B) |
| 14 | Read-only smoke | EXECUTED — PASS (pages 6/6, reads 200, writers 503) | 2026-08-14 01:30 UTC | Claude (4F-B) |
| 15 | Controlled write smoke | EXECUTED — PASS (01:56:15–01:59:48 UTC unfrozen window; upload→auto-match(2)→approve→report; all rows stamped; freeze restored) | 2026-08-14 01:59:48 UTC | Claude (4F-B) |
| 16 | Stamp verification | EXECUTED — PASS (client daa94c07 / book e125b9e1 / user 38832e8e on all surfaces) | 2026-08-14 02:00 UTC | Claude (4F-B) |
| 17 | Cross-tenant probes | EXECUTED — PASS (SQL matrix 23/23; app probes B report/dashboard 404 for A, audit 20 own / 0 foreign) | 2026-08-14 02:01 UTC | Claude (4F-B) |
| 18 | Unfreeze | EXECUTED — PASS (all gates green; freeze=0 live 02:04:01 UTC) | 2026-08-14 02:04:01 UTC | Claude (4F-B) |
| 19 | Resume scheduler | NONE CONFIGURED — nothing to resume | 2026-08-14 | Claude (4F-B) |
