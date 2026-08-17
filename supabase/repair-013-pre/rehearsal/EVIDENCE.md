# Rehearsal Evidence — Historical Repair Package, Execution-Integrity Hardening

Rehearsal executed 2026-08-17 against a **local scratch restore** of the
production snapshot inside the local Supabase container
(`supabase_db_Zaki-ledger`, scratch database `repair_drill`). Production was
never touched; no production dump contents are committed — only hashes,
counts, and outputs sufficient to reproduce the conclusions. Raw logs live
outside the repo (`/tmp/zaki-repair-rehearsal/`); the committed record below
reproduces their meaningful content.

Before every run: `bin/build_repair_package.py verify` reported `VERIFY OK`
(hashes, classification, committed basis byte-identical to a snapshot
regeneration, frozen SQL byte-identical to an independent regeneration) and
`bin/test_builder_binding.py` reported `27 passed, 0 failed`.

## 0. Binding identity

Rehearsed tree: `4d6ba9a707c69413d88cd5d320002249aef7b658` (the package
commit whose working tree was rehearsed; the evidence commit recording this
SHA follows immediately and its full SHA is recorded in the final report).

| Artifact | SHA-256 |
|---|---|
| Package commit (rehearsed tree) | `4d6ba9a707c69413d88cd5d320002249aef7b658` |
| Migration 013 (`supabase/migrations/013_reconciliation_claim_hardening.sql`) | `d9086ad51b3cb9f5796c6f06f5b0bec338d3bb485c1f1f4c996a0d52c1b2cd93` |
| Stage-1 SQL working copy (`14a-stage1-unapproved-repair.sql`) | `3eaa5525befa134502eda1200f521a48aadb2ad900d3909442029215c321af35` |
| Stage-2 SQL working copy (`14b-stage2-approved-repair.sql`) | `e42d775cc6e24d0515041246a96724a70977ecfbdac7728d22c5eb61f2247a51` |
| Frozen stage-1 rehearsal artifact (`artifacts/14a-…-REHEARSAL-c182b4a64148.sql`) | `6f8170082db14cd221e568bf9b0f5fa9d8ba529120359c1a19c59ea86200f24a` |
| Frozen stage-2 rehearsal artifact (`artifacts/14b-…-REHEARSAL-c9807b7e4c05.sql`) | `f3d1b68f8dc045be8f1a860bb5abc2070446537d18eec7fd6e5b9ef778e404f3` |

## 1. Input dump identity (production snapshot, captured 2026-08-16)

| Dump | SHA-256 |
|---|---|
| `prod-schema-2026-08-16.sql` | `eaeb736fa5b579b259ad50577058f4992d8fb9087946bf143b13654f30372f79` |
| `prod-data-2026-08-16.sql` | `478374a112616271a3338b7ea0fc4426756c6ee567efa288c5875ea48f0dc081` |
| `local-auth-schema.sql` (local bootstrap) | `007540bbd1c20430706b9aab3c715b2c5977c4ed49b073a54e50d5e4559df97a` |

