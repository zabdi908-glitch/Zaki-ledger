# Historical Reconciliation Repair Design Report

Design + read-only analysis executed 2026-08-16 (~23:10–23:50 UTC) against
production Supabase project `fqvekbzwghjurkcawpgg`, strictly READ-ONLY, with
an explicit `--project-ref` on every command (never the implicit linked
default, which this session removed — see §16). No production data was
modified, no repair SQL ran against production, no migration was applied, no
deployment occurred, no merge to `main` occurred. The repair operation was
**rehearsed only on a local scratch restore** of production dumps (§14).

Branch `fix/reconciliation-candidate-hardening`. Related commits produced by
this task: `ebeed9d` (freeze-gap fix, §15), `dd01ca3` (CLI guard wrapper,
§16), `f070810` (design SQL artifacts).

---

## 1. Verdict

**REPAIR DESIGN READY FOR INDEPENDENT REVIEW**

The design is complete, deterministic, and rehearsal-proven end-to-end on a
faithful restored copy of production. It is NOT authorized and NOT executed.
Every approved-row decision still requires the accountant's explicit stage-2
execution (§7–§9), and the whole operation requires its own authorization
gate (§18).

---

## 2. Production state confirmed

| Check | Expected (preflight) | Observed (this session) |
|---|---|---|
| In-DB identity anchor `inet_server_addr()` | `2a05:d014:1e9b:b300:dc4d:d7da:d59:3f27` | identical ✓ |
| Postgres version | 17.6 | 17.6 ✓ |
| Migration ledger | 001–012 applied, 013 absent | 12 rows, 013 absent ✓ |
| `bank_statements` / `bank_transactions` / `qb_transactions` | 12 / 646 / 437 | identical ✓ |
| `reconciliation_matches` | 573 (all auto, 0 manual) | identical ✓ |
| approved / unapproved rows | 409 / 164 | identical ✓ |
| reports / decisions / audit_log / tenant identities / canonical ledger | 6 / 217 / 409 / 2 / 52 | identical ✓ |
| Duplicate live-auto QB endpoints | 107 | 107 ✓ |
| Affected rows (approved / unapproved) | 357 (203 / 154) | identical ✓ |
| Endpoints with ≥2 approved rows | 91 | 91 ✓ |
| Same-statement multiplicity endpoints | 51 | 51 ✓ |
| All-unapproved endpoints | 1 | 1 (the R5 test-B endpoint) ✓ |
| Schema dump SHA-256 vs preflight artifact | `eaeb736f…` | **identical** ✓ (schema unchanged since preflight) |

Additional confirmed facts:

- **Zero manual rows** (all 573 `matched_by='auto'`); the canonical
  relationship/allocation layer is **empty**: 0 `legacy_record_mappings`,
  0 `financial_relationships`, 0 `financial_relationship_endpoints`,
  0 `financial_allocations`. There is no canonical allocation evidence for
  any of the 357 rows.
- Audit log contains exactly one action type: `match_approved` (409 rows),
  written by the two real users only (`38832e8e-…`, `0042d6e0-…`).
- All matches created 2026-08-08 → 08-10 (558 rows, matcher runs) plus 15
  rows on 2026-08-14 (pilot smoke).
- **Root cause of the duplicates**: overlapping statement uploads — the same
  CSV content was uploaded repeatedly (`zaki_bank_test_50_transactions.csv`
  ×3, `zaki_bank_test_150_transactions.csv` ×3, plus
  `zaki_bank_reconciliation_test.csv`) and each upload triggered a matcher
  run. Defect D1 (pre-read QB-exclusion, no DB invariant) let concurrent and
  rapid sequential runs each claim the same QB rows. In the duplicate set,
  101 of 196 distinct bank rows (date+merchant+amount) appear in ≥2
  statements, and every exact-amount conf-1.0 row (113 rows) is green, while
  the 244 mismatched rows are flagged 232 red / 12 yellow.
