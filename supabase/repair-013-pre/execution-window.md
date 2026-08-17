# Execution Window — REPAIR ONLY Runbook (final)

Production target: Supabase project `fqvekbzwghjurkcawpgg` (eu-central-1,
PostgreSQL 17). This document defines the database-side execution exclusion,
the finite lock/statement timeout policy, the mandatory backup/restore
drill, and the exact production-window sequence for the **historical repair
only** (prep, stage 1, stage 2).

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

Taken inside the repair transaction, in this exact order (environment
identity validation and the finite timeouts come FIRST — a wrong-database
invocation must abort before taking or waiting on any lock):

```sql
-- P0.0 environment-mode identity gate (REHEARSAL vs PRODUCTION; aborts
--      before anything else on a wrong database identity)
-- P0a finite timeouts (SET LOCAL; see §1.4)
-- P0b frozen-artifact sha gate (driver-supplied GUC; see §1.5)
-- P0b2 execution-package sha gate (driver-supplied GUC, embedded-literal
--      match; see §1.5 and EXECUTION_PACKAGE.md)
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

### 1.4 Finite lock/statement timeout policy (reviewed values, not arbitrary)

Before ANY potentially blocking lock, every repair artifact sets:

```sql
SET LOCAL lock_timeout      = '30s';
SET LOCAL statement_timeout = '120s';
```

Analysis of the values (also documented in the artifact header):

- **lock_timeout 30s** — against a frozen, verified-quiescent app every
  ACCESS EXCLUSIVE acquisition is immediate (rehearsal-verified: the whole
  lock set acquires in under a second). 30s is ~10x+ headroom for a stray
  short writer and still strictly finite: a session holding a conflicting
  lock longer than 30s means an unexcluded writer is active. Timeout →
  SQLSTATE `55P03` (`lock_not_available`) → the whole transaction aborts
  (rollback; zero partial changes). **The runbook treats it as STOP** —
  investigate and re-run the window from §5, never retry blindly during
  unknown writer activity.
- **statement_timeout 120s** — every repair statement is millisecond-scale
  on the snapshot population (573 matches, 409 audit rows; rehearsal-
  verified). 120s is ~10³–10⁴× headroom and still finite: a statement
  exceeding it means something pathological (bloat, trigger loop, index
  corruption). Timeout → SQLSTATE `57014` (`query_canceled`) → transaction
  aborts (rollback). **STOP**, never retry blindly.

Both are transaction-local (`SET LOCAL`): an error in the transaction
aborts it entirely, so a timeout can never leave partial repair state. The
rehearsal suite proves the contract: `auth-g16-lock-timeout` (held
conflicting lock → 55P03, full-state digest identical) and
`auth-g17-statement-timeout` (57014 + rollback semantics, zero changes).

### 1.5 Frozen-artifact + execution-package binding (driver-supplied GUCs)

The execution driver verifies the artifact SHA-256 against its freeze
record AND the stable EXECUTION_PACKAGE_SHA256 against the checked-out
package (`bin/build_repair_package.py package-sha` — see
EXECUTION_PACKAGE.md), then passes both into the repair transaction via
PGOPTIONS:

```bash
PGOPTIONS="-c zaki.repair_project_ref=fqvekbzwghjurkcawpgg \
           -c zaki.repair_artifact_sha256=<artifact-sha256> \
           -c zaki.repair_package_sha256=<execution-package-sha256>" \
  psql "$PROD_CONN" -v ON_ERROR_STOP=1 -f <frozen.sql>
