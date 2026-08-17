# Rehearsal Evidence — Historical Repair Package, Final Identity/Proof Correction

Rehearsal executed 2026-08-17 against a **local scratch restore** of the
production snapshot inside the local Supabase container
(`supabase_db_Zaki-ledger`, scratch database `repair_drill`). Production
was never touched; no production dump contents are committed — only
hashes, counts, and outputs sufficient to reproduce the conclusions. Raw
logs live outside the repo (`/tmp/zaki-repair-rehearsal/`); the committed
record below reproduces their meaningful content.

Before every run: `bin/build_repair_package.py verify` reported
`VERIFY OK` (hashes, classification, committed basis byte-identical to a
snapshot regeneration, SQL working copies byte-identical to an
independent regeneration) and `bin/test_builder_binding.py` reported
`29 passed, 0 failed` (including the clean-clone verification B28).

## 0. Binding identity

Rehearsed tree: `5db350fe899508fb039128513780d768644ada9d` — the
**execution-package commit P** whose exact working tree was rehearsed
(the preceding commit `e905eb5448d8cc63821872cb68807802790092fa` is the
execution-package code; `5db350fe` adds a rehearsal-driver timing fix
that touches no package file). The evidence commit E recording this
evidence is the immediately following commit; its full SHA is recorded
in the final report. **E is not itself rehearsed and has no rehearsal
obligation — it proves P.**

| Artifact | SHA-256 |
|---|---|
| EXECUTION_PACKAGE_SHA256 | `d9b2eaa66233240d79e008267ede0f4a883e124627b7994ba9c415a1f581ace1` |
| Migration 013 (`supabase/migrations/013_reconciliation_claim_hardening.sql`) | `d9086ad51b3cb9f5796c6f06f5b0bec338d3bb485c1f1f4c996a0d52c1b2cd93` |
| Stage-1 SQL working copy (`14a-stage1-unapproved-repair.sql`) | `e6e5663f2ee5c20241e6b6b2e6d9bb9b88356b5742b10dbe2364c299f9c6a859` (byte-identical to the frozen rehearsal stage-1 artifact) |
| Stage-2 SQL working copy (`14b-stage2-approved-repair.sql`) | `e8495ccb94bc73417df2a98e3956ae3165047de8006387ba9eb6be81e0ea9c6c` (deterministic pre-execution staging artifact: fixed committed test manifest + empty receipt placeholder) |
| Frozen stage-1 rehearsal artifact (`artifacts/14a-…-c182b4a64148.sql`) | `e6e5663f2ee5c20241e6b6b2e6d9bb9b88356b5742b10dbe2364c299f9c6a859` |
| Frozen stage-2 rehearsal artifact (`artifacts/14b-…-faa7b5edd558.sql`) | `b8e117dee6010e501895fc53e4f185fdbe15c846c4adec244b36466e38bff57c` |

## 1. Input dump identity (production snapshot, captured 2026-08-16)

| Dump | SHA-256 |
|---|---|
| `prod-schema-2026-08-16.sql` | `eaeb736fa5b579b259ad50577058f4992d8fb9087946bf143b13654f30372f79` |
| `prod-data-2026-08-16.sql` | `478374a112616271a3338b7ea0fc4426756c6ee567efa288c5875ea48f0dc081` |
| `local-auth-schema.sql` (local bootstrap) | `007540bbd1c20430706b9aab3c715b2c5977c4ed49b073a54e50d5e4559df97a` |

Restore driver: `restore-scratch.sh` (explicit `--schema-dump` /
`--data-dump` / optional hash flags; **no dated dump defaults — missing
arguments fail closed**).

## 2. Manifest identity (see manifests/manifest-identities.json)

| Manifest | Rows | SHA-256 |
|---|---|---|
| `duplicate-endpoints.csv` | 107 | `73aea8a2452d894264952c60bdb09421bd5140d6afd664ba4f0d86cc9d55a402` |
| `stage1-unapproved-targets.csv` | 255 (154 targets + 101 guards) | `c182b4a64148ad697a9a4e7561f3ea38aa14f9193ca790beee9dfafa1c6b61fb` |
| `stage2-approved-candidates.csv` | 102 | `04a48ba553276273bce45020ac659d0c7508d8eaf8470c9ac07f7aa351b6b42b` |
| `r6-review.csv` | 4 | `5c1603aa30d3b546ffde12435d116b4dc5efbebee4dd0ab556a9900a1ec33ff0` |
| `stage2-immutable-basis.json` | 189 | `751d9b04ac3695da82821af311a20de7b45fd8bcfd7633f4cd4eb813793bf271` |
| `stage2-test-decisions.json` | 98 | `c38d19f3e21772fb61fb36177969a15b9eeae4c0d30280d7d8fcf140cdb87afe` |
| `stage2-authorization-manifest-template.json` | 0 | `3bee90c164c7c2267b171abd9ec869afb0b8b38e3f622b3a10f131d7c4cfb81d` |
| `stage2-rehearsal-authorization-manifest.json` | 98 | `940e9021d7a67a1ad4892e9712c35af0848fe85924a4a693baee01149e0bf7c4` |

