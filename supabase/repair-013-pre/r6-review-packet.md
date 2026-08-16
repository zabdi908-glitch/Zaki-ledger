# R6 Human-Review Packet — Conflicting Approved Pairs (4 endpoints)

Class R6: two **approved**, exact-amount, confidence-1.0 rows claim the same
QB row, with identical evidence (same bank date, amount, description) from
different statement uploads. Root cause (design report §2): the same CSV
content was uploaded repeatedly via overlapping statement files, and each
upload triggered a matcher run.

**No default executable decision exists for R6.** The earliest-upload
proposal below is a recommendation only. The executable stage-2
authorization manifest remains incomplete until a human completes the
decision fields. If a pair is judged to be two real movements, choose
DO_NOT_REPAIR — after migration 013 the second side can be represented as a
manual row (`create_manual_match_v1`) or a canonical relationship.

Machine-readable twin of this packet: `manifests/r6-review.csv`.
Decisions are recorded there and then carried into the signed authorization
manifest (`authorization-manifest-schema.md` §4–§5).

---

## Endpoint 1 — TRANSFER TO SAVINGS, 1000.00 (user `0042d6e0-…`)

QB `eff8b3ac-a91a-4b6b-af95-fb033a0d45d7`, 2026-09-30, +1000.00
(book `933cc6e0-…`, client `47f6862a-…`).

| Side | Match | Bank txn | Statement | Uploaded | Bank date | Amount | Confidence | Approved at / by | Approval audit |
|---|---|---|---|---|---|---|---|---|---|
| KEEP (proposed) | `abcdfc04-deeb-46c5-9451-52ee3ad65b31` | `f876448c-7f0f-4957-8e28-2cac7511e0bf` | `46e7d008-0b9e-406c-a8b0-a7f328287603` (`zaki_bank_test_50_transactions.csv`) | 2026-08-08T22:37:30.578877Z | 2026-09-30 | 1000.00 | 1 | 2026-08-08T22:38:25.034Z / `0042d6e0-…` | `1b1419ef-5a06-40a3-8ae7-605e8987a500` |
| RETIRE (proposed) | `2524f1b3-80b6-4862-905e-af9758544d37` | `4660f6e0-44e9-4ae9-926e-58d2f3643dab` | `9768e13a-f660-42ec-9bce-58c1e13ef96c` (`zaki_bank_test_150_transactions.csv`) | 2026-08-08T22:51:51.488188Z | 2026-09-30 | 1000.00 | 1 | 2026-08-08T22:55:52.367Z / `0042d6e0-…` | `8456fb86-1631-4bd3-abc1-6b2ee024c9d0` |

Unapproved strays: none.

**Recommendation:** likely duplicate import (same CSV content, overlapping
statements). Keep the earliest upload, retire the later one.

**Decision:** `KEEP_MATCH_ID` = `abcdfc04-deeb-46c5-9451-52ee3ad65b31` /
`RETIRE_MATCH_ID` = `2524f1b3-80b6-4862-905e-af9758544d37` / or DO_NOT_REPAIR.

---

## Endpoint 2 — REFUND AMAZON, −48.72 (user `0042d6e0-…`)

QB `c6fb703b-cf70-4417-a4fd-c9a02906765b`, 2026-10-01, −48.72
(book `933cc6e0-…`, client `47f6862a-…`).

| Side | Match | Bank txn | Statement | Uploaded | Bank date | Amount | Confidence | Approved at / by | Approval audit |
|---|---|---|---|---|---|---|---|---|---|
| KEEP (proposed) | `20acb11c-e862-41d6-ac5a-7b91ff038df0` | `3d59dae7-38c5-4ce6-8e8b-d71a2e0ca82e` | `46e7d008-0b9e-406c-a8b0-a7f328287603` (`zaki_bank_test_50_transactions.csv`) | 2026-08-08T22:37:30.578877Z | 2026-10-01 | −48.72 | 1 | 2026-08-08T22:38:25.034Z / `0042d6e0-…` | `343030f3-6f03-4b6a-8a64-d17acc8b753d` |
| RETIRE (proposed) | `f3bafacb-5879-464d-b4e2-7daf244dbd83` | `36ec3d9a-14ff-45e5-8877-fe2b577e667f` | `9768e13a-f660-42ec-9bce-58c1e13ef96c` (`zaki_bank_test_150_transactions.csv`) | 2026-08-08T22:51:51.488188Z | 2026-10-01 | −48.72 | 1 | 2026-08-08T22:55:52.367Z / `0042d6e0-…` | `1b5ee69e-326a-4c14-8089-61330edecf3d` |

Unapproved strays: none.

**Recommendation:** likely duplicate import. Keep the earliest upload,
retire the later one.

**Decision:** `KEEP_MATCH_ID` = `20acb11c-e862-41d6-ac5a-7b91ff038df0` /
`RETIRE_MATCH_ID` = `f3bafacb-5879-464d-b4e2-7daf244dbd83` / or DO_NOT_REPAIR.