```

The SQL-side gates abort on a missing/malformed/mismatched value: P0b
(artifact sha, recorded verbatim into every repair audit row's immutable
evidence — including the exact frozen stage-2 artifact SHA-256, blocker 4)
and P0b2 (execution-package sha, which must equal the literal embedded in
the artifact — the content-based package identity is stable across
evidence-only commits, unlike a git-HEAD binding). The no-op/idempotency
revalidation compares the artifact sha byte-exactly, so a rerun only
verifies as a no-op when the exact frozen artifact sha is supplied.

The stage-1 execution receipt (public.repair_stage1_receipt) additionally
records the execution-package sha and the stage-1 artifact sha; the
stage-2 artifact validates the actual receipt row and independently
recomputes the exact stage-1 state before any stage-2 work.

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
bound into the SQL (a hard in-transaction identity gate executed FIRST —
before timeouts, the artifact-sha gate, and any lock), the audit evidence,
the freeze record, and the artifact identity hash.

- **REHEARSAL artifacts** execute only against `current_database() =
  'repair_drill'` — they can never run against production.
- **PRODUCTION artifacts** execute only against `current_database() =
  'postgres'` on PostgreSQL 17 with the session GUC
  `zaki.repair_project_ref = 'fqvekbzwghjurkcawpgg'` (§1.5 driver command).

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
     (`--schema-dump` and `--data-dump` are REQUIRED — the tool has no
     defaults; the driver verifies the supplied hashes before restoring).
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

## 5. Production-window sequence (REPAIR ONLY — exact order, 23 steps)

1. **Verify the exact final Git SHA AND the execution-package identity.**
   On the authorized operator machine, check out the exact package commit
   recorded in the authorization (P = execution-package commit; E =
   evidence-only descendant); run `git rev-parse HEAD` and record the FULL
   sha. It must equal the package commit recorded in
   `rehearsal/EVIDENCE.md` and the authorization record. Then run
   `python3 bin/build_repair_package.py package-sha` and confirm it prints
   the recorded `EXECUTION_PACKAGE_SHA256` (the stable content-based
   identity the artifacts bind — the artifacts bind this, never the git
   HEAD). Then run `python3 bin/build_repair_package.py verify
   --auth-manifest manifests/stage2-rehearsal-authorization-manifest.json`
   (must print `VERIFY OK`) and `python3 bin/test_builder_binding.py`
   (all pass, including the clean-clone verification).
2. **Verify all relevant artifact hashes.** Re-check the SHAs recorded in
   `manifests/manifest-identities.json` and `rehearsal/EVIDENCE.md`
   (manifests, immutable basis, migration 013
   `d9086ad5…` — the migration file itself is NOT applied here, only its
   identity is recorded) against the checked-out files.
3. **Verify production environment identity.** Confirm the connection target
   is `db.fqvekbzwghjurkcawpgg.supabase.co` (explicit `--project-ref
   fqvekbzwghjurkcawpgg`; the legacy project `gzwtxebgevgapchoslmp` is never
   a target), PostgreSQL 17, database `postgres`. Record the verification.
4. **Verify the deployed freeze-capable app.** Deployed commit includes
   `ebeed9d`; freeze contract checks pass on the deployment.
5. **Enable freeze everywhere.** `ZAKI_RECONCILIATION_WRITE_FREEZE=1` on the
   Render service; re-verify (§2.1).
6. **Prove writer quiescence.** `pg_stat_activity` shows no reconciliation
   DML against the six locked tables; 13/13 route probes green; nightly
   matcher aborts (§2).
7. **Review the finite timeout policy.** Confirm §1.4 is understood by every
   window participant: `lock_timeout 30s` (SQLSTATE 55P03),
   `statement_timeout 120s` (SQLSTATE 57014); **timeout = STOP**, full
   transaction rollback, no blind retry loop during unknown writer
   activity.
8. **Fresh schema/data dumps.** §4 steps 1–2 against the frozen instance.
9. **Hash the dumps.** §4 step 3; record in the window log.
10. **Scratch restore.** §4 step 4 with explicit dump paths + hashes.
11. **Full parity/recovery proof.** §4 step 5 — every parity check and the
    restore-usability proof must pass on the fresh scratch copy.
12. **Execute repair prep explicitly.** Run
    `supabase/repair-013-pre/13-repair-prep.sql` against production (the
    additive supersession columns + audit-evidence immutability trigger;
    idempotent). Record its output.
13. **Freeze + hash the exact stage-1 execution artifact.**
    `python3 bin/build_repair_package.py freeze --stage 1
    --environment-mode PRODUCTION --project-ref fqvekbzwghjurkcawpgg
    --out-dir <window-artifacts>`, then
    `python3 bin/build_repair_package.py verify --artifact
    <window-artifacts>/freeze-14a-*.json` (must print `VERIFY OK` — the
    verifier regenerates the expected bytes and requires byte-identity).
    Record the artifact sha256.
14. **Execute stage 1.** Only the hash-verified file, with the production
    driver (§1.5, ALL GUCs set), inside the window. Expected: `STAGE 1:
    superseded 154 rows`, `STAGE 1: wrote 154 audit rows`, `STAGE 1: wrote
    execution receipt <sha>`, all P2 postconditions pass, COMMIT.
15. **Stage-1 full-state + exact database-side checkpoint.** (a) Re-execute
    the identical frozen file once: the dispatcher must report a verified
    NO-OP with byte-exact audit evidence. (b) Export the database-side
    execution receipt written by stage 1 inside its own transaction
    (`extract/13-stage1-receipt.sql` → `<window-artifacts>/stage1-receipt-
    PRODUCTION-<sha12>.json`) and record its canonical sha. The receipt
    binds the execution-package sha, the stage-1 artifact sha, the
    operation id, mode/project identity, the target-manifest sha, the
    exact 154-target digest, the survivor-mapping digest, the stage-1
    audit digest, the postcondition digest, and database-time executed_at.
    The EXPORT is operator evidence only — the immutable receipt ROW is
    the authorization root that the stage-2 artifact validates (step 21);
    a caller-created stage-1 "proof" JSON is never accepted as
    authorization (rehearsal case G20).
16. **STOP — authorization checkpoint.** No stage-2 artifact exists or can
    be built before this point. Report the exact intermediate state: 573
    total, 154 superseded, 419 live, 91 duplicate live-auto endpoints, 154
    repair audit rows, 1 stage-1 execution receipt row. End the session.
17. **Accountant reviews and authorizes stage 2 (including R6).** The
    accountant reviews `r6-review-packet.md` + the post-stage-1 state, and
    signs the decision-only JSON authorization manifest
    (`authorization-manifest-schema.md` §3–§6) with `environment_mode =
    PRODUCTION` and confirmation timestamps after the recorded stage-1
    execution time. Record the signed manifest SHA in the window log.
18. **Build the exact production stage-2 artifact.** `freeze --stage 2
    --environment-mode PRODUCTION --auth-manifest <signed.json>
    --stage1-artifact <window-artifacts>/14a-*.sql
    --stage1-receipt <window-artifacts>/stage1-receipt-*.json
    --project-ref fqvekbzwghjurkcawpgg --out-dir <window-artifacts>` (the
    freeze independently revalidates every derivable field of the receipt
    export and the frozen stage-1 artifact; the actual authorization is
    the database-side receipt row, validated by the artifact itself).
19. **Regenerate + independently verify.** `verify --artifact
    <window-artifacts>/freeze-14b-*.json --stage1-artifact
    <window-artifacts>/14a-*.sql --auth-manifest <signed.json>
    --stage1-receipt <window-artifacts>/stage1-receipt-*.json` (must print
    `VERIFY OK`): the verifier REGENERATES the expected stage-2 bytes into
    a temporary location and requires byte-identity + SHA-256 match with
    the freeze record — a coordinated SQL+freeze-record modification
    fails here.
20. **Hash/freeze record.** Record the freeze record sha and the frozen
    artifact sha256 in the window log; the artifact is immutable and
    hash-bound.
21. **Execute the exact frozen stage-2 artifact.** Only the hash-verified
    file, inside the window, with the production driver (§1.5). Expected:
    `STAGE 2: stage-1 execution receipt <sha> validated (digests recomputed
    from live state)`, `STAGE 2: superseded <n> authorized rows` (n =
    signed RETIRE decisions), all P2 postconditions pass, COMMIT. Every
    stage-2 audit row records the confirming accountant's identity AND the
    exact frozen stage-2 artifact SHA-256 in immutable evidence. The
    stage-2 artifact first validates the ACTUAL database-side stage-1
    receipt (exactly one row; canonical hash recomputed; package/artifact/
    mode/project/manifest bindings; target/survivor/audit/postcondition
    digests recomputed from live state) and revalidates the EXACT stage-1
    result (all 154 targets: operation id, reason, survivor, original
    unapproved state, accounting identity, byte-exact audit rows — any
    drift aborts). Re-execute once more: verified NO-OP with byte-exact
    audit evidence (altered evidence aborts).
22. **Verify the exact final repair state.** Report: 573 total,
    154 + n superseded, live count, remaining duplicate live-auto endpoints
    (0 if fully authorized), repair audit rows 154 + n, per-operation
    verification (154 rows carry the stage-1 operation id, n the stage-2
    operation id), 1 intact stage-1 execution receipt. Capture the
    full-state digest (`rehearsal/state-digest.sh` logic) and record it in
    the window log.
23. **STOP.** Archive the window log: package commit SHA,
    EXECUTION_PACKAGE_SHA256, artifact SHAs, freeze records, stage-1
    receipt canonical sha, manifest hashes, dump hashes, execution
    outputs, rerun outputs, and the final-state digest.

Migration 013 application, app deployment, and unfreezing are NOT part of
this runbook and require separate authorization.

---

## 6. Rehearsal-verified timings and failure behavior

See `rehearsal/EVIDENCE.md` for the committed evidence: restore parity,
stage-1/stage-2 outputs, rerun no-ops, the drift/failure-injection cases
(all with FULL-STATE digest equality), the post-checkpoint stage-1 mutation
cases (reason/survivor/operation/approval/audit drift — stage 2 aborts with
zero changes), the lock-timeout case (55P03), the statement-timeout contract
(57014), the missing-sha-GUC gate, the missing-package-sha-GUC gate, the
forged-receipt rejection (stage 2 without a database-side receipt — zero
writes), the receipt-immutability tamper cases, and the builder-level
binding tests — every one fails closed with zero partial changes (single
transaction rollback).