## 3. Restore parity (parity-check.sql — all PASS)

9/9 table counts (12 / 646 / 437 / 573 / 409 / 6 / 217 / 52 / 2),
duplicate live-auto endpoints 107, approved 409, manual 0, canonical
relationship layer empty.

## 4. Stage sequence (rehearsal-chain.sh — completed, zero errors)

| Record | Value |
|---|---|
| Stage-1 freeze record | `artifacts/freeze-14a-…-c182b4a64148.json` (sha `32dc36146fc7fa33314a6ace13d823b687b58a7749c8a0e27b8c359c2d2ff863`) |
| Stage-2 freeze record | `artifacts/freeze-14b-…-faa7b5edd558.json` (sha `c0013049645583387a42ceda8a12570c1e61800cb4ab9e0476f2fab0451ecca4`; binds `authorization_manifest_sha256` `faa7b5ed…`, `stage1_artifact_sha256` `e6e5663f…`, `stage1_receipt_sha256` `8387bd32…`, `stage1_receipt_canonical_sha256` `403fed84…`, `execution_package_sha256` `d9b2eaa6…`) |
| **Stage-1 execution receipt (database-side)** | canonical `403fed84762b966f6dd6c040d218f998dd85c81e669690ddf6c245704aae92f1`; export `artifacts/stage1-receipt-REHEARSAL-e6e5663f2ee5.json` (sha `8387bd325289464fc6a92616b544d32fe9832305ba6dc4c10eb8ab5e83d67ec0`); `executed_at` `2026-08-17T17:01:15.010082+00:00` (database time); target digest `16e5b864…`, survivor-mapping digest `c32c85bd…`, audit digest `d09cdd68…`, postcondition digest `49e8a888…` |
| Executed rehearsal authorization manifest | `artifacts/rehearsal-authorization-manifest-2026-08-17T17:01:16Z.json` (sha `faa7b5edd5582b89a2d1a71307e0ff3a0b80e7aa0be18650f2a614d2022b8462`; 98 decisions; confirmation `2026-08-17T17:01:16Z` — strictly after the receipt's `executed_at`) |

| Step | Result |
|---|---|
| Prep (`13-repair-prep.sql`) | applied (idempotent; receipt table + immutability trigger created) |
| Stage 1 apply (frozen, hash-verified) | `STAGE 1: superseded 154 rows`, `STAGE 1: wrote 154 audit rows`, `STAGE 1: wrote execution receipt 403fed84…`, all P2 postconditions passed (incl. the receipt validation: canonical hash recomputed from the stored row, bindings + digests matched), COMMIT |
| Stage 1 rerun | dispatcher → `noop`; existing receipt validated (canonical hash + digests recomputed); `ALREADY APPLIED — verified 154 targets … byte-exact audit evidence; no-op commit` |
| Authorization checkpoint | receipt exported; executed rehearsal manifest confirmed after the receipt's `executed_at`; stage-2 freeze validated the ordering against the receipt |
| Stage 2 apply (frozen, hash-verified) | `STAGE 2: stage-1 execution receipt 403fed84… validated (digests recomputed from live state)`, `STAGE 2: superseded 98 authorized rows`, `STAGE 2: wrote 98 audit rows`, all P2 postconditions passed, COMMIT |
| Stage 2 rerun | dispatcher → `noop`; receipt revalidated; byte-exact audit evidence; no-op commit |
| Stage 1 after stage 2 | dispatcher → `noop`; receipt + own-operation state verified; no-op commit |
| Migration 013 (separate rehearsal check, freshly repaired state) | applied cleanly — Z2 passed (0 duplicate live-auto), C1–C5/C2b assertions passed; post-013 invariants: 573 total / 252 superseded / 0 duplicate live-auto endpoints |

Final state: **573 total / 252 superseded / 321 live / 0 duplicate
live-auto endpoints / 252 repair audit rows / 1 stage-1 receipt row**.
Per-operation verification: 154 rows carry the stage-1 operation id, 98
the stage-2 operation id; every audit row carries the exact frozen
artifact sha256 of its operation AND the EXECUTION_PACKAGE_SHA256
`d9b2eaa6…` in its immutable evidence.

## 5. Failure / drift injections (all abort with zero partial changes)

Stage-1 drift cases (`drift-tests.sh`, 5/5 PASS): approval change,
amount change, substituted match, new duplicate endpoint, survivor
change.

Authorization / identity / failure cases (`authorization-drift-tests.sh`,
21/21 PASS):

| Case | Injection | Result |
|---|---|---|
| G1 | `client_entities.practice_id` repointed | abort, zero writes |
| G2 | `client_entities` row archived | abort, zero writes |
| G3 | stage-1 target `approved_by` drift | abort, zero writes |
| G4 | stale `supersede_reason` | abort, zero writes |
| G5 | second same-operation audit row with tampered evidence | stage-2 rerun aborts |
| G6 | partial stage-2 (supersession, audit missing) | abort, zero new writes |
| G7 | partial stage-2 (supersession + altered audit row) | abort, zero new writes |
| G8 | REHEARSAL artifact vs the dev database identity (`postgres`) | gate aborts; FULL-STATE digest of the TARGET database identical |
| G9 | PRODUCTION artifact vs the scratch identity | gate aborts; FULL-STATE digest identical |
| G10 | stage-1 `supersede_reason` drift post-checkpoint | stage 2 aborts, zero writes |
| G11 | stage-1 survivor-link drift post-checkpoint | stage 2 aborts, zero writes |
| G12 | stage-1 operation-id drift post-checkpoint | stage 2 aborts, zero writes |
| G13 | stage-1 approval identity drift post-checkpoint | stage 2 aborts, zero writes |
| G14 | second stage-1 tampered audit row post-checkpoint | stage 2 aborts, zero writes |
| G15 | candidate/survivor substitution | stage 2 aborts, zero writes |
| G16 | held conflicting lock (55P03) | abort, wait bounded, zero writes |
| G17 | statement-timeout contract (57014) | rollback semantics, zero writes |
| G18 | missing artifact-sha GUC | P0b gate aborts |
| G19 | missing package-sha GUC | P0b2 gate aborts |
| G20 | **forged stage-1 receipt (the Codex exploit): caller-fabricated export with ALL derivable fields correct, stage 1 never ran** | freeze accepts (evidence consistency only, by design); the stage-2 artifact REJECTS at the database: `STOP: expected exactly one stage-1 execution receipt, found 0 — … a caller-fabricated stage-1 proof JSON is not an authorization root` — zero writes |
| G21 | receipt tamper: UPDATE / DELETE / duplicate INSERT | refused (immutability trigger 42806 + UNIQUE(operation_id)), rollback-only, zero changes, 1 intact receipt row |

Every case fails closed and is proven by full-state digest equality:
`rehearsal/state-digest.sh` computes a deterministic JSON digest of all
11 relevant tables; before/after digests are identical for every case
(G8 against the target database `postgres`, G9 against the scratch DB).
No count-only exceptions remain.

Builder-level binding tests (`bin/test_builder_binding.py`, 29/29 PASS):
reversal (B1), candidate replacement (B2), identity smuggling (B3/B4),
R6 swap legality (B5), both-retire (B6), missing manifest (B7), mode
barrier (B8), wrong project identity (B9), pre-checkpoint decision
(B10), wrong basis sha (B11), legacy CSV manifest (B12), missing receipt
(B13), receipt/artifact mismatch (B14), freeze immutability (B15), SQL
binding needles incl. package sha + receipt (B16), determinism (B17),
receipt tampering — survivor digest / target digest / digest format /
package sha / coordinated artifact+receipt (B18–B22), arbitrary
fabricated proof JSON rejection (B23), valid freeze verification (B24),
coordinated SQL+freeze-record tamper (B25), stale freeze-record sha
(B26), EXECUTION_PACKAGE_SHA256 determinism + file coverage (B27),
clean-clone verification (B28).

## 6. Validation suite

- `npm run test:unit` — 498 passed (20 skipped), 0 failed.
- `npm run test:local-db` — 191 passed (8 skipped), 0 failed.
- `npm run typecheck` — clean. `npm run build` — clean.
- Fresh local `supabase db reset` 001→013 — clean apply, no errors.
- Full scratch rehearsal of the EXACT commit P (`--fresh`: chain →
  migration-013 (freshly repaired state) → drift → auth drift) — all
  pass, results above; the committed artifacts are the final per-run set
  of that run.
- Independent verification of both committed frozen artifacts:
  `verify` reports `VERIFY OK` for stage 1 and stage 2 (byte-identical
  independent regeneration; stage 2 verified against the executed
  rehearsal manifest + the receipt export bound by its freeze record).
- Package-level `verify` reports `VERIFY OK` at P and at E (the
  committed 14a/14b working copies regenerate byte-identically from
  committed inputs).
