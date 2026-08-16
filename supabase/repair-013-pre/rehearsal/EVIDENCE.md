# Rehearsal Evidence — Historical Repair Package (committed, sanitized)

Rehearsal executed 2026-08-17 against a **local scratch restore** of the
production snapshot inside the local Supabase container
(`supabase_db_Zaki-ledger`, scratch database `repair_drill`). Production was
never touched; no production dump contents are committed here — only hashes,
counts, and outputs sufficient to reproduce the conclusions. Raw logs live
outside the repo (`/tmp/zaki-repair-rehearsal/`); the committed record below
reproduces their meaningful content.

The rehearsed artifacts are the FINAL split scripts and manifests:
`bin/build_repair_package.py verify` reported `VERIFY OK` before every run
(hashes, classification counts, and SQL binding consistent; SQL byte-identical
to a fresh regeneration).

## 1. Input dump identity (production snapshot, captured 2026-08-16)

| Dump | SHA-256 |
|---|---|
| `prod-schema-2026-08-16.sql` | `eaeb736fa5b579b259ad50577058f4992d8fb9087946bf143b13654f30372f79` |
| `prod-data-2026-08-16.sql` | `478374a112616271a3338b7ea0fc4426756c6ee567efa288c5875ea48f0dc081` |
| `local-auth-schema.sql` (local bootstrap) | `007540bbd1c20430706b9aab3c715b2c5977c4ed49b073a54e50d5e4559df97a` |

Restore driver: `restore-scratch.sh` (committed). Prerequisites applied:
`extensions` + `vault` schemas, cluster-wide publication
`supabase_realtime`, Supabase `auth` schema (contains the snapshot's two user
identity anchors — verified), schema then data as `supabase_admin`.

## 2. Manifest identity (see manifests/manifest-identities.json)

| Manifest | Rows | SHA-256 |
|---|---|---|
| `duplicate-endpoints.csv` | 107 | `73aea8a2452d894264952c60bdb09421bd5140d6afd664ba4f0d86cc9d55a402` |
| `stage1-unapproved-targets.csv` | 255 (154 targets + 101 guards) | `c182b4a64148ad697a9a4e7561f3ea38aa14f9193ca790beee9dfafa1c6b61fb` |
| `stage2-approved-candidates.csv` | 98 | `0e8bccc1f683a6a3a59c7200586b7a102a9bfd00ddb5a17b6982afb912c66486` |
| `r6-review.csv` | 4 | `5c1603aa30d3b546ffde12435d116b4dc5efbebee4dd0ab556a9900a1ec33ff0` |
| `stage2-authorization-manifest-template.csv` | 189 | `93909c1996ff949fb50d95c16daa5f6598444c8fe5f5f2149aad5255448711a5` |
| `stage2-test-authorization-manifest.csv` (**REHEARSAL ONLY**) | 189 (98 authorized + 91 guards) | `0ff013d452e4893d018fe9bea79b49a5ecc91a85f738812fd70528c1df273dd2` |

## 3. Restore parity (parity-check.sql — all PASS)

9/9 table counts (12 / 646 / 437 / 573 / 409 / 6 / 217 / 52 / 2), duplicate
live-auto endpoints 107, approved 409, manual 0, canonical relationship layer
empty.

## 4. Stage sequence (run-stages.sh — completed, zero errors)

| Step | Result |
|---|---|
| Prep (`13-repair-prep.sql`) | applied |
| Stage 1 apply | `STAGE 1: superseded 154 rows`, `STAGE 1: wrote 154 audit rows`, all P2 postconditions passed, COMMIT |
| Stage 1 rerun | dispatcher → `noop`; `STAGE 1: ALREADY APPLIED — verified 154 targets carry this operation with correct fields and audit rows; no-op commit` |
| Stage 2 apply (TEST manifest) | `STAGE 2: superseded 98 authorized rows`, `STAGE 2: wrote 98 audit rows`, all P2 postconditions passed, COMMIT |
| Stage 2 rerun | dispatcher → `noop`; `STAGE 2: ALREADY APPLIED — verified 98 authorized rows carry this operation with correct fields and audit rows; no-op commit` |
| Stage 1 after stage 2 | dispatcher → `noop`; own-operation state verified, no-op commit (does not claim stage-2 state) |
| Migration 013 | applied cleanly on the repaired copy — Z2 passed (0 duplicate live-auto), C1–C5/C2b assertions passed |

Final state: **573 total / 252 superseded / 321 live / 0 duplicate live-auto
endpoints / 252 repair audit rows**. Per-operation verification: 154 rows
carry the stage-1 operation id, 98 the stage-2 operation id; the 98
superseded-approved rows are exactly the stage-2 set (stage 1 touched zero
approved rows); every stage-2 audit row records the manifest's accountant
identity (1 distinct: `rehearsal-test-accountant`).

## 5. Failure/drift injection (drift-tests.sh — ALL PASS, zero partial changes)

Each case: fresh restore → prep → inject → stage 1 run → abort expected.

| Case | Injection | Stage-1 diagnosis | Partial changes |
|---|---|---|---|
| 01 approval change | approved one stage-1 target | `STOP: 1 rows drifted from the expected approval state (target approved / survivor changed)` | 0 superseded, 0 repair audits |
| 02 amount change | +1 on a target's bank amount | `STOP: 1 manifest rows drifted from the accepted snapshot (identity/value drift)` | 0 / 0 |
| 03 substituted match | repointed a target's QB endpoint | `STOP: 1 manifest rows drifted from the accepted snapshot (identity/value drift)` | 0 / 0 |
| 04 new duplicate endpoint | second live-auto row on a non-duplicate smoke QB | `STOP: total matches expected 573, found 574` (population guard; endpoint-set guard would also catch) | 0 / 0 |
| 05 survivor changed | superseded an intended survivor | `STOP: 1 rows drifted from the expected approval state (target approved / survivor changed)` | 0 / 0 (the 1 injected survivor supersession pre-exists the abort) |

## 6. Rehearsal-only warning

The stage-2 runs above used
`manifests/stage2-test-authorization-manifest.csv` — a clearly marked
**rehearsal-only** authorization manifest signed with the identity
`rehearsal-test-accountant`. The committed `14b-stage2-approved-repair.sql` is
bound to that test manifest's SHA-256 and **cannot be used in production**.
The production window regenerates stage 2 from the accountant-signed manifest
(`execution-window.md` §3 step 4).
