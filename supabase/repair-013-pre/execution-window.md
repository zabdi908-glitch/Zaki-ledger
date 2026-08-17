# Execution Window — REPAIR ONLY Runbook

Production target: Supabase project `fqvekbzwghjurkcawpgg` (eu-central-1,
PostgreSQL 17). This document defines the database-side execution exclusion,
the mandatory backup/restore drill, and the exact production-window sequence
for the **historical repair only** (prep, stage 1, stage 2).

**This runbook ends at the repair.** Migration 013 application, app
deployment, and unfreeze are SEPARATE, separately authorized future
operations and are deliberately absent from this sequence. Nothing here
authorizes the window itself — the window is authorized separately; this
document only makes the mechanics reviewable and deterministic.

---

## 1. Writer exclusion (database-side, not environment-side)

The `ZAKI_RECONCILIATION_WRITE_FREEZE=1` environment freeze is an
**operational precondition**, not a database lock. The repair therefore takes
database-side exclusion locks itself, and the window additionally requires
verified writer quiescence (§2). Together:

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
LOCK TABLE public.client_entities        IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_matches IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_audit_log IN ACCESS EXCLUSIVE MODE;
```

Plus row-level `FOR UPDATE` on every manifest target row (UUID-sorted order)
inside the apply block — defense in depth and re-verification of existence.

`client_entities` is locked because practice identity participates in the
manifest drift checks (each manifest row verifies its tenant row's
`practice_id`, `status = 'active'`, `archived_at IS NULL`).

### 1.2 Why ACCESS EXCLUSIVE

- `ACCESS EXCLUSIVE` conflicts with **every** other lock mode, so any
  INSERT/UPDATE/DELETE/SELECT on the six tables by any other session blocks
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
- `client_entities` is a tenant table with no matching-endpoint writers; it
  sits between QB and matches so every writer acquiring matches/matches+audit
  locks also holds earlier prefixes.

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

---

## 2. Hard stop conditions on exclusion (verified before the window)

ALL of the following must be verified and recorded; any failure stops the
window:

1. `ZAKI_RECONCILIATION_WRITE_FREEZE=1` set on the deployed Render service
   and re-verified at window time (13/13 route probes green, nightly matcher
   aborts, store-level assertions throw).
2. The deployed app commit includes the freeze-gap fix `ebeed9d`
   (decision-store asserts freeze before any mutation).
3. No active database sessions are running reconciliation writes (checked
   immediately before the window via `pg_stat_activity` against the six
   tables' DML; the freeze makes this the steady state).
4. The repair transaction's table-lock acquisition order is confirmed to be
   the §1.1 order (code review of the committed files, SHA-locked).

If any of 1–4 cannot be verified, the window is aborted — the repair never
relies on the environment freeze alone.

---

## 3. Environment-mode identity barrier (mechanical, not a warning)

Every generated artifact carries `environment_mode = REHEARSAL | PRODUCTION`
bound into the SQL (a hard in-transaction identity gate executed before any
lock or write), the audit evidence, the freeze record, and the artifact
identity hash.

- **REHEARSAL artifacts** execute only against `current_database() =
  'repair_drill'` — they can never run against production.
- **PRODUCTION artifacts** execute only against `current_database() =
  'postgres'` on PostgreSQL 17 with the session GUC
  `zaki.repair_project_ref = 'fqvekbzwghjurkcawpgg'`. The production driver
  must set it, e.g.:

  ```bash
  PGOPTIONS="-c zaki.repair_project_ref=fqvekbzwghjurkcawpgg" \
    psql "$PROD_CONN" -v ON_ERROR_STOP=1 -f <frozen-14a.sql>
  ```

  If the GUC is unset, wrong, or the database identity differs, the artifact
  aborts before touching anything.

---

## 4. Backup/restore drill (mandatory, repeated at window time)

The window's first act is a **fresh** freeze-time backup. Old rehearsal dumps
never substitute.

1. **Fresh schema dump**: `supabase db dump --project-ref
   fqvekbzwghjurkcawpgg -f <window>/prod-schema-<date>.sql`
   (always the explicit `--project-ref`; the local CLI is unlinked and must
   never use `--linked`).
2. **Fresh data dump**: same command with `--data-only` →
   `prod-data-<date>.sql`.
3. **SHA-256** both files; record in the window log.
4. **Scratch restore** (documented prerequisites, verified in rehearsal):
   - local Postgres (Supabase image, `supabase_db_Zaki-ledger`), scratch
     database `repair_drill`;
   - pre-create schemas `extensions` + `vault`;
   - `CREATE PUBLICATION supabase_realtime;`
   - restore a Supabase `auth` schema (the locally exported
     `local-auth-schema.sql`; verify it contains the snapshot's user identity
     anchors, seeding them first if not);
   - restore schema dump, then data dump, as `supabase_admin`:
     `rehearsal/restore-scratch.sh --schema-dump <window>/prod-schema-<date>.sql
     --data-dump <window>/prod-data-<date>.sql
     --schema-sha256 <sha> --data-sha256 <sha>`
     (the driver verifies the supplied hashes before restoring).
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
   - restore usability proof: the frozen stage-1 SQL parses and its P0 drift
     preconditions pass against the scratch copy (proving the restore is a
     faithful pre-image of production).
6. Record all hashes, counts, and timestamps in the window log; only then
   may the repair run against production.

---

## 5. Production-window sequence (REPAIR ONLY — exact order)

1. **Verify package identity.** On the authorized operator machine, check out
   the exact branch/commit recorded in the authorization; run
   `git rev-parse HEAD` and
   `python3 bin/build_repair_package.py verify --auth-manifest
   manifests/stage2-rehearsal-authorization-manifest.json` (must print
   `VERIFY OK`), and re-check the SHAs recorded in
   `manifests/manifest-identities.json` against the authorization record.
2. **Verify production environment identity.** Confirm the connection target
   is `db.fqvekbzwghjurkcawpgg.supabase.co` (explicit `--project-ref
   fqvekbzwghjurkcawpgg`; the legacy project `gzwtxebgevgapchoslmp` is never
   a target), PostgreSQL 17, database `postgres`. Record the verification.
3. **Verify the deployed freeze-capable app.** Deployed commit includes
   `ebeed9d`; freeze contract checks pass on the deployment.
4. **Enable freeze everywhere.** `ZAKI_RECONCILIATION_WRITE_FREEZE=1` on the
   Render service; re-verify (§2.1).
5. **Prove writer quiescence.** `pg_stat_activity` shows no reconciliation
   DML against the six locked tables; 13/13 route probes green; nightly
   matcher aborts (§2).
6. **Fresh schema/data dumps.** §4 steps 1–2 against the frozen instance.
7. **Hash the dumps.** §4 step 3; record in the window log.
8. **Scratch restore.** §4 step 4 with explicit dump paths + hashes.
9. **Full parity/recovery proof.** §4 step 5 — every parity check and the
   restore-usability proof must pass on the fresh scratch copy.
10. **Execute repair prep explicitly.** Run
    `supabase/repair-013-pre/13-repair-prep.sql` against production (the
    additive supersession columns + audit-evidence immutability trigger;
    idempotent). Record its output.
11. **Freeze the exact stage-1 artifact.**
    `python3 bin/build_repair_package.py freeze --stage 1
    --environment-mode PRODUCTION --project-ref fqvekbzwghjurkcawpgg
    --out-dir <window-artifacts>`, then
    `python3 bin/build_repair_package.py verify --artifact
    <window-artifacts>/freeze-14a-*.json` (must print `VERIFY OK`).
    Execute ONLY that hash-verified artifact, with the production driver
    (§3, GUC set), inside the window. Expected: `STAGE 1: superseded 154
    rows`, `STAGE 1: wrote 154 audit rows`, all P2 postconditions pass,
    COMMIT.
12. **Verify the exact stage-1 postcondition.** Re-execute the identical
    frozen file: the dispatcher must report a verified NO-OP with byte-exact
    audit evidence. Record the stage-1 execution proof (artifact SHA,
    executed_at, result) in the window log.
13. **STOP — authorization checkpoint.** No stage-2 artifact exists or can
    be built before this point. Report the exact intermediate state: 573
    total, 154 superseded, 419 live, 91 duplicate live-auto endpoints, 154
    repair audit rows. End the session.
14. **Accountant reviews and authorizes stage 2 (including R6).** The
    accountant reviews `r6-review-packet.md` + the post-stage-1 state, and
    signs the decision-only authorization manifest
    (`authorization-manifest-schema.md` §3–§6) with `environment_mode =
    PRODUCTION` and confirmation timestamps after the recorded stage-1
    execution time. Record the signed manifest SHA in the window log.
15. **Build + hash + independently verify the exact production stage-2
    artifact.** `freeze --stage 2 --environment-mode PRODUCTION
    --auth-manifest <signed.json> --stage1-artifact <window-artifacts
    /14a-*.sql> --stage1-execution-proof <proof.json> --project-ref
    fqvekbzwghjurkcawpgg --out-dir <window-artifacts>`, then
    `verify --artifact <window-artifacts>/freeze-14b-*.json`. Review the
    freeze record; the artifact is immutable and hash-bound.
16. **Execute the exact stage-2 artifact.** Only the hash-verified file,
    inside the window, with the production driver. Expected:
    `STAGE 2: superseded <n> authorized rows` (n = signed RETIRE decisions),
    all P2 postconditions pass, COMMIT. Every stage-2 audit row records the
    confirming accountant's identity. Re-execute once more: verified NO-OP
    with byte-exact audit evidence (altered evidence would abort).
17. **Verify the exact final repair state.** Report: 573 total,
    154 + n superseded, live count, remaining duplicate live-auto endpoints
    (0 if fully authorized), repair audit rows 154 + n, per-operation
    verification (154 rows carry the stage-1 operation id, n the stage-2
    operation id). Record everything in the window log.
18. **STOP.** Archive the window log: package commit SHA, artifact SHAs,
    freeze records, manifest hashes, dump hashes, execution outputs, and
    rerun outputs.

Migration 013 application, app deployment, and unfreezing are NOT part of
this runbook and require separate authorization.

---

## 6. Rehearsal-verified timings and failure behavior

See `rehearsal/EVIDENCE.md` for the committed evidence: restore parity,
stage-1/stage-2 outputs, rerun no-ops, the drift/failure-injection cases,
and the authorization-binding failure/substitution cases — every one aborts
with zero partial changes (single transaction rollback).
