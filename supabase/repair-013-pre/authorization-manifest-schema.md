# Stage-2 Authorization — Committed Basis and Decision-Only Manifest

The stage-2 repair retires **approved** reconciliation rows. Approved rows
carry an accountant's signature; the repair of those rows must therefore be
authorized row-by-row by an accountant, in a separately verifiable artifact.
This document defines the two artifacts of that authorization and the exact
boundary between them:

1. **The committed immutable basis** (`manifests/stage2-immutable-basis.json`)
   — all accounting identity. System-generated, committed, hash-locked, and
   NOT editable through any authorization flow.
2. **The authorization manifest** — decisions only. The accountant's signed
   choices, validated by the builder as a *decision over* the committed
   basis. It cannot redefine any accounting identity.

Counts are never sufficient: every decision is validated against the exact
committed row identity it references.

---

## 1. Files

| File | Purpose |
|---|---|
| `manifests/stage2-immutable-basis.json` | **The committed authorization basis** (189 rows: 102 decision-permitted candidates + 87 survivor guards). All identity + permitted survivor/decision sets. SHA-256 locked in `manifest-identities.json`. |
| `manifests/stage2-approved-candidates.csv` | Human-readable inventory of the 102 decision-permitted candidates (evidence + permitted survivor/decision sets). No decisions. |
| `manifests/stage2-test-decisions.json` | The fixed REHEARSAL test choices (98 RETIRE decisions, no identity/timestamps). |
| `manifests/stage2-authorization-manifest-template.json` | Empty decision list (`environment_mode = REHEARSAL`). Incomplete by construction. |
| `manifests/stage2-rehearsal-authorization-manifest.json` | **REHEARSAL ONLY.** The 98 test choices signed with identity `rehearsal-test-accountant` and a fixed timestamp. Must never be used in production. |
| `manifests/r6-review.csv` + `r6-review-packet.md` | R6 human-decision input (§5). |

## 2. Committed basis — what the accountant CANNOT change

Every basis row commits, for its exact `match_id`:

- `qb_transaction_id`, `bank_transaction_id`, `statement_id`
- tenant/user/client/book: `user_id`, `client_entity_id`, `practice_id`,
  `qb_ledger_book_id`, `statement_ledger_book_id`
- amounts, dates, description SHA-256 fingerprints
- `approved_at`, `approved_by` (the approval stamps), `confidence`,
  `matched_by`, `matched_at`, `flagged_level`
- `class`, `reason`, `action`
- `permitted_survivor_match_ids` — the exact permitted survivor set
  (R3: the endpoint's exact-amount approved row; R6: the other pair member;
  R5: empty)
- `permitted_decisions` — `RETIRE`, `DO_NOT_REPAIR` (candidates);
  empty for survivor guards
- `evidence_summary`

Roles:

- `candidate` (102 rows) — decision-permitted: 93 R3 approved non-exact rows,
  1 R5 approved test row, and **both** members of each of the 4 R6 pairs.
- `survivor_guard` (87 rows) — the R3 exact-amount approved survivors. Never
  decision-permitted: the builder rejects any decision on a guard row
  (candidate/survivor reversal is impossible).

The basis is regenerated only by `bin/build_repair_package.py manifests`
from the accepted production snapshot (whose hashes are recorded in
`manifest-identities.json`), and `verify` proves the committed basis is
byte-identical to a regeneration.

## 3. Authorization manifest — decisions only

```json
{
  "package": "repair-013-pre",
  "manifest_schema_version": 1,
  "environment_mode": "PRODUCTION",
  "basis_sha256": "<sha256 of manifests/stage2-immutable-basis.json>",
  "decisions": [
    {
      "match_id": "<basis match_id>",
      "decision": "RETIRE",
      "accountant_identity": "<accountant identity as recorded in auth.users>",
      "confirmation_timestamp": "2026-08-17T09:30:00+00:00",
      "note": "optional free text"
    }
  ]
}
```

