# Reconciliation Hardening — Production Preflight Report

Preflight executed 2026-08-16 (~22:00–22:45 UTC) against production Supabase
project `fqvekbzwghjurkcawpgg`, strictly READ-ONLY. No migration was applied,
no production data was modified, no repair SQL ran, no app code was deployed,
no merge to `main` occurred. Every database statement carried
`SET default_transaction_read_only = on;` as a hard guard, and every query was
sent with an explicit `--project-ref fqvekbzwghjurkcawpgg` (never the
`--linked` default, which currently resolves to the LEGACY project
`gzwtxebgevgapchoslmp`).

---

## 1. Verdict

**PRODUCTION PREFLIGHT BLOCKED**

The preflight itself completed successfully and answered all ten questions.
Deployment of migration 013 is blocked by a deterministic no-go condition:
**the migration's own Z2 duplicate-live-auto precondition is violated
(107 > 0)**. Migration 013's unique index `uk_matches_auto_live_qb` cannot be
built over existing production data, and the migration correctly refuses
rather than repairs. This is not a failure of the migration or of this
preflight — production requires a separate, reviewed, explicitly authorized
dedup/repair plan before 013 can be applied.

A PASS would not have authorized deployment; a BLOCKED verdict likewise
changes nothing about the standing prohibitions.

## 2. Production environment identity

| Attribute | Expected | Observed (Management API) | Observed (in-DB) |
|---|---|---|---|
| Project ref | `fqvekbzwghjurkcawpgg` | `fqvekbzwghjurkcawpgg` ✓ | — |
| Project name | `zaki` | `zaki` ✓ | — |
| Region | Central EU / Frankfurt | `eu-central-1` ✓ | — |
| Postgres major | 17 | engine `17`, version `17.6.1.155` ✓ | `version()` = PostgreSQL 17.6 ✓ |
| Status | — | `ACTIVE_HEALTHY` ✓ | — |
| Organization | — | `eazpbhtajatregdgkdqj` | — |

Decisive in-DB identity proof: `inet_server_addr()` returned
`2a05:d014:1e9b:b300:dc4d:d7da:d59:3f27`, which is exactly the DNS address of
`db.fqvekbzwghjurkcawpgg.supabase.co`. The database queried is the production
database, not the legacy project.

`max_connections = 60` (free-tier). The legacy project `gzwtxebgevgapchoslmp`
was never accessed. Hazard recorded: the local supabase CLI is currently
linked to the legacy project; `supabase db query --linked` alone would hit
legacy. All future production work must use
`--linked --project-ref fqvekbzwghjurkcawpgg`.

## 3. Artifact identity

- Branch: `fix/reconciliation-candidate-hardening` ✓
- HEAD: `a75d6a90c221bab13101ab88ef767137d82e9731` ✓ (matches authoritative)
- Working tree: clean except untracked `supabase/config.toml` (pre-existing,
  not part of the reviewed artifact; operator should decide whether it is
  intended to be tracked).

## 4. Migration hashes

Recomputed SHA-256 from the committed blobs (`git show HEAD:<path>`):

| Migration | Expected | Measured | Result |
|---|---|---|---|
| 010 | AD609305B040063A0C6186C9E3460F8BB886CE8429A1D03D8F48F6D17907902D | AD609305B040063A0C6186C9E3460F8BB886CE8429A1D03D8F48F6D17907902D | PASS |
| 011 | 84138BB49A51474C2B7EFDC110780A37AD293A7A5A0E63A2618480DA926D7418 | 84138BB49A51474C2B7EFDC110780A37AD293A7A5A0E63A2618480DA926D7418 | PASS |
| 012 | A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE | A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE | PASS |
| 013 | 42B12EBB4CEE9057161C376B6873630407D7479B32E2407ACEC2446A02B2527A | 42B12EBB4CEE9057161C376B6873630407D7479B32E2407ACEC2446A02B2527A | PASS |
| 013 (hardened) | D9086AD51B3CB9F5796C6F06F5B0BEC338D3BB485C1F1F4C996A0D52C1B2CD93 | D9086AD51B3CB9F5796C6F06F5B0BEC338D3BB485C1F1F4C996A0D52C1B2CD93 | PASS (repair-package hardening added Z1b repair-evidence immutability + C2b assertion) |