Restore driver: `restore-scratch.sh` (explicit `--schema-dump` /
`--data-dump` / optional hash flags; **no dated dump defaults — missing
arguments fail closed**). Prerequisites applied: `extensions` + `vault`
schemas, cluster-wide publication `supabase_realtime`, Supabase `auth`
schema (contains the snapshot's two user identity anchors — verified),
schema then data as `supabase_admin`. Bootstrap regeneration tooling:
`make-local-auth-bootstrap.sh` (local stack only).

## 2. Manifest identity (see manifests/manifest-identities.json)

| Manifest | Rows | SHA-256 |
|---|---|---|
| `duplicate-endpoints.csv` | 107 | `73aea8a2452d894264952c60bdb09421bd5140d6afd664ba4f0d86cc9d55a402` |
| `stage1-unapproved-targets.csv` | 255 (154 targets + 101 guards) | `c182b4a64148ad697a9a4e7561f3ea38aa14f9193ca790beee9dfafa1c6b61fb` |
| `stage2-approved-candidates.csv` | 102 decision-permitted candidates | `04a48ba553276273bce45020ac659d0c7508d8eaf8470c9ac07f7aa351b6b42b` |
| `r6-review.csv` | 4 | `5c1603aa30d3b546ffde12435d116b4dc5efbebee4dd0ab556a9900a1ec33ff0` |
| `stage2-immutable-basis.json` | 189 (102 candidates + 87 guards) | `751d9b04ac3695da82821af311a20de7b45fd8bcfd7633f4cd4eb813793bf271` |
| `stage2-test-decisions.json` | 98 | `c38d19f3e21772fb61fb36177969a15b9eeae4c0d30280d7d8fcf140cdb87afe` |
| `stage2-authorization-manifest-template.json` | 0 decisions | `3bee90c164c7c2267b171abd9ec869afb0b8b38e3f622b3a10f131d7c4cfb81d` |
| `stage2-rehearsal-authorization-manifest.json` (**REHEARSAL ONLY**) | 98 test decisions | `940e9021d7a67a1ad4892e9712c35af0848fe85924a4a693baee01149e0bf7c4` |
| `manifest-identities.json` | — | `e4c7ecc565c292d8320f798b05baacbb017f8ec5bf10c34330e0f8a2666caf9b` |

Snapshot provenance (captured 2026-08-16, read-only wrapper): `04-endpoints.json`
`e2c49238…`, `05-matches.json` `c9389b84…`, `06-audit.json` `83e344e0…`,
`10-approvals.json` `6b05157f…` (full values in `manifest-identities.json`).

## 3. Restore parity (parity-check.sql — all PASS)

9/9 table counts (12 / 646 / 437 / 573 / 409 / 6 / 217 / 52 / 2), duplicate
live-auto endpoints 107, approved 409, manual 0, canonical relationship layer
empty.

## 4. Stage sequence (rehearsal-chain.sh — completed, zero errors)

Freeze records committed under `artifacts/`:

| Record | Value |
|---|---|
| Stage-1 freeze record | `artifacts/freeze-14a-stage1-unapproved-repair-REHEARSAL-c182b4a64148.json` (sha `2e78f065489aa78c4ce8be127af62a15cc7b1457fb8d8d1a2e088564366a79db`, frozen_at `2026-08-17T02:45:16Z`) |
| Stage-1 artifact identity | `6e36e7ad0b0b61385b2fffe604a0a8b2a0fbd8fc9f40a65dc9493b1dcfafbff1` |
| Stage-1 execution proof | `artifacts/stage1-proof-REHEARSAL-6f8170082db1.json` (sha `fb6a3ffda3ff5bf1f60934cdfc787395729334b539e9e3722cf25767ca911489`; `APPLIED` at `2026-08-17T02:45:17Z`; stage-1 postcondition digest `414f2a2450f2c3babde8b750252fcc5199082f137ba69339a9e36b5dd8e5dd81`; stage-1 audit digest `d17f409dc2674cf35dd174619bbce4c9a7a4ea46d671cdd6638143bbc5731ff3`) |
| Executed rehearsal authorization manifest | `artifacts/rehearsal-authorization-manifest-2026-08-17T02:45:18Z.json` (sha `c9807b7e4c053539707969c9195d123dee2608a51ae436f0065d1b05a16e27e8`; 98 decisions; confirmation `2026-08-17T02:45:18Z` — after the stage-1 proof's `executed_at`) |
| Stage-2 freeze record | `artifacts/freeze-14b-stage2-approved-repair-REHEARSAL-c9807b7e4c05.json` (sha `1333ca8edd1d3e176eda3ab15d698a1ecde32928b1c3fa75b08ae40b68ab986a`, frozen_at `2026-08-17T02:45:19Z`; binds `authorization_manifest_sha256` `c9807b7e…`, `stage1_artifact_sha256` `6f817008…`, `stage1_execution_proof_sha256` `fb6a3ffd…`) |
| Stage-2 artifact identity | `8ad61d4d6d5e19156bd7d4591f9925b407e83ba941c1c4dee1197da5702a086e` |

| Step | Result |
|---|---|
| Prep (`13-repair-prep.sql`) | applied (idempotent) |
| Stage 1 apply (frozen, hash-verified) | `STAGE 1: superseded 154 rows`, `STAGE 1: wrote 154 audit rows`, all P2 postconditions passed, COMMIT |
| Stage 1 rerun | dispatcher → `noop`; `ALREADY APPLIED — verified 154 targets … byte-exact audit evidence; no-op commit` |
| Authorization checkpoint | stage-1 proof recorded; executed rehearsal manifest confirmed after the proof's `executed_at`; stage-2 freeze validated the ordering against the proof |
| Stage 2 apply (frozen, hash-verified) | `STAGE 2: superseded 98 authorized rows`, `STAGE 2: wrote 98 audit rows`, all P2 postconditions passed, COMMIT |
| Stage 2 rerun | dispatcher → `noop`; byte-exact audit evidence verified; no-op commit |
| Stage 1 after stage 2 | dispatcher → `noop`; own-operation state verified (committed-basis candidates accepted only as pristine or stage-2-superseded); no-op commit |
| Migration 013 (separate rehearsal check) | applied cleanly on the repaired copy — Z2 passed (0 duplicate live-auto), C1–C5/C2b assertions passed |

Final state: **573 total / 252 superseded / 321 live / 0 duplicate live-auto
endpoints / 252 repair audit rows**. Per-operation verification: 154 rows
carry the stage-1 operation id, 98 the stage-2 operation id; every stage-1
audit row carries `artifact_sha256 = 6f817008…` and every stage-2 audit row
carries `artifact_sha256 = f3d1b68f…` (the exact frozen artifact sha of its
operation, one distinct sha per operation).

## 5. Failure / drift injections (all abort with zero partial changes)

Stage-1 drift cases (`drift-tests.sh`, 5/5 PASS): approval change, amount
change, substituted match, new duplicate endpoint, survivor change.

Authorization / identity / failure cases (`authorization-drift-tests.sh`,
18/18 PASS):

| Case | Injection | Result |
|---|---|---|
| G1 | `client_entities.practice_id` repointed (composite FK dropped to emulate a corrupted restore) | abort, zero writes |
| G2 | `client_entities` row archived | abort, zero writes |
| G3 | stage-1 target `approved_by` set (approved_at NULL) | abort, zero writes |
| G4 | stale `supersede_reason` on a live target | abort, zero writes |
| G5 | second same-operation audit row with tampered evidence inserted (the stored row is UPDATE/DELETE-immutable via 012) | stage-2 rerun aborts — no silent no-op |
| G6 | partial stage-2 (row superseded, audit insert missing) | abort, zero new writes |
| G7 | partial stage-2 (row superseded + altered audit row) | abort, zero new writes |
| G8 | REHEARSAL artifact vs the local dev database identity (`postgres`) | REHEARSAL gate aborts before any write |
| G9 | PRODUCTION artifact vs the scratch identity (repair_drill) | PRODUCTION gate aborts; before/after superseded counts equal |
| G10 | stage-1 target `supersede_reason` changed after the stage-1 checkpoint | stage 2 revalidation aborts, zero writes |
| G11 | stage-1 target survivor link changed after the checkpoint | stage 2 revalidation aborts, zero writes |
| G12 | stage-1 target operation id changed after the checkpoint | stage 2 revalidation aborts, zero writes |
| G13 | stage-1 target approval state (original unapproved basis) lost after the checkpoint | stage 2 revalidation aborts, zero writes |
| G14 | second stage-1 audit row (tampered evidence) after the checkpoint | stage 2 revalidation aborts, zero writes |
| G15 | candidate/survivor substitution at decision time | stage 2 aborts, zero writes |
| G16 | deliberately held conflicting lock (`lock_timeout` 30s → SQLSTATE 55P03 `canceling statement due to lock timeout`) | abort, wait bounded, zero writes |
| G17 | `statement_timeout` (SQLSTATE 57014) | rollback semantics, zero writes |
| G18 | missing/malformed `zaki.repair_artifact_sha256` GUC | P0b gate aborts before any write |

Every case fails closed and is proven by full-state digest equality:
`rehearsal/state-digest.sh` computes a deterministic JSON digest of all 11
relevant tables; before/after digests are identical for every case.

Builder-level binding tests (`bin/test_builder_binding.py`, 27/27 PASS):
reversal (B1), candidate replacement (B2), identity smuggling (B3/B4), R6
swap legality (B5), both-members-retire (B6), missing `--auth-manifest`
(B7), rehearsal manifest in PRODUCTION (B8), wrong project identity (B9),
pre-checkpoint R6 decision (B10), wrong basis sha (B11), legacy CSV
manifest (B12), missing/wrong stage-1 proof (B13/B14), freeze
immutability/gates/determinism (B15–B17, B27), proof tampering — survivor /
target ids / digests / git sha (B18–B21), coordinated artifact+proof tamper
(B22), schema-v1 proof rejection (B23), valid stage-2 freeze verification
(B24), coordinated SQL+freeze-record tamper fails (B25), stale freeze-record
sha fails (B26).

## 6. Validation suite

- `npm run test:unit` — 498 passed (20 skipped), 0 failed.
- `npm run test:local-db` — 191 passed (8 skipped), 0 failed.
- `npm run typecheck` — clean. `npm run build` — clean.
- Fresh local `supabase db reset` 001→013 — clean apply, no errors.
- Full scratch rehearsal repeated after the reset (`--fresh`: chain → drift
  → auth drift → migration-013 check) — all pass, results above; the
  committed artifacts are the final per-run set of that run.
- Independent verification of both committed frozen artifacts:
  `verify` reports `VERIFY OK` for stage 1 and stage 2 (byte-identical
  independent regeneration; stage 2 verified against the executed
  rehearsal manifest bound by its freeze record).
