# Historical Repair Design Artifacts — 013 Pre-Dedup (DESIGN ONLY)

These files are **design artifacts under review**. They are NOT migrations and
must never be applied by `supabase db push` (which is why they live outside
`supabase/migrations/`). Nothing here may run against production without an
explicit, separately authorized repair operation (see
`docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md`).

- `13-repair-prep.sql` — adds the four `superseded_*` columns to
  `reconciliation_matches` and four audit columns to `reconciliation_audit_log`
  (identical idempotent DDL to migration 013 Z1). Runs BEFORE migration 013:
  013's Z2 precondition refuses to apply while duplicate live auto claims
  exist, so the supersession mechanism must exist first.
- `14-repair-op.sql` — one-transaction dedup operation. P0 dispatcher
  (pristine / already-applied / abort), S1 supersedes all 154 unapproved
  duplicate live-auto rows, S2a/S2b/S2c supersede the 98 reviewed approved
  rows, P1 assertions. Zero DELETEs; 252 audit rows; idempotent; advisory
  lock. Rehearsed green on a faithful local restore of production
  (2026-08-16): run 1 = 154/1/93/4 superseded, run 2 = no-op, migration 013
  then applies cleanly.

The operation id in `14-repair-op.sql` is a placeholder; the sanctioned
runbook substitutes a freshly minted UUID per run.
