# Execution Window — Writer Exclusion, Backup/Restore, and Production Runbook

Production target: Supabase project `fqvekbzwghjurkcawpgg` (eu-central-1,
PostgreSQL 17). This document defines the database-side execution exclusion
for the repair window, the mandatory backup/restore drill, and the exact
production-window sequence. Nothing here authorizes the window itself — the
window is authorized separately; this document only makes the mechanics
reviewable and deterministic.

---

## 1. Writer exclusion (database-side, not environment-side)

The `ZAKI_RECONCILIATION_WRITE_FREEZE=1` environment freeze is an
**operational precondition**, not a database lock. The repair therefore takes
database-side exclusion locks itself, and the window additionally requires
verified writer quiescence (§4). Together:

| Threat | Excluded by |
|---|---|
| App writers (current deployed commit) | env freeze (verified) + table locks |
| Stale app instances (old commits without freeze checks) | table locks |
| Direct `service_role` / PostgREST calls | table locks |
| Background workers / nightly matcher | env freeze (nightly abort) + table locks |
| Superuser console sessions (Supabase dashboard SQL editor) | **not excludable by any lock** — verified quiescence + window discipline |

### 1.1 Lock inventory (both stages, identical)

Taken inside the repair transaction, after the shared advisory lock, in this
exact order:

```sql
SELECT pg_advisory_xact_lock(0x5A414B49);                 -- 'ZAKI', shared by both stages
LOCK TABLE public.bank_statements        IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.bank_transactions      IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.qb_transactions        IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_matches IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_audit_log IN ACCESS EXCLUSIVE MODE;
```

Plus row-level `FOR UPDATE` on every manifest target row (UUID-sorted order)
inside the apply block — defense in depth and re-verification of existence.

### 1.2 Why ACCESS EXCLUSIVE

- `ACCESS EXCLUSIVE` conflicts with **every** other lock mode, so any
  INSERT/UPDATE/DELETE/SELECT on the five tables by any other session blocks
  for the duration of the repair transaction (seconds). No writer can commit
  a conflicting change between the drift checks and COMMIT.
- Ordinary repair-only advisory locking is explicitly rejected as
  insufficient: pre-013, the deployed application has no database-side write
  discipline for `reconciliation_matches` (the 013 guard trigger and endpoint
  locks do not exist yet), so nothing would consult a repair advisory lock.
- The freeze window makes the reader-blocking side effect acceptable: the app
  is frozen, and the repair transaction is short (verified rehearsal: a few
  seconds).

### 1.3 Why the order is deadlock-free for controlled paths

The lock order mirrors the controlled writers' natural acquisition order:

- upload: `bank_statements` → `bank_transactions`
- QB sync: `qb_transactions`
- matcher/manual/approval: `reconciliation_matches` → `reconciliation_audit_log`

Every controlled writer acquires locks in a prefix of this order. The repair
acquires table locks in the same order before taking any row lock. A
transaction holding a lock on a *later* table and waiting for an *earlier*
one cannot occur for controlled writers, so no cycle can form. A writer that
holds an early lock and waits for a later one simply finishes (we have not
locked the later table yet) and releases — we then proceed. Writers blocked
on our locks are released at COMMIT/ROLLBACK.

`reconciliation_decisions` and `reconciliation_reports` are deliberately NOT
locked: they are not classification sources for the repair, and decision
writes do not conflict with supersession correctness.

### 1.4 Hard stop conditions on exclusion

Before executing either stage against production, ALL of the following must
be verified and recorded; any failure stops the window:

1. `ZAKI_RECONCILIATION_WRITE_FREEZE=1` set on the deployed Render service
   and re-verified at window time (13/13 route probes green, nightly matcher
   aborts, store-level assertions throw).
2. The deployed app commit includes the freeze-gap fix `ebeed9d`
   (decision-store asserts freeze before any mutation).
