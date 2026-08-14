# Step 4F-B — Production Command Package (PREPARED, NOT EXECUTED)

Every command below was prepared during Step 4F-A preflight. NOTHING in this
file has been executed against production. Commands that change production are
explicitly marked:

`[PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]`

Read-only commands carry no marker. Verify each file's SHA / content before use.

Reference values:
- Production project ref: `fqvekbzwghjurkcawpgg`
- App artifact: `zakiledger` commit `24d7a37` (HEAD `5ba1e6a` = docs only)
- Frozen 012 SHA-256: `A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE`
- Final backup set: `production-backup-pre-012-final-20260813-213129/`
  (restore drill green: parity 87/87, aggregates identical, 012 rehearsal clean)

---

## A. Deploy freeze-capable app (011 DB, freeze OFF)

1. Merge artifact to `main` and push (triggers Render auto-deploy):
   [PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]
   ```powershell
   git checkout main
   git merge 24d7a37 --ff-only   # or merge agent/step3-canonical-foundation if it contains exactly 5ba1e6a
   git push origin main
   ```
2. Confirm Render deploy status (dashboard / render MCP). Do NOT set
   `ZAKI_RECONCILIATION_WRITE_FREEZE` yet.
3. Verify app against 011 (read-only probes):
   ```powershell
   Invoke-RestMethod https://<render-app>/api/reconciliation/latest   # expect 200
   ```

## B. Enable freeze

[PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]
- Render → service → Environment: add `ZAKI_RECONCILIATION_WRITE_FREEZE=1`,
  save, redeploy/restart the service.

## C. Verify freeze (read-only probes; expect 503 on all writers, 200 on reads)

```powershell
# writers (expect 503 + "Reconciliation writes are temporarily frozen for maintenance")
Invoke-WebRequest https://<render-app>/api/reconciliation/upload -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/on-demand -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/<id>/match -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/<id>/approve -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/<id>/reject -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/<id>/unapprove -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/<id>/invoice-match -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/<id>/transactions -UseBasicParsing  # GET writer
Invoke-WebRequest https://<render-app>/api/reconciliation/classify-merchants -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/preferences -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/qb-transactions -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/qb-transactions/upload -Method POST -UseBasicParsing
Invoke-WebRequest https://<render-app>/api/reconciliation/qb-transactions/sync -Method POST -UseBasicParsing
# reads (expect 200)
Invoke-RestMethod https://<render-app>/api/reconciliation/latest
Invoke-RestMethod https://<render-app>/api/reconciliation/audit
# nightly (expect "Reconciliation writes are frozen — nightly match aborted.", zero writes)
node zakiledger/scripts/nightly-match.ts
```

## D. Final Migration 012 hash verification (read-only)

```bash
sha256sum supabase/migrations/012_reconciliation_canonical_tenant_spine.sql
# expect A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE
```

## E. Backup verification (read-only)

```bash
# confirm the final set exists and hashes match the manifest
sha256sum production-backup-pre-012-final-20260813-213129/*.sql
# expect values from production-backup-pre-012-final-20260813-213129/MANIFEST.md
```

## F. Migration 012 production application

[PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]

```bash
npx supabase db query --linked -f supabase/migrations/012_reconciliation_canonical_tenant_spine.sql
# expect: exit 0; NOTICE "Migration 012 Z2: bootstrapped 0 eligible users missing registry";
# backfill UPDATE 7 / 628 / 422 / 558 / 5 / 216 / 408
```

Then record the ledger row:

[PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]

```bash
npx supabase db query --linked -f staging-tmp-record-012.sql
# expect: INSERT 0 1; ledger 001..012
```

## G. Database postchecks (read-only)

```bash
npx supabase db query --linked -f supabase/step-4e-phase6-integrity.sql
# expect all P6 checks: 0 mismatches, 0 NULLs, 0 bootstrap rows, audit_ledger 8,
# guards 7/11/12/4, grants 0/0
```

## H. Canonical app verification (read-only)

```bash
# app restarted (optional); verify reads while freeze ON
Invoke-RestMethod https://<render-app>/api/reconciliation/latest   # 200
```

## I. Controlled write smoke

[PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]

Only after G+H pass: disable freeze (`ZAKI_RECONCILIATION_WRITE_FREEZE` unset
on Render + redeploy), then run the controlled workflow through the app UI/API
as pilot user A (bank CSV upload → QB upload → match → approve → report). Every
new row must carry A's registry `client_entity_id`/`ledger_book_id`.

## J. Isolation probes (read-only)

```bash
# after I: cross-tenant + audit-forgery probes as authenticated A
# (step-4e-phase8-attacks.sql equivalents via app/PostgREST)
# expect: all denied / 0 rows / 23514 / 23502; any success = NO-GO
```

## K. Unfreeze

[PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]

```powershell
# Render → service → Environment: remove ZAKI_RECONCILIATION_WRITE_FREEZE, redeploy
# verify: POST /api/reconciliation/upload returns 200 (Stage F behavior)
```

## L. Scheduler resume

[PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]

Re-enable any scheduler paused in Step 7 of the runbook; confirm one scheduled
run completes with canonical stamps.
