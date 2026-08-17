# Rehearsal Evidence — Historical Repair Package, Authorization-Binding Hardening

Rehearsal executed 2026-08-17 against a **local scratch restore** of the
production snapshot inside the local Supabase container
(`supabase_db_Zaki-ledger`, scratch database `repair_drill`). Production was
never touched; no production dump contents are committed — only hashes,
counts, and outputs sufficient to reproduce the conclusions. Raw logs live
outside the repo (`/tmp/zaki-repair-rehearsal/`); the committed record below
reproduces their meaningful content.

Before every run: `bin/build_repair_package.py verify --auth-manifest
manifests/stage2-rehearsal-authorization-manifest.json` reported `VERIFY OK`
(hashes, classification, committed basis byte-identical to a snapshot
regeneration, SQL byte-identical to a fresh regeneration) and
`bin/test_builder_binding.py` reported `18 passed, 0 failed`.

## 0. Binding identity

| Artifact | SHA-256 |
|---|---|
| Package commit (this hardening release) | `4540346c46b40c46cec257ec21be265cf0c1c92a` |
| Migration 013 (`supabase/migrations/013_reconciliation_claim_hardening.sql`) | `d9086ad51b3cb9f5796c6f06f5b0bec338d3bb485c1f1f4c996a0d52c1b2cd93` |
| Stage-1 SQL working copy (`14a-stage1-unapproved-repair.sql`) | `a91123dbdb8def4634163699a7c0701879c70dd9919c6c41b5d43f8b1f21903d` |
| Stage-2 SQL working copy (`14b-stage2-approved-repair.sql`) | `847463baf847e0b6f37fa080f27a62bad143382b784223eb68b9741b2af835aa` |
| Frozen stage-1 rehearsal artifact (`artifacts/14a-…-REHEARSAL-c182b4a64148.sql`) | `a91123dbdb8def4634163699a7c0701879c70dd9919c6c41b5d43f8b1f21903d` |
| Frozen stage-2 rehearsal artifact (`artifacts/14b-…-REHEARSAL-70fcb23d7e0d.sql`) | `d6d98cbae344767752295d056ece2c4d415913cb03d39f0aeb544ff034a63315` |

## 1. Input dump identity (production snapshot, captured 2026-08-16)

| Dump | SHA-256 |
|---|---|
| `prod-schema-2026-08-16.sql` | `eaeb736fa5b579b259ad50577058f4992d8fb9087946bf143b13654f30372f79` |
| `prod-data-2026-08-16.sql` | `478374a112616271a3338b7ea0fc4426756c6ee567efa288c5875ea48f0dc081` |
| `local-auth-schema.sql` (local bootstrap) | `007540bbd1c20430706b9aab3c715b2c5977c4ed49b073a54e50d5e4559df97a` |

Restore driver: `restore-scratch.sh` (explicit `--schema-dump` /
`--data-dump` / optional hash flags). Prerequisites applied: `extensions` +
`vault` schemas, cluster-wide publication `supabase_realtime`, Supabase
`auth` schema (contains the snapshot's two user identity anchors —
verified), schema then data as `supabase_admin`. Bootstrap regeneration
tooling: `make-local-auth-bootstrap.sh` (local stack only).

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
| Stage-1 freeze record | `artifacts/freeze-14a-stage1-unapproved-repair-REHEARSAL-c182b4a64148.json` (sha `177dc14d…`) |
| Stage-1 artifact identity | `6e36e7ad0b0b61385b2fffe604a0a8b2a0fbd8fc9f40a65dc9493b1dcfafbff1` |
| Stage-1 execution proof | `artifacts/stage1-proof-REHEARSAL-a91123dbdb8d.json` (sha `447002b5…`; `APPLIED` at `2026-08-17T01:13:22Z`) |
| Executed rehearsal authorization manifest | `artifacts/rehearsal-authorization-manifest-2026-08-17T01:13:23Z.json` (sha `70fcb23d…`; confirmation `2026-08-17T01:13:23Z` — after the stage-1 proof) |
| Stage-2 freeze record | `artifacts/freeze-14b-stage2-approved-repair-REHEARSAL-70fcb23d7e0d.json` (sha `f1a3e742…`) |
| Stage-2 artifact identity | `cabe2952cfda9849a377942ea7c2db93f81d437c7be9f8e43bb1048299b7ce3f` |

| Step | Result |
|---|---|
| Prep (`13-repair-prep.sql`) | applied (idempotent) |
| Stage 1 apply (frozen, hash-verified) | `STAGE 1: superseded 154 rows`, `STAGE 1: wrote 154 audit rows`, all P2 postconditions passed, COMMIT |
| Stage 1 rerun | dispatcher → `noop`; `ALREADY APPLIED — verified 154 targets … byte-exact audit evidence; no-op commit` |
| Authorization checkpoint | stage-1 proof recorded; rehearsal manifest signed with a post-stage-1 timestamp; stage-2 freeze validated the ordering against the proof |
| Stage 2 apply (frozen, hash-verified) | `STAGE 2: superseded 98 authorized rows`, `STAGE 2: wrote 98 audit rows`, all P2 postconditions passed, COMMIT |
| Stage 2 rerun | dispatcher → `noop`; byte-exact audit evidence verified; no-op commit |
| Stage 1 after stage 2 | dispatcher → `noop`; own-operation state verified (committed-basis candidates accepted only as pristine or stage-2-superseded); no-op commit |
| Migration 013 (separate rehearsal check) | applied cleanly on the repaired copy — Z2 passed (0 duplicate live-auto), C1–C5/C2b assertions passed |

Final state: **573 total / 252 superseded / 321 live / 0 duplicate live-auto
endpoints / 252 repair audit rows**. Per-operation verification: 154 rows
carry the stage-1 operation id, 98 the stage-2 operation id.

## 5. Failure / drift injections (all abort with zero partial changes)

Stage-1 drift cases (`drift-tests.sh`, 5/5 PASS): approval change, amount
change, substituted match, new duplicate endpoint, survivor change.

Authorization / identity / failure cases (`authorization-drift-tests.sh`,
9/9 PASS):

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

Builder-level binding tests (`bin/test_builder_binding.py`, 18/18 PASS):
candidate/survivor reversal, arbitrary candidate replacement, identity
smuggling at decision and top level, R6 swap legality (pair-partner survivor
from the basis), both-members-retire, missing `--auth-manifest` (hard
failure), rehearsal manifest in PRODUCTION mode, wrong project identity,
R6 decision before the stage-1 checkpoint, wrong basis sha, legacy CSV
manifest, missing stage-1 proof, proof bound to a different artifact,
frozen-artifact immutability (overwrite refused), mode gates/binding hashes
present in generated SQL, deterministic emission.

## 6. Validation suite

- `npm run test:unit` — 498 passed (20 skipped), 0 failed.
- `npm run test:local-db` — 191 passed (8 skipped), 0 failed.
- `npm run typecheck` — clean. `npm run build` — clean.
- Fresh local `supabase db reset` 001→013 — clean apply, no errors.
- Full scratch rehearsal repeated after the reset (chain → drift → auth
  drift → migration check) — all pass, results above.