3. No active database sessions are running reconciliation writes (checked
   immediately before the window via `pg_stat_activity` against the five
   tables' DML; the freeze makes this the steady state).
4. The repair transaction's table-lock acquisition order is confirmed to be
   the §1.1 order (code review of the committed files, SHA-locked).

If any of 1–4 cannot be verified, the window is aborted — the repair never
relies on the environment freeze alone.

---

## 2. Backup/restore drill (mandatory, repeated at window time)

The window's first act is a **fresh** freeze-time backup. Old rehearsal dumps
never substitute.

1. **Fresh schema dump**: `supabase db dump --linked --project-ref
   fqvekbzwghjurkcawpgg -f <window>/prod-schema-<date>.sql`
   (always the explicit `--project-ref`; the local CLI is unlinked).
2. **Fresh data dump**: same command with `--data-only` →
   `prod-data-<date>.sql`.
3. **SHA-256** both files; record in the window log.
4. **Scratch restore** (documented prerequisites, verified in rehearsal):
   - local Postgres (Supabase image, `supabase_db_Zaki-ledger`), scratch
     database `repair_drill`;
   - pre-create schemas `extensions` + `vault`;
   - `CREATE PUBLICATION supabase_realtime;`
   - restore a Supabase `auth` schema (the locally exported
     `local-auth-schema.sql`);
   - restore schema dump, then data dump, as `supabase_admin`.
5. **Parity checks on the scratch copy** (all must pass before the window
   proceeds):
   - schema/table parity: objects, triggers, indexes present;
   - row-count parity (9/9 tables): `bank_statements` 12,
     `bank_transactions` 646, `qb_transactions` 437,
     `reconciliation_matches` 573, `reconciliation_audit_log` 409,
     `reconciliation_reports` 6, `reconciliation_decisions` 217,
     canonical ledger 52, tenant identities 2;
   - reconciliation parity: duplicate live-auto endpoints 107, approved 409,
     manual 0;
   - canonical/audit parity: canonical layer empty, audit actions
     `match_approved` ×409;
   - restore usability proof: the stage-1 SQL parses and its P0 drift
     preconditions pass against the scratch copy (proving the restore is a
     faithful pre-image of production).
6. Record all hashes, counts, and timestamps in the window log; only then
   may the repair run against production.

---

## 3. Production-window sequence (exact order)

1. **Authorize.** The window and its operator are authorized separately.
   The accountant completes and signs the stage-2 authorization manifest
   (§5 of `authorization-manifest-schema.md`). If any R6 decision or any
   candidate row remains unauthorized, stage 2 simply retires fewer rows —
   never more, and never a row outside the signed manifest.
2. **Freeze.** Set/verify `ZAKI_RECONCILIATION_WRITE_FREEZE=1`; verify the
   deployed commit (includes `ebeed9d`); run the 13/13 route probes and the
   nightly abort check; confirm no active reconciliation writers
   (§1.4).
3. **Backup.** Execute §2 in full against the frozen production instance.
4. **Rebuild the executable artifacts from the committed package** (do not
   hand-edit the SQL):
   - `python3 bin/build_repair_package.py --snapshot-dir <snapshot> verify`
     → must print `VERIFY OK`;
   - regenerate stage 2 from the accountant-signed manifest:
     `python3 bin/build_repair_package.py --snapshot-dir <snapshot> sql
     --auth-manifest <signed-manifest.csv>`; review the diff against the
     committed rehearsal version (only decision columns and manifest hash may
     differ); re-run `verify --auth-manifest <signed-manifest.csv>`.
5. **Stage 1** — execute `14a-stage1-unapproved-repair.sql` via the
   sanctioned connection. Expected: `STAGE 1: superseded 154 rows`, all P2
   postconditions pass, COMMIT.
6. **Stage 1 rerun (idempotency proof)** — re-execute the identical file.
   Expected: dispatcher → `noop`, verified state, COMMIT, zero new writes.
7. **Report gate.** Report the exact intermediate state: 573 total, 154
   superseded, 419 live, 91 duplicate live-auto endpoints, 154 repair audit
   rows. STOP. Stage 2 is a separate authorization boundary and must not
   proceed in the same session without the signed manifest being present
   before stage 1 starts.
8. **Stage 2** — execute `14b-stage2-approved-repair.sql` (the regenerated
   version bound to the signed manifest). Expected:
   `STAGE 2: superseded <n> authorized rows` (n = rows with
   `APPROVED_FOR_RETIREMENT` + `RETIRE`; 98 if fully authorized), all P2
   postconditions pass, COMMIT. Every stage-2 audit row records the
   accountant's identity.
9. **Stage 2 rerun (idempotency proof)** — expected no-op. Optionally rerun
   stage 1: expected no-op (verifies its own operation state).
10. **Migration gate.** If duplicate live-auto endpoints = 0: under the
    preflight's separate authorization, re-run the preflight Phase-4 check
    (expect 0), take another freeze-time backup, confirm the deployed app
    commit, apply migration 013, run the post-apply checklist (C1–C5/C2b +
    counts), deploy the hardening app, controlled smoke, unfreeze.
    If duplicate endpoints > 0 (partial authorization): migration 013 remains
    BLOCKED; do not force additional authorizations merely to satisfy it.
    Unfreeze after securing the new freeze-time backup.
11. **Record.** Archive the window log, dump hashes, manifest hashes, SQL
    output, and rerun output with the production-window record.

## 4. Rehearsal-verified timings and failure behavior

See `rehearsal/EVIDENCE.md` for the committed evidence: restore parity,
stage-1/stage-2 outputs, rerun no-ops, and the five drift/failure-injection
cases — every one aborts with zero partial changes (single transaction
rollback).