## 5. Production schema state

- Migration ledger: `001–012` applied, **013 absent** (`ledger_013_rows = 0`).
- `reconciliation_matches` columns: the exact pre-013 set (14 columns; **no**
  `superseded_at` / `superseded_by_match_id` / `supersede_reason` /
  `supersede_operation_id`).
- `reconciliation_audit_log` columns: pre-013 (9 columns; **no**
  `operation_id` / `previous_state` / `resulting_state` / `evidence`).
- Indexes: **no** `uk_matches_auto_live_qb`; the
  `UNIQUE (bank_transaction_id, statement_id)` constraint exists (the
  migration's ON CONFLICT target).
- Constraints: 012 composite FKs present
  (`fk_matches_statement_client`, `fk_matches_bank_txn_client`,
  `fk_matches_statement_bank_txn`), base FKs, `matched_by` and
  `flagged_level` CHECKs.
- Triggers: 012 guard set present (`write_guard_*` ×7, `*_immutable` ×11,
  `match_qb_same_client_check`, `audit_log_no_delete`); **no**
  `reconciliation_match_approved_guard`, **no** `match_book_alignment`
  (both are 013 objects — correctly absent).
- Guard-object counts match the verified 012 baseline: write-guard triggers
  7/7, immutability triggers 11/11, composite FKs 12/12, parent unique
  indexes 4/4, authenticated audit DML grants 0, anon audit grants 0.
- RLS: enabled (not forced) on all five store tables with the 012 policies
  (matches/reports/decisions/preferences `ALL`, audit log `SELECT`, all
  user-scoped).
- `reconciliation_private` schema: **absent** (expected pre-013).
- 013 RPCs (`persist_auto_matches_v1`, `create_manual_match_v1`,
  `supersede_auto_claims_v1`, `unapprove_reconciliation_matches_v1`,
  `approve_reconciliation_matches_v1`,
  `approve_reconciliation_matches_service_v1`): **absent** (expected
  pre-013).

## 6. Duplicate-live-auto precondition (Phase 4)

Exact Z2 predicate reproduced read-only. On the pre-013 schema the
`superseded_at IS NULL` filter is vacuous (the column does not exist yet and
is all-NULL the moment Z2 runs inside the migration), so the equivalent is
`matched_by = 'auto' AND qb_transaction_id IS NOT NULL GROUP BY
qb_transaction_id HAVING count(*) > 1`.

- **Duplicate QB endpoints: 107** (the migration's own Z2 message would
  report `min(107, 5) = 5` with a 5-id sample — both reproduced).
- **Affected match rows: 357** — approved **203**, unapproved **154**.
- By client: `daa94c07-…` (user `38832e8e-…`): 253 rows
  (140 unapproved / 113 approved); `47f6862a-…` (user `0042d6e0-…`):
  104 rows (14 unapproved / 90 approved).
- Rows per QB: 2→53, 3→3, 4→19, 5→26, 6→6 (sums to 107 endpoints / 357 rows).
- All 107 duplicate endpoints span **multiple statements**; 51 of them also
  have same-statement multiplicity (multiple bank rows within one statement
  claiming the same QB row — partial-allocation-shaped, needs review).
- 106 of 107 duplicate endpoints have ≥1 approved row; 91 QB endpoints have
  ≥2 approved rows; 1 endpoint is all-unapproved.
- Sample internal ids captured for later reviewed classification (see
  preflight query logs; e.g. QB `024b4e7a-6ecd-4907-9c98-88b6fc0981a9` has
  two approved auto rows, confidences 1.000 and 0.600).

**Conclusion: migration 013 cannot currently be applied. A separate reviewed
dedup/repair plan is required first.** No delete, supersede, update, or
repair was performed.

## 7. Manual/automatic coexistence (Phase 5)

**Zero.** No QB endpoint in production holds both a manual and an automatic
relationship. In fact production currently holds **zero manual rows** — all
573 `reconciliation_matches` rows are `matched_by = 'auto'`. No coexistence
conflict class exists in production today.

## 8. Historical reconciliation classification (Phase 6)

| Class | Description | Count |
|---|---|---|
| A | Duplicate live automatic exclusive claims | 107 QB endpoints / 357 rows |
| B | Unapproved auto row conflicting with an approved relationship on the same QB | 152 rows |
| C | Manual + automatic coexistence | 0 |
| D | Approved duplicates/conflicts (≥2 approved rows on one QB) | 91 QB endpoints |
| E | Synthetic/test contamination | 2 test QB rows (`4FB-CANONICAL-TEST`) + 5 matches on them; plus 15 rows touching the 2026-08-14 pilot-smoke statements (genuine pilot workflow, flagged for awareness) |
| F | Low-confidence historical suggestions | 88 rows confidence < 0.4; 150 rows in 0.4–0.7 |
| G | Potentially legitimate many:1 / partial / allocation | 51 QB endpoints with same-statement multi-bank auto claims (candidates only — the canonical model supports many:1 via **manual** rows; these are auto rows and need professional review) |
| H | Ambiguous — professional review required | the overlap of A/B/D/F/G — every repair decision |

All 573 rows were created 2026-08-08 → 08-10 (matcher runs) plus 15 rows on
2026-08-14 (pilot smoke). No row was reused blindly as an error: the
classifier above distinguishes exclusivity conflicts (A/B/D) from possible
legitimate allocation shapes (G) and contamination (E).

## 9. Migration 013 expected effects (Phase 7)

**Schema effects:**
- New nullable columns on `reconciliation_matches` (`superseded_at`,
  `superseded_by_match_id`, `supersede_reason`, `supersede_operation_id`)
  and on `reconciliation_audit_log` (`operation_id`, `previous_state`,
  `resulting_state`, `evidence`).
- New schema `reconciliation_private` + table `transition_capabilities`
  (one-shot, transaction-bound capability store; all privileges revoked from
  API roles).
- Two private lock helpers (`lock_bank_endpoints_v1`, `lock_qb_endpoints_v1`).
- Deferred FK `fk_matches_superseded_by` (ON DELETE SET NULL).
- Partial unique index `uk_matches_auto_live_qb` (auto live claims only).
- Privilege reset + explicit grants (Z4, see §10).
- Guard trigger `reconciliation_match_approved_guard` (approved immutability,
  supersession-evidence protection, manual-path capability enforcement).
- Trigger `match_book_alignment` (same-ledger-book guard).
- Six RPCs: `persist_auto_matches_v1`, `create_manual_match_v1`,
  `supersede_auto_claims_v1`, `unapprove_reconciliation_matches_v1`,
  `approve_reconciliation_matches_v1` (authenticated),
  `approve_reconciliation_matches_service_v1` (service_role), with ACLs.
- End-of-migration assertions C1–C5 and `NOTIFY pgrst`.

**Data effects: NONE.** The migration contains no INSERT/UPDATE/DELETE and no
backfill against reconciliation data. Z2 and C1–C5 are read-only assertions.
Confirmed: migration 013 **does not silently repair** historical
reconciliation data — it refuses loudly (Z2 NO-GO exception) when duplicate
live-auto claims exist, which is exactly the current production situation.

## 10. Privilege/RLS delta (Phase 8)

Current grants vs. the Z4 post-state (privilege sets):

| Table | Role | Current (pre-013) | Post-013 (Z4) | Delta |
|---|---|---|---|---|
| reconciliation_matches / reports / decisions | anon | FULL DML | — | removed (unused) |
| same three tables | authenticated | FULL DML | SELECT, INSERT, UPDATE, DELETE | loses REFERENCES/TRIGGER/TRUNCATE (unused) |
| same three tables | service_role | FULL DML | SELECT, INSERT, UPDATE, DELETE | loses REFERENCES/TRIGGER/TRUNCATE (unused) |
| reconciliation_audit_log | anon | — | — | none |
| reconciliation_audit_log | authenticated | REFERENCES, SELECT, TRIGGER, TRUNCATE | SELECT | loses REFERENCES/TRIGGER/TRUNCATE (unused) |
| reconciliation_audit_log | service_role | FULL DML | SELECT, INSERT, UPDATE, DELETE | loses REFERENCES/TRIGGER/TRUNCATE (unused) |
| user_merchant_preferences | anon | FULL DML | — | removed (unused) |
| user_merchant_preferences | authenticated | FULL DML | SELECT, INSERT, UPDATE | loses DELETE (no app DELETE path exists) |
| user_merchant_preferences | service_role | FULL DML | SELECT, INSERT, UPDATE | loses DELETE/TRUNCATE/… (no app DELETE path) |

- RLS policies are untouched by 013; tenant isolation stays on the 012
  composite FKs + write-guard triggers + same-client trigger.
- New RPC EXECUTE grants: service_role on the five server RPCs;
  authenticated on `approve_reconciliation_matches_v1` only; anon/PUBLIC on
  none. 013 revokes only its own new objects — no existing function ACL is
  affected.
- Impact on production: the app performs all writes server-side under
  `service_role` (S/I/U/D retained on the four store tables); no application
  path uses anon DML, authenticated DELETE on preferences, or
  REFERENCES/TRIGGER/TRUNCATE on these tables. No production-specific
  privilege dependency is broken.
- **Sequencing constraint (not a blocker):** the currently deployed app (pre-
  hardening `main`) writes approvals/manual rows via direct DML. If 013 were
  applied before the hardening app is deployed, its approve/unapprove/manual
  paths would hit the new guard trigger and fail closed. Correct sequence:
  deploy hardening app (stays on the pre-013 path via the per-write probe),
  freeze writes, apply 013, verify, unfreeze.

## 11. Production writer inventory (Phase 9)

Complete inventory from code analysis (branch `a75d6a9`):

- **Store writers** (all service_role, all begin with
  `assertReconciliationWritesNotFrozen()`):
  `saveBankStatement` → RPC `ingest_bank_statement_v1`;
  `saveQbTransactions` → RPC `ingest_accounting_transactions_v1`;
  `computeAndPersistMatches` → 013: RPC `persist_auto_matches_v1` / pre-013:
  direct upsert; `createManualMatch` → 013: RPC `create_manual_match_v1` /
  pre-013: direct upsert + sweep; `rejectMatch` → direct delete;
  `approveMatches` → 013: RPC `approve_reconciliation_matches_service_v1` /
  pre-013: direct update + audit insert; `unapproveMatches` → 013: RPC /
  pre-013: direct update; `generateReport` → direct upsert.
- **HTTP routes** (13, each with a route-level freeze 503 before any store
  call): `upload`, `qb-transactions` (POST), `qb-transactions/upload`,
  `qb-transactions/sync`, `on-demand`, `[id]/transactions` (GET writer),
  `[id]/match`, `[id]/approve`, `[id]/unapprove`, `[id]/reject`,
  `[id]/invoice-match`, `classify-merchants`, `preferences`.
- **Nightly**: `scripts/nightly-match.ts` → `runNightlyMatch`
  (qb_transactions + matches); freeze-checked twice (script exit 0 + store
  asserts). **No scheduler configured anywhere** (no Render cron, no
  package.json cron, no cron endpoint; documented "none configured" in the
  4F-B report).
- **Freeze mechanism**: Render env var `ZAKI_RECONCILIATION_WRITE_FREEZE=1`
  on service `srv-d9ighicm0tmc73cp4f9g` + redeploy → all 13 routes 503
  before any DB call; store-level asserts as second line; reads stay 200.
- **GAP (must close before any deployment):**
  `lib/decision-store.ts` (`recordDecision`, `bumpMerchantPreference`,
  `setMerchantDefault` — writers of `reconciliation_decisions` and
  `user_merchant_preferences`) has **no store-level freeze assertion**.
  Today every caller is a freeze-checked route, so no reachable write
  escapes the freeze, but the documented second line of defense is missing
  for these three functions. Add the assertion before relying on the freeze
  for the 013 window.
- **Capability probe**: per-write, uncached, deterministic PGRST202; the 013
  probe RPC call (`persist_auto_matches_v1` with empty payload) performs no
  writes on either side of the migration.

## 12. Locks/activity (Phase 10)

At scan time (2026-08-16 ~22:30 UTC): the only non-idle session was the
read-only Management-API connection itself (`mgmt-api`); **zero** locks on
any reconciliation table; **zero** idle-in-transaction sessions; no
long-running transactions. The database is quiet and a migration window is
feasible. (Re-check immediately before the deployment window; this snapshot
is not a standing guarantee.)

## 13. Backup evidence (Phase 11)

- **Native backups: NONE.** Management API:
  `{"walg_enabled":true, "pitr_enabled":false, "backups":[], "physical_backup_data":{}}`
  — PITR is disabled (free plan), zero native backups exist. There is no
  native restore path.
- **Manual dump mechanism: proven working today.**
  - Schema dump: `/tmp/zaki-preflight/prod-preflight-dump-2026-08-16.sql`
    (302,635 bytes; SHA-256 `eaeb736fa5b579b259ad50577058f4992d8fb9087946bf143b13654f30372f79`).
  - Data dump: `/tmp/zaki-preflight/prod-preflight-data-2026-08-16.sql`
    (1,200,326 bytes; INSERT format; pg_dump 17.6 via Management API).
  - **Row parity verified 9/9**: bank_statements 12, bank_transactions 646,
    qb_transactions 437, reconciliation_matches 573, reports 6, decisions
    217, audit_log 409, default_tenant_identities 2, canonical_audit_ledger
    52 — identical to live counts at dump time.
- Restore path: the data dump is plain SQL executable as `postgres` via
  `supabase db query --linked --project-ref fqvekbzwghjurkcawpgg -f <dump>`
  (its header sets `session_replication_role = replica` and
  `row_security = off`, so restore bypasses triggers/RLS — standard pg_dump
  behavior). Full-state rollback = restore schema dump + data dump.
- Prior restore drill: the 2026-08-13 pre-012 backup set was restore-drilled
  green during Step 4F-A (parity 87/87, aggregates identical, 012 rehearsal
  clean) — evidence that this dump/restore mechanism works; that old set is
  no longer on this machine. The fresh dump above has not been restore-
  drilled (no local Postgres available in this session) — a restore drill
  against a scratch database is a required gate before the deployment
  window, or record that the identical mechanism was previously drilled.
- **A fresh backup must be taken at freeze time** (this dump ages as soon as
  writers resume).

## 14. Recovery/rollback plan (Phase 12)

Designed, not executed. Freeze ON is the standing precondition for every
scenario below (no reconciliation writers can fire during the window).

- **A. Migration fails before COMMIT.** 013 is one transaction; failure
  rolls back atomically and production stays exactly at 012 (proven pattern:
  012's rollback behavior). Diagnose from the error; freeze stays ON; do not
  retry blind.
- **B. Migration commits but app deployment fails.** Freeze ON keeps all
  writers 503. The pre-hardening app (if still deployed) fails closed on
  approve/unapprove/manual (guard trigger) and keeps working on reads and
  (service-role) auto persistence — acceptable degraded state, no data
  damage. Roll forward: deploy the hardening commit on Render (or Render
  one-click rollback to the hardening commit if it was previously deployed).
  Do not unfreeze until the deployed app probes canonical-013 successfully.
- **C. Migration commits and a runtime error appears.** Freeze ON; triage
  from logs + audit evidence. Prefer forward recovery (app patch). Only if
  the error is judged unfixable forward: full rollback = restore the
  pre-013 schema dump + data dump (returns production to the exact 012 state;
  zero writes happened in the window thanks to the freeze, so nothing is
  lost beyond the migration objects themselves).
- **D. Migration blocks on dirty historical state.** This is the *expected*
  current outcome (Z2, 107 duplicates): automatic rollback; produce the
  reviewed dedup plan under separate authorization; re-run this preflight's
  Phase 4 after repair (must be 0); then re-attempt 013.
- **E. Uncertain deployment result.** Verify the ledger row (`version 013`),
  the four new columns, the index, both triggers, and C1–C5 objects. The
  migration is atomic, so a half-applied state should be impossible — if
  anything is partially present, STOP, freeze ON, and investigate rather
  than guess.
- **F. Reconciliation writes occur unexpectedly during the window.** Freeze
  probes (13/13 routes 503 + nightly abort) run before the window and are
  the precondition. If any surface returns 200 or mutates, STOP immediately
  with freeze ON and diagnose; writes that landed are confined to the
  pre-013 write path (or post-013 RPCs if after apply) and are diagnosable
  via audit rows. Full rollback via backup restore remains available.

No destructive automatic repair is proposed in any scenario; every
historical-data change requires the separately authorized reviewed repair.

## 15. Deployment stop conditions (Phase 13)

STOP deployment if any of:

1. Project identity mismatch (ref/name/region/Postgres major) — **verified
   clear**.
2. Git SHA mismatch vs `a75d6a90c221bab13101ab88ef767137d82e9731` —
   **verified clear**.
3. Migration 013 SHA mismatch vs
   `42b12ebb4cee9057161c376b6873630407d7479b32e2407acec2446a02b2527a` —
   **verified clear**.
4. 010/011/012 hash mismatch — **verified clear**.
5. Schema not at the expected pre-013 state — **verified clear** (ledger
   001–012, no 013 objects, 012 guards intact).
6. **Duplicate live-auto precondition > 0 — VIOLATED (107 > 0). This alone
   blocks deployment.**
7. Backup unavailable/unverified — verified available via manual dump
   (parity 9/9); native PITR absent; fresh freeze-time backup + restore
   drill still required.
8. Unexpected active writer that cannot be frozen — none found (no
   scheduler; all writers freeze-guarded); freeze probes must still run at
   window time.
9. Unexplained locks/long transactions — none at scan time; re-check at
   window time.
10. Privilege delta with unresolved impact — none found (delta analyzed in
    §10); app sequencing constraint applies (§10).
11. Migration behavior differing from the reviewed artifact — hash match +
    full source review performed; behavior documented in §9.
12. **Production repair required but not separately authorized — VIOLATED
    (107 duplicate QB endpoints / 357 rows require a reviewed dedup plan
    that does not exist yet as an authorized production operation).**

Additional gates for the future window: (a) `lib/decision-store.ts` freeze
assertions added and deployed; (b) the Render-deployed commit confirmed to
be the hardening build (or newer) before unfreezing; (c) freeze probes green
13/13 before any write-capable step.

## 16. Remaining production risks

1. **Historical debt (primary):** 107 duplicate live-auto QB endpoints /
   357 rows (203 approved) — every repair decision is consequential (they
   include approved, accountant-visible rows) and needs professional review
   per the remediation design; no automatic repair.
2. Freeze second-line gap in `lib/decision-store.ts` (route-level coverage
   currently complete, but the documented defense-in-depth is missing).
3. No native PITR — recovery depends entirely on operator-taken dumps;
   dump discipline must be part of the deployment runbook.
4. The Render deployment state could not be verified from this session
   (no Render dashboard/API access) — the deployed commit is unknown and
   must be confirmed at the deployment gate.
5. CLI `--linked` currently targets the legacy project — a real hazard for
   any future operator command; always pass `--project-ref
   fqvekbzwghjurkcawpgg`.
6. Two synthetic `4FB-CANONICAL-TEST` QB rows + 5 matches remain in
   production (low volume, must be excluded from repair classification).
7. This preflight's dump is a point-in-time snapshot (2026-08-16 ~22:40
   UTC); production has no freeze active, so any backup older than the
   freeze moment must not be used for rollback.

## 17. Exact next gate

1. **No deployment.** This preflight ends with a BLOCKED verdict; migration
   013 must not be applied.
2. Author a **separate production repair plan** for the 107 duplicate
   endpoints / 357 rows (design basis: `RECONCILIATION_DEFECT_REMEDIATION_DESIGN.md`
   §2/§3; classification basis: this report §6/§8). It must be reviewed and
   explicitly authorized as its own production operation, with its own
   backup + freeze + verification gates.
3. Close the `lib/decision-store.ts` freeze-assertion gap in an app PR
   (pre-deployment requirement, independent of the repair).
4. After the authorized repair: re-run Phase 4 (expect **0**), take a fresh
   freeze-time backup with parity verification, confirm the deployed app
   commit, freeze all writers (13/13 probes + nightly abort), recompute the
   013 hash, apply migration 013, run the post-apply checklist (C1–C5 +
   counts + nulls + aggregates), deploy the hardening app, controlled smoke,
   unfreeze.
5. Every step in (4) requires a new explicit operator authorization; this
   preflight grants none.

STOP. Migration 013 was NOT applied. No production data was modified. No
historical repair was performed. No deployment occurred. No merge to main
occurred.