- 243 of the 244 mismatched bank rows have a deterministic "better home":
  another QB row of the same user with the **exact same amount** (and
  matching description, e.g. bank `CLIENT PAYMENT INV-3007` −3023.28 vs QB
  `CLIENT PAYMENT INV-3007` −3023.28). The one homeless row is the
  `4FB-UNFREEZE-TEST` bank row — itself synthetic test data.

---

## 3. 107-endpoint classification

| Class | Endpoints | Definition (deterministic predicates) |
|---|---|---|
| R1 — obvious accidental auto duplicate | **0** | Would be all-unapproved duplicates with one materially stronger row. The only all-unapproved endpoint is the synthetic test-B row (R5). |
| R2 — unapproved duplicate conflicting with one approved relationship | **14** | Exactly 1 approved row (always exact-amount, conf 1.0, green) + 1 unapproved mismatched stray. All belong to user `0042d6e0-…` (client `47f6862a-…`). |
| R3 — multiple approved rows, one clearly supported + unsupported/error rows | **87** | Exactly 1 approved exact-amount conf-1.0 row (supported) + 1–2 approved rows whose bank amount ≠ QB amount (unsupported) + 0–3 unapproved strays. User `38832e8e-…` (client `daa94c07-…`), 49 endpoints, and user `0042d6e0-…`, 38 endpoints. |
| R4 — legitimate many:1 / partial / allocation-shaped | **0** | See §5 — no endpoint has any bank-amount subset summing to the QB amount. |
| R5 — synthetic/test contamination | **2** | QB rows `4FB-CANONICAL-TEST A` (−5) and `4FB-CANONICAL-TEST B` (+5); 5 matches (§6). |
| R6 — conflicting approved relationships with identical evidence | **4** | ≥2 approved exact-amount conf-1.0 rows: `TRANSFER TO SAVINGS` 1000 ×2 endpoints, `REFUND AMAZON` −48.72 ×2 endpoints (pairs of identical-evidence rows across different statements). |
| R7 — other ambiguous | **0** | — |

Inventory files backing every row of this table (one row per endpoint with
QB/bank/statement/audit detail, tenant, client, ledger book): produced
read-only during this session (`/tmp/zaki-repair-design/04-endpoints.json`,
`05-matches.json`, `06-audit.json`; regenerable from the query files
`04-inventory-endpoints.sql`, `05-inventory-matches.sql`, `06-audit.sql`).

---

## 4. Approved duplicate analysis (91 endpoints with ≥2 approved rows)

- **Human or synthetic?** Human. Every `approved_by` value is one of the two
  real users; no synthetic actors. Approvals landed in 5 bulk sessions
  (2026-08-08 22:38 / 22:55; 08-09 03:04 / 03:07; 08-10 06:26) plus one smoke
  approval 08-14 01:58 — consistent with bulk-approve UI passes over matcher
  output, including **85 approved rows flagged red** and 8 flagged yellow in
  the duplicate set.
- **Do bank amounts sum legitimately to the QB amount?** No. Zero of the 107
  endpoints has any subset of its bank amounts summing to its QB amount
  within 0.02. For the 87 R3 endpoints the pattern is unambiguous: one
  approved exact row (conf 1.0, green) and approved extras with different
  amounts (conf 0.35–0.80).
- **Dates/descriptions suggest legitimate settlement?** For the supported
  (exact) row of every endpoint, yes (date within the matching window,
  merchant/description matches the QB row). For the extras, no — amounts
  differ from the QB amount and every one of the 98 approved rows proposed
  for retirement has an exact-amount QB home elsewhere for the same user
  (23 also merchant-mismatched, e.g. an `ADOBE` 761.05 bank row approved
  against a `MICROSOFT 365` QB row).
- **Canonical allocation evidence present?** None — the canonical layer is
  empty (§2).
- **Approvals duplicated across statements?** Yes — 87 twin groups / 181
  approved rows share (date, merchant, amount) with another approved row in a
  different statement (the same bank movement imported via overlapping
  statement files).
