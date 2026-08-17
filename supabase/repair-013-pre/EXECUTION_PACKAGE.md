# EXECUTION_PACKAGE_SHA256 — stable package identity

This file documents the deterministic, content-based identity of the
production-relevant repair package, and how the two git commits (P and E)
relate to it. This fixes the identity instability found in review: binding
artifacts/evidence to `git rev-parse HEAD` meant every new commit (including
the evidence commit itself) invalidated the package.

## 1. Definition

```
EXECUTION_PACKAGE_SHA256 = sha256( concatenation of
    "<file_sha256>  <relpath>\n"     (sha256sum format: hex, two spaces)
    for every file in the documented sorted list of §2 )
```

- Relpaths are package-relative (`supabase/repair-013-pre/`), except the
  013 migration which is referenced as `../migrations/013_reconciliation_claim_hardening.sql`.
- The list is SORTED (bytewise, `sorted()` semantics — note that
  `../migrations/…` therefore sorts first). Ordering is part of the
  definition.
- `python3 bin/build_repair_package.py package-sha` prints the per-file
  lines and the resulting `EXECUTION_PACKAGE_SHA256`; the builder refuses
  to run when any listed file is missing.

## 2. Included files (production-relevant — the complete list)

| Relpath | Why it is included |
|---|---|
| `../migrations/013_reconciliation_claim_hardening.sql` | Migration 013 (identity only — never applied by this package) |
| `13-repair-prep.sql` | Repair prep: supersession columns, immutability triggers, the stage-1 receipt table |
| `bin/build_repair_package.py` | Stage-1/stage-2 generator, validation, locking/gate logic, freeze/verify, receipt machinery |
| `bin/test_builder_binding.py` | The builder-level binding/substitution/failure test suite (validation logic) |
| `execution-window.md` | The production repair runbook (the only authorized production execution procedure) |
| `manifests/duplicate-endpoints.csv` | Stage-1 generator input (107-endpoint inventory) |
| `manifests/r6-review.csv` | R6 human-review input (accountant review packet data) |
| `manifests/stage1-unapproved-targets.csv` | Stage-1 generator input (154 targets + 101 guards) |
| `manifests/stage2-approved-candidates.csv` | Stage-2 builder input (102 decision-permitted rows) |
| `manifests/stage2-authorization-manifest-template.json` | Stage-2 authorization input template |
| `manifests/stage2-immutable-basis.json` | The immutable candidate basis (the authorization contract) |
| `manifests/stage2-rehearsal-authorization-manifest.json` | The committed fixed REHEARSAL test manifest (verification input) |
| `manifests/stage2-test-decisions.json` | The committed test-decisions list (verification input) |

## 3. Excluded (documented — none participates in artifact bytes)

- `rehearsal/` tooling scripts and generated run logs — rehearsal drivers,
  not production execution inputs.
- `extract/` read-only queries — evidence extraction, read-only.
- `artifacts/` — generated per-run outputs (frozen SQL, freeze records,
  receipt exports, executed manifests). These are OUTPUTS of the package,
  verified by their freeze records; they are not inputs.
- The committed SQL working copies `14a-…/14b-….sql` — generated outputs;
  `verify` proves they regenerate byte-identically from the listed inputs.
- Narrative/evidence/report files (`README.md`, `EVIDENCE.md`,
  `docs/…` reports, this file) — documentation of the package, not
  production-relevant execution content.
- `manifests/manifest-identities.json` — a derived hash registry; the
  underlying manifests are bound directly.

## 4. What binds the package sha

- Every generated artifact (stage 1 and stage 2) embeds it as a literal in
  the header, in the audit evidence, and in the artifact identity.
- Every artifact's P0b2 gate requires the driver to supply the identical
  value via the session GUC `zaki.repair_package_sha256` (PGOPTIONS) — a
  missing or different value aborts before any lock or write (rehearsal
  case G19).
- The stage-1 execution receipt row records it; stage 2 validates
  `receipt.execution_package_sha256 == embedded literal == driver GUC`.
- Every freeze record records it; `verify --artifact` re-derives it from
  the checked-out files and requires a match.
- The rehearsal evidence (`rehearsal/EVIDENCE.md`) records it alongside
  the per-run hashes.

## 5. Git commits: P and E

- **P** — the execution-package commit: the commit that fixes the exact
  file list above. Its full SHA is recorded in the evidence, never bound
  into artifact bytes (git SHAs are not content-stable across evidence
  commits).
- **E** — the evidence-only descendant commit: sanitized rehearsal
  evidence (per-run artifacts under `artifacts/`, `rehearsal/EVIDENCE.md`,
  reports) PROVING P. E is not itself rehearsed — its rehearsal obligation
  is P's, and the package identity is unchanged between P and E because
  none of E's files is in the §2 list (the per-run `artifacts/` files and
  evidence docs are §3 exclusions).

Operator check at window time (runbook step 1): verify `git rev-parse
HEAD` equals the recorded P SHA, then verify
`bin/build_repair_package.py package-sha` prints the recorded
`EXECUTION_PACKAGE_SHA256` — the content-based identity, not the git SHA,
is what the artifacts bind.
