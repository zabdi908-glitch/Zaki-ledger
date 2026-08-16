# Stage-2 Authorization Manifest — Schema and Semantics

The stage-2 repair retires **approved** reconciliation rows. Approved rows
carry an accountant's signature; the repair of those rows must therefore be
authorized row-by-row by an accountant, in a separately verifiable artifact.
The authorization manifest is that artifact.

## 1. Files

| File | Purpose |
|---|---|
| `manifests/stage2-approved-candidates.csv` | Inventory of all 98 approved candidate rows (evidence, proposed survivor/action). No decisions. |
| `manifests/stage2-authorization-manifest-template.csv` | The authorization manifest with decision columns EMPTY (`authorization_status = PENDING`). Incomplete by construction. |
| `manifests/stage2-test-authorization-manifest.csv` | **REHEARSAL ONLY.** All 98 rows signed with identity `rehearsal-test-accountant`. Must never be used in production. |
| `manifests/r6-review.csv` + `r6-review-packet.md` | R6 human-decision input (§4). |

## 2. Columns (superset of the stage-1 manifest)

Core identity columns (per row): `match_id, role, class, stage, reason,
action, qb_transaction_id, qb_date, qb_amount, qb_description,
qb_description_fp, qb_ledger_book_id, bank_transaction_id, bank_date,
bank_amount, bank_description, bank_description_fp, bank_merchant,
statement_id, statement_file_name, statement_upload_date,
statement_ledger_book_id, user_id, client_entity_id, practice_id,
matched_by, matched_at, confidence, flagged_level, approved_at, approved_by,
intended_survivor_match_id, evidence_summary`.

Authorization columns (targets only; empty for guards):

- `accountant_decision` — `RETIRE` | `KEEP` | `DO_NOT_REPAIR` | (empty).
- `accountant_identity` — the confirming accountant's identity (their user
  id or email, as recorded in `auth.users`). Preserved verbatim in every
  stage-2 audit row's `action_by`.
- `confirmation_timestamp` — when the accountant signed (ISO-8601).
- `authorization_status` — `APPROVED_FOR_RETIREMENT` | `PENDING` | (empty).

Roles:

- `target` (98 rows) — a candidate row that may be retired. Only executes if
  `authorization_status = APPROVED_FOR_RETIREMENT` **and**
  `accountant_decision = RETIRE`.
- `survivor_guard` (91 rows) — the intended survivors (87 R3 exact-amount
  approved rows + 4 R6 keep rows). Never retired; the stage-2 SQL asserts
  they remain live, approved, and fingerprint-identical.

## 3. Execution semantics (enforced in the generated SQL, not by convention)

1. A row executes **iff** its exact `match_id` is present in the manifest
   with `authorization_status = APPROVED_FOR_RETIREMENT` and
   `accountant_decision = RETIRE`, and its fingerprints match live DB state.
   Anything else fails closed.
2. Every executing row requires a non-empty `accountant_identity` and a
   `confirmation_timestamp` — otherwise the SQL aborts.
3. Rows with any other decision are asserted untouched and stay live.
4. Fewer than 98 authorized rows is an acceptable, supported outcome: the
   stage retires the authorized subset, exact postconditions are computed
   from that subset, and migration 013 simply remains blocked on the
   remaining duplicate endpoints. Authorization must never be forced merely
   to satisfy the migration.
5. The stage-2 SQL embeds the exact manifest rows **and** the manifest
   SHA-256. Changing the manifest requires regenerating the SQL with the
   committed builder; the committed `14b` is bound to the TEST manifest and
   cannot execute against production data.

## 4. R6 rows — no automatic decision

The 4 R6 retire candidates appear in the template with
`authorization_status = PENDING` and empty decisions. There is **no default
executable decision** for R6: the earliest-upload proposal is recorded only
as `intended_survivor_match_id`/`evidence_summary`, and the executable
manifest remains incomplete until a human completes the decision fields.

To decide, the accountant uses `r6-review.csv` / `r6-review-packet.md`
(`KEEP_MATCH_ID` / `RETIRE_MATCH_ID` / `DO_NOT_REPAIR`). Concretely:

- **Duplicate import** (the likely case): set the retire candidate's
  `accountant_decision = RETIRE`, `accountant_identity`,
  `confirmation_timestamp`, `authorization_status = APPROVED_FOR_RETIREMENT`,
  and keep `intended_survivor_match_id` = the proposed keep row (the guard
  row).
- **Swap the sides**: edit the retire candidate's
  `intended_survivor_match_id` to the other row and swap the guard row's
  identity accordingly (the builder verifies every authorized retiree
  references a guarded survivor).
- **Two real movements** (`DO_NOT_REPAIR`): leave the decision empty or set
  `DO_NOT_REPAIR`; neither row executes, and the post-013 representation is
  one auto row plus one manual row (available after 013 via
  `create_manual_match_v1`).

## 5. Production signing flow

1. Accountant reviews `r6-review-packet.md` and fills the R6 decisions.
2. Accountant fills decision columns for every candidate row in a copy of
   the template (94 deterministic rows + 4 R6 rows) and signs with their
   identity + timestamp.
3. The signed manifest is recorded (file SHA-256) in the window log.
4. `python3 bin/build_repair_package.py --snapshot-dir <snapshot> sql
   --auth-manifest <signed.csv>` regenerates stage-2 SQL bound to the signed
   manifest; `verify --auth-manifest <signed.csv>` confirms binding; the
   diff against the committed rehearsal `14b` is reviewed (only decision
   columns and the manifest hash may differ).