- `decision` — `RETIRE` or `DO_NOT_REPAIR`. A row with no entry is simply
  not authorized and is asserted untouched by the generated SQL.
- `accountant_identity` + `confirmation_timestamp` — required for every
  decision entry.
- **Unknown keys are rejected.** The manifest cannot smuggle a survivor,
  reason, action, class, QB id, bank id, fingerprint, or any identity
  column — those come from the committed basis. Legacy
  CSV-shaped manifests are rejected outright.
- `basis_sha256` must equal the committed basis SHA. A manifest built
  against any other accounting identity fails.

Builder validation (`sql` / `freeze`):

1. `match_id` must exist in the committed basis and be a `candidate`.
2. `decision` must be an element of the row's committed `permitted_decisions`.
3. At most one member of each R6 pair may be `RETIRE`.
4. Every `confirmation_timestamp` must be ≥ the recorded stage-1 execution
   time (the stage-1 execution proof is a required input of every stage-2
   freeze — §6). R6 decisions therefore cannot exist as executable choices
   before the stage-1 checkpoint.
5. The retiring row's survivor is the committed basis survivor — for R6
   pairs, the other member. It is never taken from the manifest.

Fewer than 98 authorized rows is an acceptable, supported outcome: the
stage retires the authorized subset, exact postconditions are computed from
that subset, and migration 013 simply remains blocked on the remaining
duplicate endpoints. Authorization must never be forced merely to satisfy
the migration.

## 4. Environment mode

Every manifest carries `environment_mode = REHEARSAL` or `PRODUCTION`.

- REHEARSAL manifests are refused by PRODUCTION builds.
- PRODUCTION artifacts additionally embed the production project identity
  `fqvekbzwghjurkcawpgg` and a hard in-transaction identity gate
  (database `postgres`, PostgreSQL 17, session GUC
  `zaki.repair_project_ref`). REHEARSAL artifacts carry a gate that admits
  only the scratch restore database `repair_drill` — a rehearsal artifact
  can never execute against production.
- The mode is bound into the generated SQL, the audit evidence, the freeze
  record, and the artifact identity hash.

## 5. R6 rows — no automatic decision

The 4 R6 endpoints each have **two decision-permitted candidates** (both
approved members of the identical-evidence pair). The earliest-upload
proposal in `r6-review.csv` / `r6-review-packet.md` is a recommendation
only — no default executable decision exists. The accountant either:

- authorizes one member `RETIRE` (the other member is then the survivor,
  asserted live and untouched), or
- authorizes both `DO_NOT_REPAIR` / leaves both undecided (after migration
  013 one side can be represented as a manual row via
  `create_manual_match_v1`).

Authorizing both members `RETIRE` is rejected by the builder and by the
stage-2 postconditions.

## 6. Production signing flow (post-stage-1 by construction)

1. Stage 1 executes and its exact postconditions verify; the operator
   records the stage-1 execution proof (artifact SHA + executed_at + result)
   and **stops** — this is the authorization checkpoint.
2. The accountant reviews `r6-review-packet.md` and the post-stage-1 state,
   and signs the decision-only manifest (a copy of the template with
   `environment_mode = PRODUCTION` and `basis_sha256` of the committed
   basis). Every confirmation timestamp is after the stage-1 execution
   time recorded in the proof.
3. `python3 bin/build_repair_package.py freeze --stage 2
   --environment-mode PRODUCTION --auth-manifest <signed.json>
   --stage1-artifact <frozen-14a.sql>
   --stage1-execution-proof <proof.json>
   --project-ref fqvekbzwghjurkcawpgg --out-dir <window-artifacts>`
   validates every decision against the committed basis and the proof,
   emits the exact stage-2 SQL to an immutable path, and records its
   SHA-256 + identity in the freeze record.
4. `python3 bin/build_repair_package.py verify --artifact
   <window-artifacts>/freeze-14b-*.json` independently re-proves the frozen
   bytes (hash, embedded identity, gates, binding hashes).
5. Only that hash-verified artifact is executed, exactly once, inside the
   authorized repair window (`execution-window.md`).