---

## Endpoint 3 — TRANSFER TO SAVINGS, 1000.00 (user `38832e8e-…`)

QB `43be2941-a210-4caa-9253-7cc632104c27`, 2026-09-30, +1000.00
(book `e125b9e1-…`, client `daa94c07-…`).

| Side | Match | Bank txn | Statement | Uploaded | Bank date | Amount | Confidence | Approved at / by | Approval audit |
|---|---|---|---|---|---|---|---|---|---|
| KEEP (proposed) | `c1b21c55-8a00-4e34-977f-ad88b23a0e06` | `f9e4c608-89ca-4e8c-b8dc-2ff5cbb6b7c9` | `28f1a3c4-41da-4abf-8da6-ba295660886e` (`zaki_bank_test_50_transactions.csv`) | 2026-08-09T03:03:34.745334Z | 2026-09-30 | 1000.00 | 1 | 2026-08-09T03:04:09.183Z / `38832e8e-…` | `d8a79ba4-7bac-434b-8039-80a61510044c` |
| RETIRE (proposed) | `495c8d80-8ecf-4979-993b-dfc2800bd8ac` | `2f530664-b2d3-4cea-85d6-8a86a0ea995e` | `2b699161-319f-45f8-a54d-d9de32513cec` (`zaki_bank_test_150_transactions.csv`) | 2026-08-09T03:04:53.205904Z | 2026-09-30 | 1000.00 | 1 | 2026-08-09T03:06:42.487Z / `38832e8e-…` | `70e2c856-79c4-4272-800a-6bbd571019fc` |

Unapproved strays (retired by stage 1, awareness only):
`11a4fed1-8749-4ab0-9e1f-072f89b98239` (1319.41),
`2bd869e6-2dc4-4f65-bb6e-faafd8dee2f4` (−372.19),
`45941582-e5f7-4d7f-bc3f-b184548c4071` (1000.00).

**Recommendation:** likely duplicate import. Keep the earliest upload,
retire the later one.

**Decision:** `KEEP_MATCH_ID` = `c1b21c55-8a00-4e34-977f-ad88b23a0e06` /
`RETIRE_MATCH_ID` = `495c8d80-8ecf-4979-993b-dfc2800bd8ac` / or DO_NOT_REPAIR.

---

## Endpoint 4 — REFUND AMAZON, −48.72 (user `38832e8e-…`)

QB `41adbcf4-b89a-464f-8d26-f87aae5bc8aa`, 2026-10-01, −48.72
(book `e125b9e1-…`, client `daa94c07-…`).

| Side | Match | Bank txn | Statement | Uploaded | Bank date | Amount | Confidence | Approved at / by | Approval audit |
|---|---|---|---|---|---|---|---|---|---|
| KEEP (proposed) | `b21bdd83-defe-4e68-ab8b-a007a9e87f9b` | `88c15900-5bd3-482e-81e1-10a76d41895b` | `28f1a3c4-41da-4abf-8da6-ba295660886e` (`zaki_bank_test_50_transactions.csv`) | 2026-08-09T03:03:34.745334Z | 2026-10-01 | −48.72 | 1 | 2026-08-09T03:04:09.183Z / `38832e8e-…` | `241b518d-9784-43ef-b3b2-cf0b9d93da01` |
| RETIRE (proposed) | `731ea4f0-7dd2-4927-85da-46ba58d6e7bf` | `9520363f-1774-444e-8bbc-55095f57c2c3` | `2b699161-319f-45f8-a54d-d9de32513cec` (`zaki_bank_test_150_transactions.csv`) | 2026-08-09T03:04:53.205904Z | 2026-10-01 | −48.72 | 1 | 2026-08-09T03:06:42.487Z / `38832e8e-…` | `ece63369-3571-4d4b-ae43-5f539ba820bf` |

Unapproved strays (retired by stage 1, awareness only):
`93e92c65-f8db-407e-ba8b-24ba6c6d659a` (−1428.80),
`bc11c862-c45c-41df-aa78-dd20936794cb` (1347.23),
`f3ca970e-99b8-4ccb-a090-b47bf5a3d98a` (−48.72).

**Recommendation:** likely duplicate import. Keep the earliest upload,
retire the later one.

**Decision:** `KEEP_MATCH_ID` = `b21bdd83-defe-4e68-ab8b-a007a9e87f9b` /
`RETIRE_MATCH_ID` = `731ea4f0-7dd2-4927-85da-46ba58d6e7bf` / or DO_NOT_REPAIR.

---

## Decision checklist

- [ ] Endpoint 1 (eff8b3ac) decided
- [ ] Endpoint 2 (c6fb703b) decided
- [ ] Endpoint 3 (43be2941) decided
- [ ] Endpoint 4 (41adbcf4) decided

Signed: `accountant_identity` / `confirmation_timestamp` recorded in
`manifests/r6-review.csv` and carried into the signed stage-2 authorization
manifest before `build_repair_package.py sql --auth-manifest <signed.csv>`.