- **Audit evidence explaining the decisions?** Only `match_approved` rows; no
  explanatory memos exist for the duplicate approvals.
- **Policy applied:** "highest confidence wins" was NOT used. The supported
  row is always the exact-amount conf-1.0 green row; every conflicting
  approved row is deterministically unsupported (amount contradiction +
  better home). The 4 R6 endpoints have **two** identical-evidence approved
  rows — genuinely ambiguous, handled by accountant decision with a
  deterministic default (§7).

---

## 5. Partial / allocation analysis (51 same-statement-multiplicity candidates)

- **Zero legitimate partials.** Exact-sum analysis over every subset of bank
  amounts per endpoint (tolerance 0.02): 0 matches across all 107 endpoints.
  No QB row is settled by multiple partial bank rows anywhere in the data.
- Every extra same-statement bank row is a different-amount row whose true
  home (exact-amount QB row, same user, matching description) exists.
- Classification per the requested A/B/C scheme: **A = 0,
  B (accidental reuse that merely looks partial) = 51, C = 0.**
- Canonical preservation: nothing legitimate needs converting before 013. If
  the accountant later judges an R6 pair to be two distinct real movements
  against one QB entry, the post-013 representation is one auto row plus one
  **manual** row (`create_manual_match_v1`) or a canonical relationship —
  available after 013 without pre-conversion.

---

## 6. Synthetic/test classification (exact rows)

- **2 test QB rows** (`qb_transactions.description`):
  - `cd0a15ca-0aa5-408c-a943-59caf2ad8361` — `4FB-CANONICAL-TEST A`, −5,
    user `38832e8e-…`, synced 08-14T01:58 (statement `4fb-canonical-test.csv`).
  - `4526cb27-4bd8-4fd3-a3e3-b61d5e680a87` — `4FB-CANONICAL-TEST B`, +5,
    same user, same sync.
- **5 associated matches** (both endpoints are inside the 107):
  1. `d640e6bb-…` → A, bank `4FB-CANONICAL-TEST A` −5, conf 1.0, **approved**;
  2. `9b62cc5e-…` → B, bank `4FB-CANONICAL-TEST B` +5, conf 1.0, unapproved;
  3. `752a6e83-…` → A, bank `4FB-UNFREEZE-TEST` −1, conf 0.45, unapproved
     (statement `4fb-unfreeze-test.csv`);
  4. `d240854b-…` → A, bank `CLIENT PAYMENT NORTHSTAR LTD` −1200, conf 0.35,
     unapproved (real bank row, statement `zaki_test_bank.csv`);
  5. `27223f47-…` → B, bank `COFFEE SHOP CENTRAL` 6.45, conf 0.35, unapproved
     (real bank row, same statement).
- Cleanup design: supersede all 5 (`synthetic_test_contamination` reasons),
  leaving zero live claims on the test QB rows. The two polluted real bank
  rows become unmatched; their QB homes exist (`Northstar Ltd` −1200,
  `Coffee Shop` 6.45) for a follow-up re-match (§17.3).
- Awareness only: 10 further 08-14 smoke matches on `zaki_test_bank.csv` are
  outside the duplicate set (all unapproved), do not block 013, and are not
  touched by this repair.

---

## 7. Proposed action by class

| Class | Action | Stage | Rows |
|---|---|---|---|
| R1 | n/a | — | 0 |
| R2 | Supersede unapproved strays; survivor = the approved exact row (`accidental_auto_duplicate_unapproved`) | 1 (automatic) | 14 |
| R3 | Supersede unapproved strays (`unsupported_stray_claim_unapproved`) | 1 | 130 |
| R3 | Supersede approved non-exact rows (`unsupported_approved_claim`); survivor = exact row; **accountant-executed** | 2 (reviewed) | 93 |
| R5 | Supersede unapproved test matches (`synthetic_test_contamination_unapproved`) | 1 | 4 |
| R5 | Supersede approved test match (`synthetic_test_contamination_approved`) | 2 | 1 |
| R6 | Supersede unapproved strays (`conflicting_approved_claim_stray_unapproved`) | 1 | 6 |
| R6 | Supersede one of each identical-evidence approved pair (`conflicting_approved_duplicate_evidence`); default keeps the row from the earliest-uploaded statement; **accountant confirms** | 2 | 4 |
| R4 / R7 | none | — | 0 |

