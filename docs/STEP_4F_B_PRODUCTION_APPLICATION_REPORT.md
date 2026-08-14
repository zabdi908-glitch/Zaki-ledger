# Step 4F-B Production Application Report

Date: 2026-08-14. Operator: Claude (Step 4F-B authorized run).

## 1. Final verdict

**STEP 4F COMPLETE — PRODUCTION MIGRATION 012 VERIFIED**

## 2. Production identity

- Supabase project `fqvekbzwghjurkcawpgg` ("zaki"), eu-central-1, ACTIVE_HEALTHY, postgres 17.6, database `postgres` — re-confirmed live at window start (A1 server row: postgres/postgres/17.6) and by live app binding (auth cookie `sb-fqvekbzwghjurkcawpgg-auth-token` captured during login probe).
- Second project `gzwtxebgevgapchoslmp` ("zaki ledger") is NOT the target. Local `zakiledger/.env.local` still points at it — no local script was run against production with implicit env; all production DB work used `--linked` CLI.

## 3. Application artifact deployed

- Artifact: commit `24d7a37` ("fix: add pre-012/canonical-012 reconciliation write compatibility"). HEAD `5ba1e6a` adds docs only; `git diff 24d7a37 HEAD -- zakiledger supabase/migrations` = empty (proven).
- Deploy: merged artifact to `main` (fast-forward, plus merge of origin/main PR #10 merge commit) → pushed as `4a0a66f` ("Merge remote-tracking branch 'origin/main'"). Render auto-deploy triggered: deploy `dep-d9v68lh42hec739lqen0`, live 2026-08-14 00:43:16 UTC, commit 4a0a66feb120bfa98ad69c31aa4f3a63597e6433.
- Deployed behavior evidence: 011+freeze OFF legacy upload 200 (DEFECT-1 repro passes in production); freeze ON → all writer routes 503 with the exact frozen body (capability only exists in the 24d7a37 artifact); post-012 stamped writes (no legacy fallback).
- Freeze flag deploys: freeze=1 live 00:50:56Z (dep-d9v6c8fqj5pc73d518eg), temp smoke unfreeze 01:56:15–01:59:48Z (dep-d9v7are417fc73ca6jug → dep-d9v7cie417fc73caamq0), final unfreeze live 02:04:01Z (dep-d9v7egbl550s73ftlao0).

## 4. Window-start checks

- Ledger: 001–011, 012 absent (live). Classifier: ELIGIBLE+REGISTRY EXISTS=2, ELIGIBLE+REGISTRY MISSING=0, AUTH USER MISSING=0, OTHER BLOCKER=0. Integrity D1–D16/E1–E5: all zero. 87/87 snapshot rows identical to 4F-A baseline (`supabase/step-4fb-phase0-snapshot.json`).
- Hashes (worktree + HEAD blob): 010 = AD609305… ✓, 011 = 84138BB4… ✓, 012 = A7E25FA3… ✓.
- Working tree: no tracked modifications to `zakiledger/` or `supabase/migrations/`.
- Live app binding proven (cookie probe spec): bound to production project.

## 5. Freeze activation

- `ZAKI_RECONCILIATION_WRITE_FREEZE=1` set on Render service `Zaki-ledger` (srv-d9ighicm0tmc73cp4f9g) 00:49:08 UTC; deploy live 00:50:56 UTC. Window start 2026-08-14T00:49:08Z.
- Writer probes: upload, qb-upload, qb-sync, on-demand, `[id]/transactions` (GET writer), match, approve, reject, unapprove, invoice-match, classify-merchants, preferences, qb-transactions — all 503 with body "Reconciliation writes are temporarily frozen for maintenance". Report POST = 405 (route is GET-only; report generation lives in approveMatches on the approve route, which is frozen). Nightly script: "Reconciliation writes are frozen — nightly match aborted." exit 0, zero DB calls.
- Row counts before/after probes identical (8/630/422/558/5/216/408, registry 2/2/2/2/2).
- Scheduler: none configured (no Render cron services; nightly-match.ts is a manual script) — recorded "none configured", nothing to pause.

## 6. Frozen-state baseline

`supabase/step-4fb-phase4-frozen-snapshot.json` + `supabase/step-4fb-phase4-agg.json` (2026-08-14 ~01:02 UTC). Counts: bank_statements=8, bank_transactions=630, qb_transactions=422, matches=558, reports=5, decisions=216, audit_log=408, default_tenant_identities=2, canonical_audit_ledger=20. Classifier 2/2/0/0/0. Integrity all zero. Accounting anchors: bank_txn_sum=-69237.31, qb_txn_sum=-53416.28 (identical to 4F-A except counts from the authorized Phase 1 smoke rows).

## 7. Frozen recovery backup

`production-backup-pre-012-frozen-20260814-010215/` (dumps 01:02:15–01:06 UTC, all exit 0).

| File | Bytes | SHA-256 |
|---|---|---|
| schema.sql | 281,782 | 9d515e25101c98e4a9557d9b466b54d3446f448a3eb65b0676be7d6f0a0ae653 |
| data.sql | 1,024,086 | 2ac9be6daddc2137d3fef15e21fb5fd3afbe80f6a7ccb4316d8d0d7742f87323 |
| migration-schema.sql | 887 | 18b99fbbb3ec9fbb964bb255a56171329acd99b6977ece2addd89fdf5aa5105b |
| migration-data.sql | 253,873 | eee916a38fbca52916f99f4ab2853e024cbf16def102a8048f54cb5a9165e2df |
| roles.sql | 431 | 0decd601faa70260a3a31e8ce63208cc4a4c1f99921bc6f3ed4faf1cd980da3a |

migration-data verified: 001–011 present exactly once each, 012 absent. (Migration-data bytes differ from the 4F-A set only by dump ordering — same size, same versions.) Manifest in the set directory. Previous backup sets untouched.

## 8. Migration 012 application

- Command: `npx supabase db query --linked -f supabase/.tmp-apply-012.sql` where the temp file is the HEAD blob of `supabase/migrations/012_reconciliation_canonical_tenant_spine.sql` (SHA-256 re-verified = A7E25FA3… immediately before apply; the worktree copy is CRLF due to core.autocrlf and was NOT modified — the blob-extracted LF file was applied instead).
- 01:11:20 UTC start, 01:11:35 UTC finish, 15 s (inside the observed 4–19 s staging band). Exit 0. Single transaction COMMIT (Management-API path suppresses NOTICEs and UPDATE counts; commit proven by canonical columns existing + P6 checks + ledger).
- Post-apply proof: all 9 canonical columns present; P6: bs/qt/bt/rm/rr/rd stamp mismatches 0, all NULL stamps 0, audit NULL user/client 0, bootstrap_012_audit_rows 0, audit_ledger_total 20 (frozen baseline), guards 7/11/12/4, audit DML grants 0/0. B1–B11 embedded assertions passed (exit 0 under fail-on-error semantics).

## 9. Migration ledger

`staging-tmp-record-012.sql` applied (INSERT). Final ledger: `001,002,003,004,005,006,007,008,009,010,011,012` with name `reconciliation_canonical_tenant_spine`.

## 10. Database postchecks

- P6 integrity: all zero (see §8). Null stamp checks: 0 on all seven tables + audit user/client. Registry unchanged: practices=2, practice_memberships=2, client_entities=2, ledger_books=2, default_tenant_identities=2. canonical_audit_ledger: 20 post-migration (delta 0 vs frozen baseline); growth afterwards is solely idempotent login `bootstrap_reuse` rows (see §17). No bootstrap rows (bootstrap_012_audit_rows=0).

## 11. Accounting preservation

`supabase/step-4f-aggregates-union.sql` post-012 diff vs frozen Phase 4 baseline: identical except rows attributable to the authorized test writes, all verified by amount arithmetic:
- Phase 1 smoke (+0.01/−0.01, net 0) — bank_txn_sum unchanged.
- Attack-matrix V-section (statement 0033bf24, qb 2.00) — qb_txn_sum +2.00 exactly.
- Canonical smoke (statement e6a2b535, ±5.00 pair; approved −5.00) — reports_sum_matched −5.00, unmatched_bank +5.00, unmatched_qb +5.00, confidence sum +2.45 (2×~1.0 + 0.45), decisions approve +1, audit match_approved +1.
- Unfreeze verify (statement 025f99b8, 1.00) — counts +1.
No unexplained accounting difference.

## 12. Security/isolation

- SQL attack matrix (step-4e-phase8-attacks.sql, `\set` stripped): 23/23 PASS — audit INSERT/UPDATE/DELETE denied for authenticated, cross-tenant statement/txn/match/QB mutations denied or 0 rows, service-path attacks S1–S5 fail closed (23514/23502), valid A→A ingestions succeed and stamp correctly.
- App-level as Tenant A: B statement report/dashboard 404, B transactions (GET writer) 503 while frozen, own audit 20 own matches / 0 foreign, own report route reachable.
- Grants: authenticated audit DML 0, anon audit grants 0.

## 13. Application smoke

- Pre-012 (freeze OFF): login, pages, reads 200; one minimal bank CSV upload 200 with legacy payloads — no canonical-column error, no canonical RPC dependency (DEFECT-1 repro proven in production).
- Post-012 (freeze ON): pages /reconciliation /upload /settings /review /batch /dashboard all 200; latest/audit/dashboard reads 200; writer probes 503.
- Post-012 (freeze OFF, controlled): upload → auto-match (2) → approve (200, report generated) → report GET 200; all rows stamped.
- Post-unfreeze: minimal upload 200, stamped.

## 14. Unfreeze

Authorized after ALL gate conditions verified true: ledger 001–012, hashes match, postchecks green, accounting preserved, stamps correct, audit ACL passes, cross-tenant probes fail closed, app reads pass, controlled canonical write passes, no unresolved error/warning, no scheduler to pause. `ZAKI_RECONCILIATION_WRITE_FREEZE=0` set; deploy live 2026-08-14 02:04:01 UTC. Maintenance window: 00:49:08Z → 02:04:01Z. Temporary unfrozen windows inside it: 01:41:45–01:47:15Z (zero writes — classifier outage prevented smoke; re-froze immediately) and 01:56:15–01:59:48Z (canonical smoke; re-froze immediately).

## 15. Scheduler

None configured (no Render cron jobs; nightly-match.ts manual). Nothing paused, nothing resumed. Documented.

## 16. Final hashes

| Migration | SHA-256 |
|---|---|
| 010 | AD609305B040063A0C6186C9E3460F8BB886CE8429A1D03D8F48F6D17907902D |
| 011 | 84138BB49A51474C2B7EFDC110780A37AD293A7A5A0E63A2618480DA926D7418 |
| 012 | A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE |

Final state: ledger 001–012; counts bank_statements=11, bank_transactions=634, qb_transactions=425, matches=561, reports=6, decisions=217, audit_log=409, registry 2/2/2/2/2, canonical_audit_ledger=48; freeze OFF; deployed commit 4a0a66f (contains artifact 24d7a37).

## 17. Remaining defects or observations

1. **Login bootstrap noise (pre-existing 011 behavior)**: every authenticated app login appends 4 idempotent `bootstrap_reuse` rows to canonical_audit_ledger (practice/membership/client/book, actor=user, version 011). No entity is created (registry counts stay 2/2/2/2/2). canonical_audit_ledger grew 8 → 48 during the operation purely from this. Not a 012 defect; consider rate-limiting/log-dedup in a later step.
2. **Upload auto-match quality (pre-existing app behavior)**: the Phase 15 verification upload auto-created match 752a6e83 (matched_by=auto, confidence 0.45, reason "date + merchant (partial)", unapproved) pairing bank 4FB-UNFREEZE-TEST (1.00, 07-17) with QB 4FB-CANONICAL-TEST A (−5.00, 07-16) — a QB row already used in an approved match. The review screen surfaces it as low-confidence for the pilot. Unchanged by 012; flagged for pilot review.
3. **core.autocrlf line endings**: worktree copies of migrations 010/011/012 hash differently (CRLF) than the frozen blobs. Normalized (`tr -d '\r'`) hashes match the frozen values; git shows no content diff. Future pre-apply hash checks should normalize EOL or hash `git cat-file blob HEAD:…`.
4. **`supabase db query` limits**: rejects psql meta-commands (`\set`), returns only the last result set, and suppresses NOTICEs/UPDATE counts. Multi-check files must be single UNION ALL statements (step-4fb-p6-union.sql pattern).
5. **Test rows present in production** (all stamped with Tenant A canonical ids, clearly marked): statement 9f3fc8f0 (4FB-TEST-011, Phase 1), statement 0033bf24 + qb 9d6dd5c8 + bank txn 4fccbfde (4e8-valid-1, matrix V-section), statement e6a2b535 + 2 bank + 2 qb + 2 matches + 1 decision + 1 report (4FB-CANONICAL-TEST, Phase 12), statement 025f99b8 + 1 bank txn (4FB-UNFREEZE-TEST, Phase 15), match 752a6e83 (auto). All legitimate-by-procedure test data; pilot may treat them as disposable.
6. Review screen `GET [id]/transactions` intentionally 503 during the freeze window — resolved by unfreeze.

## 18. Step 4 conclusion

**STEP 4 COMPLETE**

Migration 012 is applied to production, the ledger records 001–012, canonical stamps and write-guards are live, accounting is preserved, isolation and audit ACLs fail closed, the app runs canonical-012 behavior with no legacy fallback, freeze is released, and the frozen pre-012 recovery backup plus full evidence artifacts are on disk.