No physical DELETEs anywhere. Retired rows keep their full original state
plus `superseded_at / superseded_by_match_id / supersede_reason /
supersede_operation_id`, and each transition writes one
`reconciliation_audit_log` row (§11).

---

## 8. Automated vs professional-review split

- **Automated (stage 1)** — deterministic, touches no approved rows:
  154 unapproved rows (all unapproved rows in the duplicate set). Resolves
  16 endpoints completely (R2's 14 + both R5 test endpoints).
- **Accountant-review (stage 2)** — 98 approved rows: 93 R3 + 1 R5 + 4 R6,
  across **91 endpoints** (87 R3 + 4 R6).
- After stage 1, **91 endpoints still hold ≥2 live auto claims**, so
  migration 013 remains blocked until stage 2 completes — exactly the
  spec's Phase-7 criticality condition.

---

## 9. Expected before/after counts

| Measure | Before | After stage 1 | After stage 2 (full repair) |
|---|---|---|---|
| Total `reconciliation_matches` rows | 573 | 573 (no deletes) | 573 |
| Live rows (`superseded_at IS NULL`) | 573 | 419 | **321** |
| Superseded rows | 0 | 154 | **252** |
| Duplicate live-auto endpoints | 107 | **91** | **0** |
| Live approved rows | 409 | 409 | 311 |
| Live unapproved rows | 164 | 10 | 10 (non-dup smoke rows, untouched) |
| Repair audit rows (`match_repair_superseded`) | 0 | 154 | 252 |
| Endpoints fully resolved | — | 16 | 107 |
| Endpoints requiring accountant review | — | 91 | 0 |
| Rows requiring canonical conversion | 0 | 0 | 0 |
| Test artifacts removed from live claims | — | 4 | 5 |
| 013 Z2 precondition | **BLOCKED** | **BLOCKED (91 > 0)** | **PASS (0 = 0)** |

These exact numbers are asserted inside the operation (§13) and were
reproduced by the rehearsal (§14).

---

## 10. Canonical relationship/allocation preservation

Production's canonical layer is empty (§2), so there is nothing to preserve
or convert: the repair writes only `reconciliation_matches` and
`reconciliation_audit_log`. Forward representation after 013: legitimate
many:1/partial shapes are expressed as manual rows or canonical
relationships/allocations — mechanisms 013 installs. No canonical table is
touched by this repair.

---

## 11. Audit/history design

- **No DELETEs.** Supersession is the only correction mechanism, using the
  same four columns migration 013 defines (pre-applied by the repair-prep,
  §14), so 013's own history model is the repair's history model.
- Approved stamps on superseded rows are retained (historical evidence);
  post-013 the `reconciliation_match_approved_guard` makes superseded rows
  immutable.
- Each supersession writes one `reconciliation_audit_log` row:
  `action='match_repair_superseded'`, `action_by='zaki-repair-013-pre'`,
  `operation_id` = the run's minted UUID, `previous_state` / `resulting_state`
  capturing the transition, `evidence` = stage + reason + survivor match id.
- `superseded_by_match_id` points at the surviving claim where one exists
  (237 of 252 rows); pure-evidence retirements (test rows, R6 conflicts)
  leave it NULL (15 rows) with the reason carrying the explanation.
- Backup dumps before and after remain the ground-truth snapshots (§14).

---

## 12. Idempotency and concurrency design

- One database transaction for the entire operation.
- `pg_advisory_xact_lock(0x5A414B49)` serializes concurrent repair attempts.
- P0 dispatcher: pristine state (dup=107, superseded=0, 573 total) →
  proceed; already-applied state (dup=0, superseded=252) → NOTICE + no-op;
  anything else → abort (partial/changed state fails closed).
- Retry-safe: re-running after success is a verified no-op; a failed run
  rolls back atomically to the exact pre-op state.
- Fail-closed on changed source state: P0 asserts the exact inventory
  counts (573 / 0 manual / 107 / 357 / 154 / 93 / 1) before any UPDATE;
  any drift aborts the whole transaction.
- P1 post-assertions (573 / 252 / 321 / dup=0 / 252 audit rows / no
  reason-less superseded rows) verify the end state before COMMIT.

---

## 13. Repair stop conditions

STOP / abort (whole transaction rolls back) if any of:

1. Identity anchor mismatch (project ref / `inet_server_addr()` / PG version).
2. Any P0 pre-state assertion fails (§12).
3. Any P1 post-state assertion fails (§12).
4. Freeze probes are not green 13/13 (routes) + nightly abort + store-level
   assertions before the window (the freeze is an operational precondition;
   the repair assumes zero writers during execution).
5. Fresh backup/restore drill not green (§14) before the window.
6. Row-count parity between the freeze-time dump and live production fails.
7. Any superseded row lacks a reason, or any DELETE appears in the operation
   (code review check).

The rehearsal demonstrated the mechanism working: an out-of-scope rows bug
in the first draft of S2b was caught by P1 (256 ≠ 252) and the transaction
rolled back cleanly.

---

## 14. Backup/restore drill plan (and this session's execution)

Mandatory drill steps before any production repair:

1. Schema dump: `supabase db dump --linked --project-ref
   fqvekbzwghjurkcawpgg -f <file>` (or `supabase/prod-readonly-query.sh`
   for queries).
2. Data dump: same command with `--data-only`.
3. Restore both into a scratch/local Postgres (this session: Docker
   `supabase_db_Zaki-ledger` scratch database `repair_drill`). Prerequisites
   discovered and documented: pre-create schemas `extensions` + `vault`,
   create publication `supabase_realtime`, restore a Supabase `auth` schema
   (exported from the local bootstrap), run restores as `supabase_admin`.
4. Schema verification: object presence (tables, triggers, indexes).
5. Row-count parity (9/9 tables).
6. Reconciliation-table parity (573 matches; duplicate-live-auto = 107;
   approved 409; manual 0).
7. Canonical/audit parity (canonical ledger 52; audit log 409).
8. Record artifact hashes (schema SHA-256 `eaeb736f…` — byte-identical to
   the preflight artifact; data 1,200,326 bytes, SHA-256 `478374a1…`).
9. Document restore time/result (this session: ~23:36–23:42 UTC, all checks
   green, parity table in §2 reproduced on the scratch copy).

**Executed this session (scratch only, production untouched):**
- Full restore drill green.
- **Rehearsal of the repair operation**: prep → op run 1 superseded exactly
  154 / 1 / 93 / 4 rows and passed all P1 assertions; op run 2 reported
  `REPAIR ALREADY APPLIED` as a no-op (idempotency proven).
- **Migration 013 then applied cleanly on the repaired copy** — Z2 passed
  (0 duplicate live-auto), `uk_matches_auto_live_qb`,
  `reconciliation_match_approved_guard`, `match_book_alignment`, and the six
  RPCs all present afterwards.
- A fresh freeze-time dump + parity check remains a gate requirement at the
  actual window (this dump ages once writers resume).

---

## 15. Freeze-gap correction (Phase 10)

Implemented locally, commit `ebeed9d` (branch
`fix/reconciliation-candidate-hardening`, NOT deployed):

- `zakiledger/lib/decision-store.ts`: `recordDecision`,
  `bumpMerchantPreference`, `setMerchantDefault` now call
  `assertReconciliationWritesNotFrozen()` as their first statement — before
  `getSupabase()` and before the in-memory branches — so direct store
  invocation can no longer bypass `ZAKI_RECONCILIATION_WRITE_FREEZE=1`.
- Tests added (8 new): `decision-store.test.ts` proves the in-memory path
  throws `ReconciliationWriteFrozenError` with zero state mutation and reads
  stay available; `decision-store-compat.test.ts` proves the DB path throws
  before any database call (zero calls recorded on a recording fake).
- 56 tests green across the 5 neighbouring freeze suites. No broader change
  was made.

---

## 16. CLI project-target safety (Phase 11)

Executed and committed:

- `supabase unlink` removed the local CLI's legacy link
  (`gzwtxebgevgapchoslmp`); `.temp/project-ref` and
  `.temp/linked-project.json` are gone. Verified in a scratch workdir copy
  first: after unlink, `db query --linked --project-ref
  fqvekbzwghjurkcawpgg` still works (the explicit ref fully determines the
  target) while a bare `--linked` command fails — no command can silently
  reach legacy anymore. The legacy database itself was never accessed.
- New `supabase/prod-readonly-query.sh` (commit `dd01ca3`): the only
  supported remote query path. Fixes the target to `--project-ref
  fqvekbzwghjurkcawpgg`, prepends `SET default_transaction_read_only = on;`,
  and refuses files containing mutation statements (heuristic; the DB-side
  read-only guard remains authoritative). Smoke-tested both paths (pass and
  refusal).
- Memory updated (`supabase-prod-access-hazard`) to record the unlinked
  state and the wrapper.

---

## 17. Remaining ambiguities

1. **R6 keep-which-side**: the deterministic default keeps the row from the
   earliest-uploaded statement, but the accountant must confirm whether each
   pair is duplicated data (overlapping statement files — most likely) or
   two real distinct movements; if real, represent the second side as a
   manual row after 013.
2. **4 approved non-exact rows outside the duplicate set** (found by the
   rehearsal's P1 failure): out of repair scope — they do not block 013 —
   but they are probably wrong approvals; flag for a follow-up, not this
   operation.
3. **~244 freed bank rows after supersession**: each still carries its
   (now superseded) match row, and the matcher does not re-score bank rows
   that already have a row. A follow-up, separately authorized re-match
   pass (or manual matching) can restore the 243 rows with deterministic
   exact-amount homes.
4. **Duplicate bank data across overlapping statement uploads** (101 bank
   rows duplicated across statements) is a bank-side data-quality issue
   outside `reconciliation_matches`; statement-level cleanup is a separate
   decision.
5. The 10 unapproved non-duplicate smoke matches from 08-14 remain live
   (awareness only).
6. Freeze env state on Render and the deployed commit must be re-verified at
   window time (preflight risk #4).
7. The operation id placeholder in `14-repair-op.sql` is substituted with a
   freshly minted UUID by the sanctioned runbook.

---

## 18. Exact next gate

1. **Independent review** of this report and of
   `supabase/repair-013-pre/13-repair-prep.sql` +
   `supabase/repair-013-pre/14-repair-op.sql` (hash-locked, design only).
2. **Explicit authorization** of the repair as its own production operation.
3. At the authorized window: freeze ON (13/13 route probes + nightly abort),
   fresh dumps + parity (9/9), run prep, run stage 1, report counts
   (expect: 154 superseded, 91 endpoints still duplicate), run stage 2 with
   the accountant (expect: 98 superseded, duplicate-live-auto = **0**).
4. Only then, under the preflight's separate authorization: re-run the
   preflight Phase-4 check (expect 0), take a fresh freeze-time backup,
   confirm the deployed app commit, apply migration 013, post-apply
   checklist (C1–C5 + counts), deploy the hardening app, controlled smoke,
   unfreeze.
5. The freeze-gap fix (`ebeed9d`) must be part of the deployed app before
   any freeze-dependent window.

STOP. Production data was NOT modified. Migration 013 was NOT applied. No
repair was executed against production. No deployment occurred. No merge to
main occurred. All evidence files and rehearsal logs for this design live in
`/tmp/zaki-repair-design/` (dumps, inventory JSON, drill logs, op logs).
