#!/usr/bin/env python3
"""Deterministic repair-package builder — Zaki Ledger 013-pre historical repair.

Builds the hash-locked manifests and the split Stage-1/Stage-2 repair SQL from
the accepted production snapshot inventories captured 2026-08-16 (see
docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md §2–§9).

This script is READ-ONLY with respect to any database: it consumes the
snapshot JSONs under --snapshot-dir and never opens a network connection.

The accepted classification is fixed and validated on every build:

  R2: 14 endpoints / 28 rows (14 approved, 14 unapproved)
  R3: 87 endpoints / 310 rows (180 approved, 130 unapproved)
  R5:  2 endpoints /  5 rows ( 1 approved,  4 unapproved)
  R6:  4 endpoints / 14 rows ( 8 approved,  6 unapproved)
  R4 legitimate allocations: 0 (multi-row subset-sum analysis, tolerance 0.02)

  Stage 1 (system, no approved rows touched): exactly 154 unapproved rows.
  Stage 2 (accountant-authorized): up to 98 approved rows.
  Full repair: 573 total / 252 superseded / 321 live / 0 duplicate live-auto
  endpoints / 252 repair audit rows.

Subcommands:

  manifests  Write manifests/*.csv + manifests/manifest-identities.json.
  sql        Write 14a-stage1-unapproved-repair.sql and
             14b-stage2-approved-repair.sql. 14b is emitted from the
             authorization manifest (default: the committed REHEARSAL-ONLY
             test manifest). The SQL embeds the exact manifest rows and the
             manifest SHA-256, so any manifest change requires regeneration.
  verify     Recompute hashes and cross-check counts, CSVs, and the emitted
             SQL (including that the SQL's embedded manifest hash matches the
             manifest file on disk). Exits non-zero on any mismatch.

Usage:

  python3 bin/build_repair_package.py manifests --snapshot-dir /tmp/zaki-repair-design
  python3 bin/build_repair_package.py sql
  python3 bin/build_repair_package.py verify
  python3 bin/build_repair_package.py sql --auth-manifest <signed.csv>   # production window
"""

import argparse
import csv
import hashlib
import json
import sys
import unicodedata
from collections import defaultdict
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_DIR = ROOT / "manifests"
SQL_STAGE1 = ROOT / "14a-stage1-unapproved-repair.sql"
SQL_STAGE2 = ROOT / "14b-stage2-approved-repair.sql"
PREP_SQL = ROOT / "13-repair-prep.sql"

# ---------------------------------------------------------------------------
# Fixed package constants
# ---------------------------------------------------------------------------

# Fixed per-package-release operation ids. Semantic idempotency is keyed on
# these: a re-run proves its exact targets already carry THIS operation id;
# rows superseded by any other operation id abort the run.
STAGE1_OPERATION_ID = "0a1a1a01-4a5e-4b1a-8c01-013000000001"
STAGE2_OPERATION_ID = "0a1a1a01-4a5e-4b1a-8c01-013000000002"

# Shared advisory lock key ('ZAKI'). Both stages serialize on it, so the two
# stages also serialize against each other.
ADVISORY_LOCK = "0x5A414B49"

STAGE1_ACTOR = "zaki-repair-stage1-system"
AUDIT_ACTION = "match_repair_superseded"

# Snapshot classification constants (accepted — see the design report).
TEST_QB_IDS = {
    "cd0a15ca-0aa5-408c-a943-59caf2ad8361",  # 4FB-CANONICAL-TEST A
    "4526cb27-4bd8-4fd3-a3e3-b61d5e680a87",  # 4FB-CANONICAL-TEST B
}
EXACT_EPS = 0.01
SUM_EPS = 0.02

EXPECTED = {
    "endpoints": {"R2": 14, "R3": 87, "R5": 2, "R6": 4, "R7": 0},
    "rows": {"R2": (14, 14), "R3": (180, 130), "R5": (1, 4), "R6": (8, 6)},
    "stage1_targets": 154,
    "stage2_candidates": 98,
    "stage2_guards": 91,   # 87 R3 exact survivors + 4 R6 keep rows
    "stage1_guards": 101,  # 14 R2 approved survivors + 87 R3 exact survivors
    "total_matches": 573,
    "total_approved": 409,
    "total_manual": 0,
    "dup_endpoints": 107,
    "dup_endpoints_after_stage1": 91,
    "live_unapproved_after_stage1": 10,  # non-dup 08-14 smoke rows, untouched
}

REASONS = {
    ("R2", "unapproved", 1): "accidental_auto_duplicate_unapproved",
    ("R3", "unapproved", 1): "unsupported_stray_claim_unapproved",
    ("R5", "unapproved", 1): "synthetic_test_contamination_unapproved",
    ("R6", "unapproved", 1): "conflicting_approved_claim_stray_unapproved",
    ("R3", "approved", 2): "unsupported_approved_claim",
    ("R5", "approved", 2): "synthetic_test_contamination_approved",
    ("R6", "approved", 2): "conflicting_approved_duplicate_evidence",
}

# Fixed rehearsal constants for the committed TEST authorization manifest.
TEST_ACCOUNTANT = "rehearsal-test-accountant"
TEST_CONFIRMATION_TS = "2026-08-17T00:00:00+00:00"

# ---------------------------------------------------------------------------
# Snapshot loading
# ---------------------------------------------------------------------------

SNAPSHOT_FILES = [
    "04-endpoints.json",
    "05-matches.json",
    "06-audit.json",
    "10-approvals.json",
]


def load(path):
    d = json.load(open(path))
    rows = d.get("rows") or d
    if (
        isinstance(rows, list)
        and len(rows) == 1
        and isinstance(rows[0], dict)
        and "result" in rows[0]
    ):
        return rows[0]["result"]
    return rows


def load_snapshot(snapshot_dir):
    snap = Path(snapshot_dir)
    matches = load(snap / "05-matches.json")
    endpoints = load(snap / "04-endpoints.json")
    audit = load(snap / "06-audit.json")
    approvals = load(snap / "10-approvals.json")
    return {
        "matches": matches,
        "endpoints": endpoints,
        "audit": audit,
        "approvals": approvals,
        "hashes": {
            name: sha256_file(snap / name) for name in SNAPSHOT_FILES
        },
    }


# ---------------------------------------------------------------------------
# Normalization / fingerprints
# ---------------------------------------------------------------------------

def normalize(text):
    """Stable normalized fingerprint preimage.

    Unicode NFKC, lowercase, whitespace collapsed to single spaces, trimmed.
    The builder asserts the snapshot text is pure ASCII, which makes NFKC the
    identity function — so the SQL-side preimage (lower + regexp whitespace
    collapse) computes the identical string without a Unicode-normalization
    dependency.
    """
    s = unicodedata.normalize("NFKC", str(text))
    s.encode("ascii")  # raises if non-ASCII: snapshot text must be ASCII
    return " ".join(s.lower().split())


def fingerprint(text):
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fmt_amount(v):
    return f"{float(v):.2f}"


def fmt_confidence(v):
    return f"{float(v):.4f}".rstrip("0").rstrip(".")


# ---------------------------------------------------------------------------
# Classification (accepted rules; validated against EXPECTED on every build)
# ---------------------------------------------------------------------------

def classify(snapshot):
    matches = snapshot["matches"]
    endpoints = {e["qb_id"]: e for e in snapshot["endpoints"]}
    by_qb = defaultdict(list)
    for m in matches:
        by_qb[m["qb_id"]].append(m)

    endpoint_class = {}
    # R4 legitimacy re-verification: zero multi-row bank-amount subsets may
    # sum to the QB amount (tolerance 0.02) anywhere in the 107 endpoints.
    for qb_id, ms in by_qb.items():
        qb_amt = float(endpoints[qb_id]["qb_amount"])
        amounts = sorted(float(m["bank_amount"]) for m in ms)
        for r in range(2, len(amounts) + 1):
            for combo in combinations(amounts, r):
                if abs(sum(combo) - qb_amt) <= SUM_EPS:
                    raise SystemExit(
                        f"R4 violation: endpoint {qb_id} has a multi-row "
                        f"subset {combo} summing to QB amount {qb_amt}"
                    )

    for qb_id, ms in by_qb.items():
        ep = endpoints[qb_id]
        qb_amt = float(ep["qb_amount"])
        app = [m for m in ms if m["approved_at"] is not None]
        exact = [m for m in ms if abs(float(m["bank_amount"]) - qb_amt) < EXACT_EPS]
        if qb_id in TEST_QB_IDS:
            cls = "R5"
        elif len(app) == 1:
            cls = "R2"
        elif len(app) >= 2 and len(exact) == 1:
            cls = "R3"
        elif len(app) >= 2 and len(exact) >= 2:
            cls = "R6"
        else:
            cls = "R7"
        endpoint_class[qb_id] = cls

    counts = defaultdict(int)
    rows = defaultdict(lambda: [0, 0])
    for qb_id, ms in by_qb.items():
        cls = endpoint_class[qb_id]
        counts[cls] += 1
        for m in ms:
            rows[cls][0 if m["approved_at"] is not None else 1] += 1
    for cls, n in EXPECTED["endpoints"].items():
        if counts[cls] != n:
            raise SystemExit(
                f"classification drift: class {cls} has {counts[cls]} endpoints, "
                f"expected {n}"
            )
    for cls, (app, un) in EXPECTED["rows"].items():
        got = tuple(rows[cls])
        if got != (app, un):
            raise SystemExit(
                f"classification drift: class {cls} rows {got}, expected ({app}, {un})"
            )
    return endpoint_class, by_qb, endpoints


# ---------------------------------------------------------------------------
# Row assembly
# ---------------------------------------------------------------------------

def audit_events_by_match(snapshot):
    out = defaultdict(list)
    for a in snapshot["audit"]:
        if a.get("action") == "match_approved":
            out[a["match_id"]].append(a)
    return out


def evidence_summary(m, ep, cls, survivor_id, stage):
    qb_desc = ep["qb_description"]
    if cls == "R5":
        return f"synthetic test QB row '{qb_desc}'; no live claim may remain on test data"
    if cls == "R2" and stage == 1:
        return (
            f"unapproved stray bank amount {m['bank_amount']} contradicts QB amount "
            f"{ep['qb_amount']}; approved exact-amount survivor {survivor_id}"
        )
    if cls == "R3" and stage == 1:
        return (
            f"unapproved stray bank amount {m['bank_amount']} contradicts QB amount "
            f"{ep['qb_amount']}; approved exact-amount survivor {survivor_id}"
        )
    if cls == "R3" and stage == 2:
        return (
            f"approved row bank amount {m['bank_amount']} contradicts QB amount "
            f"{ep['qb_amount']}; approved exact-amount survivor {survivor_id}"
        )
    if cls == "R6" and stage == 1:
        return (
            f"unapproved stray on endpoint with >=2 approved exact-amount claims "
            f"(QB '{qb_desc}'); no survivor assigned — accountant decides the pair"
        )
    if cls == "R6" and stage == 2:
        return (
            f"identical-evidence approved pair on QB '{qb_desc}'; proposal keeps "
            f"{survivor_id} (earliest statement upload) — HUMAN DECISION REQUIRED"
        )
    raise SystemExit(f"unhandled class/stage {cls}/{stage}")


def core_row(m, ep, role, cls, stage, survivor_id, reason, action):
    return {
        "match_id": m["match_id"],
        "role": role,
        "class": cls,
        "stage": stage,
        "reason": reason,
        "action": action,
        "qb_transaction_id": m["qb_id"],
        "qb_date": ep["qb_date"],
        "qb_amount": fmt_amount(ep["qb_amount"]),
        "qb_description": ep["qb_description"],
        "qb_description_fp": fingerprint(ep["qb_description"]),
        "qb_ledger_book_id": ep["qb_ledger_book_id"],
        "bank_transaction_id": m["bank_txn_id"],
        "bank_date": m["bank_date"],
        "bank_amount": fmt_amount(m["bank_amount"]),
        "bank_description": m["bank_description"],
        "bank_description_fp": fingerprint(m["bank_description"]),
        "bank_merchant": m["bank_merchant"],
        "statement_id": m["statement_id"],
        "statement_file_name": m["stmt_file_name"],
        "statement_upload_date": m["stmt_upload_date"],
        "statement_ledger_book_id": m["stmt_ledger_book_id"],
        "user_id": m["user_id"],
        "client_entity_id": m["client_entity_id"],
        "practice_id": ep["practice_id"],
        "matched_by": m["matched_by"],
        "matched_at": m["matched_at"],
        "confidence": fmt_confidence(m["confidence"]),
        "flagged_level": m["flagged_level"],
        "approved_at": m["approved_at"] or "",
        "approved_by": m["approved_by"] or "",
        "intended_survivor_match_id": survivor_id or "",
        "evidence_summary": evidence_summary(m, ep, cls, survivor_id, stage),
    }


def build_rows(snapshot):
    """Returns (stage1_rows, stage2_candidates, dup_endpoints,
                dup_after_stage1, r6_rows)."""
    endpoint_class, by_qb, endpoints = classify(snapshot)
    audit_by_match = audit_events_by_match(snapshot)

    stage1_targets, stage1_guards = [], []
    stage2_targets, stage2_guards = [], []
    dup_endpoints, dup_after_stage1 = [], []
    r6_rows = []

    for qb_id in sorted(by_qb):
        ms = by_qb[qb_id]
        ep = endpoints[qb_id]
        cls = endpoint_class[qb_id]
        app = [m for m in ms if m["approved_at"] is not None]
        un = [m for m in ms if m["approved_at"] is None]
        qb_amt = float(ep["qb_amount"])
        exact = [
            m for m in ms
            if abs(float(m["bank_amount"]) - qb_amt) < EXACT_EPS
        ]

        dup_endpoints.append({
            "qb_transaction_id": qb_id,
            "class": cls,
            "qb_description": ep["qb_description"],
            "qb_description_fp": fingerprint(ep["qb_description"]),
            "qb_date": ep["qb_date"],
            "qb_amount": fmt_amount(qb_amt),
            "qb_ledger_book_id": ep["qb_ledger_book_id"],
            "user_id": ep["user_id"],
            "client_entity_id": ep["client_entity_id"],
            "practice_id": ep["practice_id"],
            "n_matches": len(ms),
            "n_approved": len(app),
            "n_unapproved": len(un),
        })

        if cls in ("R2", "R3"):
            approved_exact = sorted(
                [m for m in app if m in exact], key=lambda x: x["match_id"]
            )
            assert len(approved_exact) == 1, (qb_id, cls)
            survivor = approved_exact[0]
        elif cls in ("R5", "R6"):
            survivor = None
        else:
            raise SystemExit(f"unexpected class {cls}")

        # Stage 1: every unapproved row in the duplicate set.
        for m in sorted(un, key=lambda x: x["match_id"]):
            reason = REASONS[(cls, "unapproved", 1)]
            row = core_row(
                m, ep, "target", cls, 1,
                survivor["match_id"] if survivor else None,
                reason, "SUPERSEDE",
            )
            stage1_targets.append(row)

        # Stage 1 survivors (guard-only rows).
        if cls in ("R2", "R3"):
            row = core_row(
                survivor, ep, "survivor_guard", cls, 1,
                survivor["match_id"], "intended_survivor_guard", "KEEP_LIVE_GUARD",
            )
            row["intended_survivor_match_id"] = ""
            stage1_guards.append(row)

        if cls == "R2":
            # Endpoint fully resolved by stage 1 (1 live approved row).
            dup_after_stage1.append({
                "qb_transaction_id": qb_id,
                "resolved_by_stage1": True,
            })
            continue

        if cls == "R5":
            dup_after_stage1.append({
                "qb_transaction_id": qb_id,
                "resolved_by_stage1": True,
            })
            # Stage 2: the one approved test row.
            for m in sorted(app, key=lambda x: x["match_id"]):
                row = core_row(
                    m, ep, "target", cls, 2, None,
                    REASONS[(cls, "approved", 2)], "SUPERSEDE",
                )
                stage2_targets.append(row)
            continue

        if cls == "R3":
            dup_after_stage1.append({
                "qb_transaction_id": qb_id,
                "resolved_by_stage1": False,
            })
            # Stage 2: every approved non-exact row; survivor = the exact row.
            for m in sorted(
                [m for m in app if m not in exact], key=lambda x: x["match_id"]
            ):
                row = core_row(
                    m, ep, "target", cls, 2,
                    survivor["match_id"],
                    REASONS[(cls, "approved", 2)], "SUPERSEDE",
                )
                stage2_targets.append(row)
            row = core_row(
                survivor, ep, "survivor_guard", cls, 2,
                survivor["match_id"], "intended_survivor_guard", "KEEP_LIVE_GUARD",
            )
            row["intended_survivor_match_id"] = ""
            stage2_guards.append(row)
            continue

        if cls == "R6":
            dup_after_stage1.append({
                "qb_transaction_id": qb_id,
                "resolved_by_stage1": False,
            })
            app_sorted = sorted(
                app, key=lambda x: (str(x["stmt_upload_date"]), x["match_id"])
            )
            keep, retire = app_sorted[0], app_sorted[1]
            # Proposal only — the accountant's signed decision is what the
            # executable stage-2 manifest requires (no automatic execution).
            row = core_row(
                retire, ep, "target", cls, 2,
                keep["match_id"],
                REASONS[(cls, "approved", 2)], "SUPERSEDE",
            )
            stage2_targets.append(row)
            row = core_row(
                keep, ep, "survivor_guard", cls, 2,
                keep["match_id"], "intended_survivor_guard", "KEEP_LIVE_GUARD",
            )
            row["intended_survivor_match_id"] = ""
            stage2_guards.append(row)

            def ev(rid):
                for a in audit_by_match.get(rid, []):
                    return (a.get("audit_id", ""), a.get("action_at", ""))
                return ("", "")

            def mrow(m, prefix):
                return {
                    f"{prefix}_match_id": m["match_id"],
                    f"{prefix}_bank_transaction_id": m["bank_txn_id"],
                    f"{prefix}_statement_id": m["statement_id"],
                    f"{prefix}_statement_file_name": m["stmt_file_name"],
                    f"{prefix}_statement_upload_date": m["stmt_upload_date"],
                    f"{prefix}_bank_date": m["bank_date"],
                    f"{prefix}_bank_amount": fmt_amount(m["bank_amount"]),
                    f"{prefix}_bank_description": m["bank_description"],
                    f"{prefix}_confidence": fmt_confidence(m["confidence"]),
                    f"{prefix}_approved_at": m["approved_at"],
                    f"{prefix}_approved_by": m["approved_by"],
                    f"{prefix}_approval_audit_id": ev(m["match_id"])[0],
                    f"{prefix}_approval_action_at": ev(m["match_id"])[1],
                }

            r6 = {
                "qb_transaction_id": qb_id,
                "class": cls,
                "qb_description": ep["qb_description"],
                "qb_date": ep["qb_date"],
                "qb_amount": fmt_amount(qb_amt),
                "qb_ledger_book_id": ep["qb_ledger_book_id"],
                "user_id": ep["user_id"],
                "client_entity_id": ep["client_entity_id"],
                "practice_id": ep["practice_id"],
            }
            r6.update(mrow(keep, "keep_candidate"))
            r6.update(mrow(retire, "retire_candidate"))
            r6["unapproved_stray_match_ids"] = ";".join(
                sorted(x["match_id"] for x in un)
            )
            r6["recommendation"] = (
                "likely duplicate import (same CSV content uploaded via "
                f"overlapping statements {keep['stmt_file_name']} and "
                f"{retire['stmt_file_name']}); proposal keeps the row from the "
                "earliest-uploaded statement"
            )
            r6["decision_keep_match_id"] = ""
            r6["decision_retire_match_id"] = ""
            r6["decision_do_not_repair"] = ""
            r6["accountant_identity"] = ""
            r6["confirmation_timestamp"] = ""
            r6["authorization_status"] = ""
            r6_rows.append(r6)

    stage1_targets.sort(key=lambda r: r["match_id"])
    stage1_guards.sort(key=lambda r: r["match_id"])
    stage2_targets.sort(key=lambda r: r["match_id"])
    stage2_guards.sort(key=lambda r: r["match_id"])
    dup_endpoints.sort(key=lambda r: r["qb_transaction_id"])
    r6_rows.sort(key=lambda r: r["qb_transaction_id"])

    assert len(stage1_targets) == EXPECTED["stage1_targets"], len(stage1_targets)
    assert len(stage1_guards) == EXPECTED["stage1_guards"], len(stage1_guards)
    assert len(stage2_targets) == EXPECTED["stage2_candidates"], len(stage2_targets)
    assert len(stage2_guards) == EXPECTED["stage2_guards"], len(stage2_guards)
    assert len(dup_endpoints) == EXPECTED["dup_endpoints"], len(dup_endpoints)
    assert sum(1 for e in dup_after_stage1 if e["resolved_by_stage1"]) == 16
    assert len(dup_after_stage1) == EXPECTED["dup_endpoints"]
    assert len(r6_rows) == 4

    # Survivors referenced by stage-1 targets must all be guarded.
    guard_ids = {r["match_id"] for r in stage1_guards}
    for r in stage1_targets:
        if r["intended_survivor_match_id"]:
            assert r["intended_survivor_match_id"] in guard_ids
    guard_ids = {r["match_id"] for r in stage2_guards}
    for r in stage2_targets:
        if r["intended_survivor_match_id"]:
            assert r["intended_survivor_match_id"] in guard_ids

    return (
        stage1_targets, stage1_guards, stage2_targets, stage2_guards,
        dup_endpoints, dup_after_stage1, r6_rows,
    )


# ---------------------------------------------------------------------------
# CSV writing
# ---------------------------------------------------------------------------

CORE_HEADER = [
    "match_id", "role", "class", "stage", "reason", "action",
    "qb_transaction_id", "qb_date", "qb_amount", "qb_description",
    "qb_description_fp", "qb_ledger_book_id",
    "bank_transaction_id", "bank_date", "bank_amount", "bank_description",
    "bank_description_fp", "bank_merchant",
    "statement_id", "statement_file_name", "statement_upload_date",
    "statement_ledger_book_id",
    "user_id", "client_entity_id", "practice_id",
    "matched_by", "matched_at", "confidence", "flagged_level",
    "approved_at", "approved_by", "intended_survivor_match_id",
    "evidence_summary",
]

AUTH_HEADER = [
    "accountant_decision", "accountant_identity", "confirmation_timestamp",
    "authorization_status",
]

DUP_ENDPOINTS_HEADER = [
    "qb_transaction_id", "class", "qb_description", "qb_description_fp",
    "qb_date", "qb_amount", "qb_ledger_book_id", "user_id",
    "client_entity_id", "practice_id", "n_matches", "n_approved",
    "n_unapproved",
]

R6_HEADER = [
    "qb_transaction_id", "class", "qb_description", "qb_date", "qb_amount",
    "qb_ledger_book_id", "user_id", "client_entity_id", "practice_id",
    "keep_candidate_match_id", "keep_candidate_bank_transaction_id",
    "keep_candidate_statement_id", "keep_candidate_statement_file_name",
    "keep_candidate_statement_upload_date", "keep_candidate_bank_date",
    "keep_candidate_bank_amount", "keep_candidate_bank_description",
    "keep_candidate_confidence", "keep_candidate_approved_at",
    "keep_candidate_approved_by", "keep_candidate_approval_audit_id",
    "keep_candidate_approval_action_at",
    "retire_candidate_match_id", "retire_candidate_bank_transaction_id",
    "retire_candidate_statement_id", "retire_candidate_statement_file_name",
    "retire_candidate_statement_upload_date", "retire_candidate_bank_date",
    "retire_candidate_bank_amount", "retire_candidate_bank_description",
    "retire_candidate_confidence", "retire_candidate_approved_at",
    "retire_candidate_approved_by", "retire_candidate_approval_audit_id",
    "retire_candidate_approval_action_at",
    "unapproved_stray_match_ids", "recommendation",
    "decision_keep_match_id", "decision_retire_match_id",
    "decision_do_not_repair", "accountant_identity",
    "confirmation_timestamp", "authorization_status",
]


def write_csv(path, header, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        for r in rows:
            w.writerow([r.get(c, "") for c in header])


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def cmd_manifests(snapshot_dir, out_dir):
    snap = load_snapshot(snapshot_dir)
    (s1t, s1g, s2t, s2g, dup_eps, dup_after_s1, r6) = build_rows(snap)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # 1. Duplicate-endpoint inventory (107 rows).
    write_csv(out / "duplicate-endpoints.csv", DUP_ENDPOINTS_HEADER, dup_eps)

    # 2. Stage-1 manifest: 154 targets + 101 survivor guards.
    write_csv(
        out / "stage1-unapproved-targets.csv",
        CORE_HEADER, s1t + s1g,
    )

    # 3. Stage-2 candidate inventory (98 rows, no decisions).
    write_csv(
        out / "stage2-approved-candidates.csv",
        CORE_HEADER, s2t,
    )

    # 4. R6 human-review rows (4 endpoints).
    write_csv(out / "r6-review.csv", R6_HEADER, r6)

    # 5. Stage-2 authorization manifest TEMPLATE (empty decision columns).
    template = [dict(r) for r in s2t] + [dict(r) for r in s2g]
    for r in template:
        for c in AUTH_HEADER:
            r[c] = ""
        if r["role"] == "target":
            r["authorization_status"] = "PENDING"
    write_csv(
        out / "stage2-authorization-manifest-template.csv",
        CORE_HEADER + AUTH_HEADER, template,
    )

    # 6. REHEARSAL-ONLY test authorization manifest (all 98 signed with a
    #    clearly marked test identity).
    test = [dict(r) for r in s2t] + [dict(r) for r in s2g]
    for r in test:
        if r["role"] == "target":
            r["accountant_decision"] = "RETIRE"
            r["accountant_identity"] = TEST_ACCOUNTANT
            r["confirmation_timestamp"] = TEST_CONFIRMATION_TS
            r["authorization_status"] = "APPROVED_FOR_RETIREMENT"
        else:
            for c in AUTH_HEADER:
                r[c] = ""
    write_csv(
        out / "stage2-test-authorization-manifest.csv",
        CORE_HEADER + AUTH_HEADER, test,
    )

    # 7. Identity registry.
    files = [
        "duplicate-endpoints.csv",
        "stage1-unapproved-targets.csv",
        "stage2-approved-candidates.csv",
        "r6-review.csv",
        "stage2-authorization-manifest-template.csv",
        "stage2-test-authorization-manifest.csv",
    ]
    identities = {
        "package": {
            "stage1_operation_id": STAGE1_OPERATION_ID,
            "stage2_operation_id": STAGE2_OPERATION_ID,
            "snapshot_provenance": {
                name: {"sha256": h} for name, h in snap["hashes"].items()
            },
            "accepted_classification": EXPECTED,
        },
        "manifests": {
            name: {
                "sha256": sha256_file(out / name),
                "rows": len(read_csv(out / name)),
            }
            for name in files
        },
    }
    with open(out / "manifest-identities.json", "w", encoding="utf-8") as f:
        json.dump(identities, f, indent=2)
        f.write("\n")

    print(f"manifests written to {out}")
    for name, meta in identities["manifests"].items():
        print(f"  {name}: {meta['rows']} rows  sha256={meta['sha256'][:16]}…")


# ---------------------------------------------------------------------------
# SQL emission
# ---------------------------------------------------------------------------

def sql_lit(v):
    """SQL literal for a value; ''/None -> NULL."""
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def sql_values(header, rows):
    """Deterministic VALUES block: rows in CSV order."""
    lines = []
    for r in rows:
        lines.append("  (" + ", ".join(sql_lit(r.get(c, "")) for c in header) + ")")
    return ",\n".join(lines)


def manifest_row_values(rows):
    # Order rows: targets first then guards, each sorted by match_id — the
    # same order the CSV carries.
    return sql_values(CORE_HEADER, rows)


def auth_row_values(rows):
    return sql_values(CORE_HEADER + AUTH_HEADER, rows)


def endpoint_values(rows):
    cols = ["qb_transaction_id", "resolved_by_stage1"]
    return sql_values(cols, rows)


def qb_id_values(rows):
    return sql_values(["qb_transaction_id"], rows)


def stage1_sql(s1t, s1g, dup_eps, dup_after_s1, manifest_sha):
    s1 = f"""-- =============================================================================
-- ZAKI-REPAIR-013-PRE — STAGE 1: UNAPPROVED-ROW REPAIR (exact-ID, manifest-bound)
-- =============================================================================
-- Package:    supabase/repair-013-pre (historical repair hardening)
-- Manifest:   manifests/stage1-unapproved-targets.csv
--             SHA-256 {manifest_sha}
--             (verified by bin/build_repair_package.py verify)
-- Snapshot:   production fqvekbzwghjurkcawpgg, captured 2026-08-16
--             (docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md §2)
-- Operation:  {STAGE1_OPERATION_ID}  (fixed per package release —
--             the semantic idempotency key)
--
-- Scope: supersedes EXACTLY the 154 unapproved duplicate live-auto rows
--        listed in the stage-1 manifest. NO approved row is touched.
--        NO DELETE. One transaction. Fails closed on any drift.
--
-- Execution gate: this file may only be executed against production inside
--        an explicitly authorized repair window (see execution-window.md).
--        Rehearsal evidence lives in rehearsal/.
--
-- Writer exclusion (P0a): ACCESS EXCLUSIVE table locks, taken in the
--        controlled writers' natural order (statements -> bank -> qb ->
--        matches -> audit), after the shared advisory lock. Details and the
--        exclusion analysis: execution-window.md.
--
-- Semantic idempotency (P0c): re-running after success proves every target
--        already carries THIS operation id with correct reason/survivor and
--        a matching audit row, then exits as a verified no-op. Targets
--        superseded by any OTHER operation id abort the run.

SET search_path = pg_temp, public;

BEGIN;

-- Serialize repair attempts. Both stages share this key, so stage 1 and
-- stage 2 also serialize against each other.
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});  -- 'ZAKI'

-- ===========================================================================
-- P0a. Writer exclusion: database-side execution locks
-- ===========================================================================
LOCK TABLE public.bank_statements IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.bank_transactions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.qb_transactions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_matches IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_audit_log IN ACCESS EXCLUSIVE MODE;

-- ===========================================================================
-- P0b. Manifest load (targets + survivor guards)
-- ===========================================================================
CREATE TEMP TABLE zaki_manifest (
  match_id     uuid PRIMARY KEY,
  role         text NOT NULL CHECK (role IN ('target','survivor_guard')),
  class        text NOT NULL,
  stage        int NOT NULL CHECK (stage = 1),
  reason       text NOT NULL,
  action       text NOT NULL,
  qb_id        uuid NOT NULL,
  qb_date      date NOT NULL,
  qb_amount    numeric(12,2) NOT NULL,
  qb_desc      text NOT NULL,
  qb_desc_fp   text NOT NULL,
  qb_book      uuid NOT NULL,
  bank_id      uuid NOT NULL,
  bank_date    date NOT NULL,
  bank_amount  numeric(12,2) NOT NULL,
  bank_desc    text NOT NULL,
  bank_desc_fp text NOT NULL,
  bank_merchant text NOT NULL,
  statement_id uuid NOT NULL,
  stmt_file    text NOT NULL,
  stmt_upload  timestamptz NOT NULL,
  stmt_book    uuid NOT NULL,
  user_id      uuid NOT NULL,
  client_id    uuid NOT NULL,
  practice_id  uuid NOT NULL,
  matched_by   text NOT NULL,
  matched_at   timestamptz NOT NULL,
  confidence   numeric(4,3) NOT NULL,
  flagged_level text NOT NULL,
  approved_at  timestamptz,
  approved_by  text,
  survivor_id  uuid,
  evidence     text NOT NULL
) ON COMMIT DROP;

INSERT INTO zaki_manifest
  (match_id, role, class, stage, reason, action,
   qb_id, qb_date, qb_amount, qb_desc, qb_desc_fp, qb_book,
   bank_id, bank_date, bank_amount, bank_desc, bank_desc_fp, bank_merchant,
   statement_id, stmt_file, stmt_upload, stmt_book,
   user_id, client_id, practice_id, matched_by, matched_at, confidence,
   flagged_level, approved_at, approved_by, survivor_id, evidence)
VALUES
{manifest_row_values(s1t + s1g)};

CREATE TEMP TABLE zaki_endpoints (
  qb_id uuid PRIMARY KEY,
  resolved_by_stage1 boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO zaki_endpoints (qb_id, resolved_by_stage1) VALUES
{endpoint_values(dup_after_s1)};

DO $$
DECLARE
  v int;
BEGIN
  IF (SELECT count(*) FROM zaki_manifest WHERE role = 'target') <> {EXPECTED['stage1_targets']} THEN
    RAISE EXCEPTION 'STOP: manifest integrity failure (target count)';
  END IF;
  IF (SELECT count(*) FROM zaki_manifest WHERE role = 'survivor_guard') <> {EXPECTED['stage1_guards']} THEN
    RAISE EXCEPTION 'STOP: manifest integrity failure (guard count)';
  END IF;
  IF (SELECT count(*) FROM zaki_endpoints) <> {EXPECTED['dup_endpoints']} THEN
    RAISE EXCEPTION 'STOP: endpoint manifest integrity failure';
  END IF;
END $$;

-- ===========================================================================
-- P0c. Stage dispatcher (semantic idempotency on THIS operation id)
-- ===========================================================================
DO $$
DECLARE
  v_total  int;
  v_manual int;
  v_live   int;
  v_done   int;
  v_other  int;
BEGIN
  SELECT count(*) INTO v_total FROM public.reconciliation_matches;
  IF v_total <> {EXPECTED['total_matches']} THEN
    RAISE EXCEPTION 'STOP: total matches expected {EXPECTED['total_matches']}, found %', v_total;
  END IF;

  SELECT count(*) INTO v_manual FROM public.reconciliation_matches WHERE matched_by = 'manual';
  IF v_manual <> {EXPECTED['total_manual']} THEN
    RAISE EXCEPTION 'STOP: manual rows appeared (expected 0), found %', v_manual;
  END IF;

  -- Targets still live (pristine stage-1 state).
  SELECT count(*) INTO v_live
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target' AND m.superseded_at IS NULL;

  -- Targets superseded by THIS operation with correct fields and audit rows.
  SELECT count(*) INTO v_done
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND m.superseded_at IS NOT NULL
    AND m.supersede_operation_id = '{STAGE1_OPERATION_ID}'
    AND m.supersede_reason = t.reason
    AND m.superseded_by_match_id IS NOT DISTINCT FROM t.survivor_id
    AND EXISTS (
      SELECT 1 FROM public.reconciliation_audit_log a
      WHERE a.reconciliation_match_id = t.match_id
        AND a.action = '{AUDIT_ACTION}'
        AND a.operation_id = '{STAGE1_OPERATION_ID}'
    );

  -- Targets superseded by a different operation (foreign state).
  SELECT count(*) INTO v_other
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND m.superseded_at IS NOT NULL
    AND m.supersede_operation_id IS DISTINCT FROM '{STAGE1_OPERATION_ID}';

  IF v_other > 0 THEN
    RAISE EXCEPTION 'STOP: % stage-1 targets superseded by a different operation id; state was not produced by this package', v_other;
  END IF;

  IF v_done = {EXPECTED['stage1_targets']} AND v_live = 0 THEN
    PERFORM set_config('zaki.repair_mode', 'noop', true);
  ELSIF v_live = {EXPECTED['stage1_targets']} AND v_done = 0 THEN
    PERFORM set_config('zaki.repair_mode', 'apply', true);
  ELSE
    RAISE EXCEPTION 'STOP: unexpected partial stage-1 state (live=%, done=%)', v_live, v_done;
  END IF;
END $$;

-- ===========================================================================
-- P0d. Exact drift preconditions (every manifest row vs live DB state)
-- ===========================================================================
DO $$
DECLARE
  v_bad int;
  v_mode text := current_setting('zaki.repair_mode');
BEGIN
  -- 1. Endpoint identity + value fingerprints for EVERY manifest row.
  SELECT count(*) INTO v_bad
  FROM zaki_manifest t
  LEFT JOIN public.reconciliation_matches m ON m.id = t.match_id
  LEFT JOIN public.bank_transactions b ON b.id = t.bank_id
  LEFT JOIN public.qb_transactions q ON q.id = t.qb_id
  LEFT JOIN public.bank_statements s ON s.id = t.statement_id
  WHERE m.id IS NULL
     OR (m.user_id, m.client_entity_id, m.statement_id, m.bank_transaction_id, m.qb_transaction_id)
        IS DISTINCT FROM (t.user_id, t.client_id, t.statement_id, t.bank_id, t.qb_id)
     OR (b.user_id, b.statement_id, b.client_entity_id, b.transaction_date, b.amount)
        IS DISTINCT FROM (t.user_id, t.statement_id, t.client_id, t.bank_date, t.bank_amount)
     OR (q.user_id, q.client_entity_id, q.ledger_book_id, q.posted_date, q.amount)
        IS DISTINCT FROM (t.user_id, t.client_id, t.qb_book, t.qb_date, t.qb_amount)
     OR (s.user_id, s.client_entity_id, s.ledger_book_id, s.file_name, s.upload_date)
        IS DISTINCT FROM (t.user_id, t.client_id, t.stmt_book, t.stmt_file, t.stmt_upload)
     OR m.confidence IS DISTINCT FROM t.confidence
     OR m.matched_by IS DISTINCT FROM t.matched_by
     OR m.matched_at IS DISTINCT FROM t.matched_at
     OR m.flagged_level IS DISTINCT FROM t.flagged_level
     OR b.merchant IS DISTINCT FROM t.bank_merchant
     OR b.description IS DISTINCT FROM t.bank_desc
     OR q.description IS DISTINCT FROM t.qb_desc
     OR encode(extensions.digest(convert_to(btrim(regexp_replace(lower(b.description), '\\s+', ' ', 'g')), 'UTF8'), 'sha256'), 'hex')
        IS DISTINCT FROM t.bank_desc_fp
     OR encode(extensions.digest(convert_to(btrim(regexp_replace(lower(q.description), '\\s+', ' ', 'g')), 'UTF8'), 'sha256'), 'hex')
        IS DISTINCT FROM t.qb_desc_fp;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % manifest rows drifted from the accepted snapshot (identity/value drift)', v_bad;
  END IF;

  -- 2. Approval/state drift.
  SELECT count(*) INTO v_bad
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE (t.role = 'target' AND m.approved_at IS NOT NULL)
     OR (t.role = 'survivor_guard'
         AND (m.approved_at IS NULL
              OR m.superseded_at IS NOT NULL
              OR m.approved_at IS DISTINCT FROM t.approved_at
              OR m.approved_by IS DISTINCT FROM t.approved_by
              OR m.confidence IS DISTINCT FROM t.confidence
              OR abs((SELECT b.amount FROM public.bank_transactions b WHERE b.id = m.bank_transaction_id)
                   - (SELECT q.amount FROM public.qb_transactions q WHERE q.id = m.qb_transaction_id)) > 0.01));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % rows drifted from the expected approval state (target approved / survivor changed)', v_bad;
  END IF;

  -- 3. Duplicate-endpoint set: no unexpected NEW duplicate endpoints, and
  --    (apply mode) every snapshot duplicate endpoint still present.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT qb_transaction_id FROM public.reconciliation_matches
      WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
      GROUP BY qb_transaction_id HAVING count(*) > 1
    ) d
    LEFT JOIN zaki_endpoints e ON e.qb_id = d.qb_transaction_id
    WHERE e.qb_id IS NULL
  ) THEN
    RAISE EXCEPTION 'STOP: unexpected duplicate live-auto endpoint appeared since the snapshot';
  END IF;
  IF v_mode = 'apply' AND EXISTS (
    SELECT 1 FROM zaki_endpoints e
    LEFT JOIN (
      SELECT qb_transaction_id FROM public.reconciliation_matches
      WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
      GROUP BY qb_transaction_id HAVING count(*) > 1
    ) d ON d.qb_transaction_id = e.qb_id
    WHERE d.qb_transaction_id IS NULL
  ) THEN
    RAISE EXCEPTION 'STOP: a snapshot duplicate endpoint is no longer duplicate';
  END IF;

  -- 4. (Apply mode) exact pre-state: the affected-row population must be
  --    exactly the snapshot population — 357 live-auto rows on the 107
  --    endpoints, of which 203 approved.
  IF v_mode = 'apply' THEN
    SELECT count(*) INTO v_bad FROM public.reconciliation_matches m
    WHERE m.matched_by = 'auto' AND m.qb_transaction_id IS NOT NULL AND m.superseded_at IS NULL
      AND m.qb_transaction_id IN (SELECT qb_id FROM zaki_endpoints);
    IF v_bad <> 357 THEN
      RAISE EXCEPTION 'STOP: affected live-auto population expected 357, found %', v_bad;
    END IF;
    SELECT count(*) INTO v_bad FROM public.reconciliation_matches m
    WHERE m.matched_by = 'auto' AND m.qb_transaction_id IS NOT NULL AND m.superseded_at IS NULL
      AND m.approved_at IS NOT NULL
      AND m.qb_transaction_id IN (SELECT qb_id FROM zaki_endpoints);
    IF v_bad <> 203 THEN
      RAISE EXCEPTION 'STOP: affected approved population expected 203, found %', v_bad;
    END IF;
    SELECT count(*) INTO v_bad FROM public.reconciliation_matches WHERE approved_at IS NOT NULL;
    IF v_bad <> {EXPECTED['total_approved']} THEN
      RAISE EXCEPTION 'STOP: global approved rows expected {EXPECTED['total_approved']}, found %', v_bad;
    END IF;
  END IF;
END $$;

-- ===========================================================================
-- P1. Supersede exactly the 154 manifest targets (deterministic order)
-- ===========================================================================
DO $apply$
DECLARE
  v_rows int;
BEGIN
  IF current_setting('zaki.repair_mode') <> 'apply' THEN
    RAISE NOTICE 'STAGE 1: dispatch mode is noop — skipping application';
    RETURN;
  END IF;

  -- Row locks in deterministic match-id order (defense in depth; the
  -- ACCESS EXCLUSIVE table locks above already exclude every writer).
  PERFORM 1 FROM public.reconciliation_matches m
  JOIN zaki_manifest t ON t.match_id = m.id
  WHERE t.role = 'target'
  ORDER BY m.id
  FOR UPDATE;

  UPDATE public.reconciliation_matches m SET
    superseded_at = now(),
    superseded_by_match_id = t.survivor_id,
    supersede_reason = t.reason,
    supersede_operation_id = '{STAGE1_OPERATION_ID}'
  FROM zaki_manifest t
  WHERE t.role = 'target' AND t.match_id = m.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> {EXPECTED['stage1_targets']} THEN
    RAISE EXCEPTION 'STOP: stage-1 supersession updated % rows, expected {EXPECTED['stage1_targets']}', v_rows;
  END IF;
  RAISE NOTICE 'STAGE 1: superseded % rows', v_rows;

  -- One audit row per superseded row; previous/resulting state and enriched
  -- repair evidence (operation id, stage, reason, survivor, prior approval
  -- stamps, manifest hash).
  INSERT INTO public.reconciliation_audit_log
    (id, reconciliation_match_id, action, action_by, action_at,
     old_confidence, new_confidence, client_entity_id, user_id,
     operation_id, previous_state, resulting_state, evidence)
  SELECT
    gen_random_uuid(), t.match_id, '{AUDIT_ACTION}', '{STAGE1_ACTOR}', now(),
    t.confidence, t.confidence, t.client_id, t.user_id,
    '{STAGE1_OPERATION_ID}',
    jsonb_build_object(
      'approved_at', t.approved_at,
      'approved_by', t.approved_by,
      'confidence', t.confidence,
      'matched_by', t.matched_by,
      'flagged_level', t.flagged_level,
      'superseded_at', NULL,
      'superseded_by_match_id', NULL,
      'supersede_reason', NULL,
      'supersede_operation_id', NULL
    ),
    jsonb_build_object(
      'approved_at', t.approved_at,
      'approved_by', t.approved_by,
      'confidence', t.confidence,
      'matched_by', t.matched_by,
      'flagged_level', t.flagged_level,
      'superseded_at', now(),
      'superseded_by_match_id', t.survivor_id,
      'supersede_reason', t.reason,
      'supersede_operation_id', '{STAGE1_OPERATION_ID}'
    ),
    jsonb_build_object(
      'stage', '1',
      'class', t.class,
      'reason', t.reason,
      'old_match_id', t.match_id,
      'survivor_match_id', t.survivor_id,
      'previous_approved_at', t.approved_at,
      'previous_approved_by', t.approved_by,
      'previous_confidence', t.confidence,
      'stage1_manifest_sha256', '{manifest_sha}',
      'authorization_manifest_sha256', NULL
    )
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND m.superseded_at IS NOT NULL
    AND m.supersede_operation_id = '{STAGE1_OPERATION_ID}';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> {EXPECTED['stage1_targets']} THEN
    RAISE EXCEPTION 'STOP: stage-1 audit wrote % rows, expected {EXPECTED['stage1_targets']}', v_rows;
  END IF;
  RAISE NOTICE 'STAGE 1: wrote % audit rows', v_rows;
END;
$apply$;

-- ===========================================================================
-- P2. Exact postconditions (set identity, not just counts)
-- ===========================================================================
DO $post$
DECLARE
  v int;
  v_mode text := current_setting('zaki.repair_mode');
BEGIN
  -- 1. Every stage-1 target is superseded (both modes). The superseded set
  --    being EXACTLY the 154 targets holds only in apply mode: after stage 2
  --    has legitimately superseded its own rows, a stage-1 rerun verifies
  --    its own operation state, not the global superseded set.
  IF EXISTS (
    (SELECT match_id FROM zaki_manifest WHERE role = 'target')
    EXCEPT
    (SELECT id FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 target is not superseded';
  END IF;
  IF v_mode = 'apply' AND EXISTS (
    (SELECT id FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL)
    EXCEPT
    (SELECT match_id FROM zaki_manifest WHERE role = 'target')
  ) THEN
    RAISE EXCEPTION 'FAIL: a row outside the stage-1 manifest was superseded';
  END IF;

  -- 2. Every superseded target carries THIS operation, its manifest reason,
  --    and its manifest survivor.
  IF EXISTS (
    SELECT 1 FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'target'
      AND (m.supersede_operation_id IS DISTINCT FROM '{STAGE1_OPERATION_ID}'
           OR m.supersede_reason IS DISTINCT FROM t.reason
           OR m.superseded_by_match_id IS DISTINCT FROM t.survivor_id)
  ) THEN
    RAISE EXCEPTION 'FAIL: superseded target fields differ from the manifest';
  END IF;

  -- 3. Audit mapping: exactly one repair audit row per target, for THIS
  --    operation, and no repair audit rows for anything else.
  IF EXISTS (
    (SELECT match_id FROM zaki_manifest WHERE role = 'target')
    EXCEPT
    (SELECT reconciliation_match_id FROM public.reconciliation_audit_log
     WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE1_OPERATION_ID}')
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 target lacks its repair audit row';
  END IF;
  IF EXISTS (
    (SELECT reconciliation_match_id FROM public.reconciliation_audit_log
     WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE1_OPERATION_ID}')
    EXCEPT
    (SELECT match_id FROM zaki_manifest WHERE role = 'target')
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 repair audit row exists for a non-target';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT reconciliation_match_id FROM public.reconciliation_audit_log
      WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE1_OPERATION_ID}'
      GROUP BY reconciliation_match_id HAVING count(*) > 1
    ) d
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 target has more than one repair audit row';
  END IF;

  -- 4. Intended survivors unchanged: still live, approved, same stamps.
  IF EXISTS (
    SELECT 1 FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'survivor_guard'
      AND (m.approved_at IS NULL
           OR m.superseded_at IS NOT NULL
           OR m.approved_at IS DISTINCT FROM t.approved_at
           OR m.approved_by IS DISTINCT FROM t.approved_by
           OR m.confidence IS DISTINCT FROM t.confidence)
  ) THEN
    RAISE EXCEPTION 'FAIL: an intended survivor was modified or superseded';
  END IF;

  -- 5. No approved row was touched by this operation — and, in apply mode,
  --    no approved row is superseded at all.
  IF EXISTS (
    SELECT 1 FROM public.reconciliation_matches
    WHERE superseded_at IS NOT NULL
      AND supersede_operation_id = '{STAGE1_OPERATION_ID}'
      AND approved_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: stage 1 superseded an approved row';
  END IF;

  IF v_mode = 'apply' THEN
    SELECT count(*) INTO v FROM public.reconciliation_matches
    WHERE superseded_at IS NOT NULL AND approved_at IS NOT NULL;
    IF v <> 0 THEN
      RAISE EXCEPTION 'FAIL: % approved rows are superseded after stage 1 (expected 0)', v;
    END IF;

    -- 6. Global invariants + exact counts.
    SELECT count(*) INTO v FROM public.reconciliation_matches;
    IF v <> {EXPECTED['total_matches']} THEN
      RAISE EXCEPTION 'FAIL: total matches changed to % (no deletes allowed)', v;
    END IF;
    SELECT count(*) INTO v FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL;
    IF v <> {EXPECTED['stage1_targets']} THEN
      RAISE EXCEPTION 'FAIL: superseded rows expected {EXPECTED['stage1_targets']}, found %', v;
    END IF;
    SELECT count(*) INTO v FROM public.reconciliation_matches WHERE superseded_at IS NULL;
    IF v <> 419 THEN
      RAISE EXCEPTION 'FAIL: live rows expected 419, found %', v;
    END IF;
    SELECT count(*) INTO v FROM public.reconciliation_audit_log
    WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE1_OPERATION_ID}';
    IF v <> {EXPECTED['stage1_targets']} THEN
      RAISE EXCEPTION 'FAIL: stage-1 repair audit rows expected {EXPECTED['stage1_targets']}, found %', v;
    END IF;
    SELECT count(*) INTO v FROM public.reconciliation_matches
    WHERE superseded_at IS NOT NULL AND supersede_reason IS NULL;
    IF v <> 0 THEN
      RAISE EXCEPTION 'FAIL: % superseded rows lack a reason', v;
    END IF;

    -- 7. Exact remaining duplicate-endpoint set (91 after stage 1).
    IF EXISTS (
      (SELECT qb_transaction_id FROM (
         SELECT qb_transaction_id FROM public.reconciliation_matches
         WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
         GROUP BY qb_transaction_id HAVING count(*) > 1
       ) d)
      EXCEPT
      (SELECT qb_id FROM zaki_endpoints WHERE resolved_by_stage1 = false)
    ) THEN
      RAISE EXCEPTION 'FAIL: an unexpected endpoint remains duplicate';
    END IF;
    IF EXISTS (
      (SELECT qb_id FROM zaki_endpoints WHERE resolved_by_stage1 = false)
      EXCEPT
      (SELECT qb_transaction_id FROM (
         SELECT qb_transaction_id FROM public.reconciliation_matches
         WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
         GROUP BY qb_transaction_id HAVING count(*) > 1
       ) d)
    ) THEN
      RAISE EXCEPTION 'FAIL: an endpoint expected to remain duplicate was resolved early';
    END IF;
  ELSE
    RAISE NOTICE 'STAGE 1: ALREADY APPLIED — verified % targets carry this operation with correct fields and audit rows; no-op commit',
      (SELECT count(*) FROM zaki_manifest WHERE role = 'target');
  END IF;
END;
$post$;

COMMIT;
"""
    return s1


def stage2_sql(s2t, s2g, s1t, dup_after_s1, auth_manifest_sha, n_exec):
    """Emit stage-2 SQL from a signed authorization manifest.

    s2t/s2g: candidate and guard rows WITH authorization columns.
    s1t: stage-1 target ids (sequencing precondition).
    dup_after_s1: post-stage-1 endpoint set (precondition in apply mode).
    auth_manifest_sha: SHA-256 of the signed authorization manifest CSV.
    n_exec: number of rows authorized for retirement.
    """
    # Rows the SQL will retire: role=target, APPROVED_FOR_RETIREMENT, RETIRE.
    exec_ids = [
        r["match_id"] for r in s2t
        if r["authorization_status"] == "APPROVED_FOR_RETIREMENT"
        and r["accountant_decision"] == "RETIRE"
    ]
    if len(exec_ids) != n_exec:
        raise SystemExit(
            f"authorization manifest inconsistent: {len(exec_ids)} executable "
            f"rows, expected {n_exec}"
        )
    # Pre-stage-2 duplicate endpoint set = the stage-1 remainder (91), taken
    # from dup_after_s1. The post-stage-2 set is derived from the authorized
    # subset: an endpoint remains duplicate iff >=2 of its manifest rows
    # (candidates + guards) are NOT retired by this execution.
    pre_set = [
        r["qb_transaction_id"] for r in dup_after_s1
        if not r["resolved_by_stage1"]
    ]
    retired = set(exec_ids)
    ep_rows = defaultdict(list)
    for r in s2t + s2g:
        ep_rows[r["qb_transaction_id"]].append(r)
    remaining = []
    for qb_id in sorted(pre_set):
        rows = ep_rows[qb_id]
        live = [r for r in rows if r["match_id"] not in retired]
        remaining.append({"qb_transaction_id": qb_id,
                          "still_duplicate": len(live) >= 2})

    s2 = f"""-- =============================================================================
-- ZAKI-REPAIR-013-PRE — STAGE 2: APPROVED-ROW REPAIR (accountant-authorized)
-- =============================================================================
-- Package:    supabase/repair-013-pre (historical repair hardening)
-- Authorization manifest: {auth_manifest_sha}
--             (verified by bin/build_repair_package.py verify; this SQL was
--              regenerated from that exact manifest file)
-- Stage-1 prerequisite: 14a-stage1-unapproved-repair.sql must have run with
--             operation {STAGE1_OPERATION_ID}.
-- Operation:  {STAGE2_OPERATION_ID}  (fixed per package release — the
--             semantic idempotency key)
--
-- Scope: supersedes EXACTLY the rows in the authorization manifest whose
--        authorization_status = 'APPROVED_FOR_RETIREMENT' and
--        accountant_decision = 'RETIRE' ({n_exec} rows). Rows with any
--        other decision are asserted untouched. NO DELETE. One transaction.
--        Fails closed on any drift.
--
-- Actor identity: every stage-2 audit row records the confirming
--        accountant's identity from the manifest (action_by), never a
--        system identity — the system does not make accounting judgements.
--
-- Execution gate: this file may only be executed against production inside
--        an explicitly authorized repair window (see execution-window.md).
--        The committed version of this file is generated from the
--        REHEARSAL-ONLY test authorization manifest and MUST NOT be used in
--        production; the production window regenerates it from the
--        accountant-signed manifest.
--
-- Writer exclusion (P0a): identical to stage 1 (execution-window.md).

SET search_path = pg_temp, public;

BEGIN;

-- Serialize repair attempts. Both stages share this key, so stage 1 and
-- stage 2 also serialize against each other.
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});  -- 'ZAKI'

-- ===========================================================================
-- P0a. Writer exclusion: database-side execution locks
-- ===========================================================================
LOCK TABLE public.bank_statements IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.bank_transactions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.qb_transactions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_matches IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_audit_log IN ACCESS EXCLUSIVE MODE;

-- ===========================================================================
-- P0b. Manifest load (authorized candidates + survivor guards)
-- ===========================================================================
CREATE TEMP TABLE zaki_manifest (
  match_id     uuid PRIMARY KEY,
  role         text NOT NULL CHECK (role IN ('target','survivor_guard')),
  class        text NOT NULL,
  stage        int NOT NULL CHECK (stage = 2),
  reason       text NOT NULL,
  action       text NOT NULL,
  qb_id        uuid NOT NULL,
  qb_date      date NOT NULL,
  qb_amount    numeric(12,2) NOT NULL,
  qb_desc      text NOT NULL,
  qb_desc_fp   text NOT NULL,
  qb_book      uuid NOT NULL,
  bank_id      uuid NOT NULL,
  bank_date    date NOT NULL,
  bank_amount  numeric(12,2) NOT NULL,
  bank_desc    text NOT NULL,
  bank_desc_fp text NOT NULL,
  bank_merchant text NOT NULL,
  statement_id uuid NOT NULL,
  stmt_file    text NOT NULL,
  stmt_upload  timestamptz NOT NULL,
  stmt_book    uuid NOT NULL,
  user_id      uuid NOT NULL,
  client_id    uuid NOT NULL,
  practice_id  uuid NOT NULL,
  matched_by   text NOT NULL,
  matched_at   timestamptz NOT NULL,
  confidence   numeric(4,3) NOT NULL,
  flagged_level text NOT NULL,
  approved_at  timestamptz,
  approved_by  text,
  survivor_id  uuid,
  evidence     text NOT NULL,
  accountant_decision text,
  accountant_identity text,
  confirmation_timestamp timestamptz,
  authorization_status text
) ON COMMIT DROP;

INSERT INTO zaki_manifest
  (match_id, role, class, stage, reason, action,
   qb_id, qb_date, qb_amount, qb_desc, qb_desc_fp, qb_book,
   bank_id, bank_date, bank_amount, bank_desc, bank_desc_fp, bank_merchant,
   statement_id, stmt_file, stmt_upload, stmt_book,
   user_id, client_id, practice_id, matched_by, matched_at, confidence,
   flagged_level, approved_at, approved_by, survivor_id, evidence,
   accountant_decision, accountant_identity, confirmation_timestamp,
   authorization_status)
VALUES
{auth_row_values(s2t + s2g)};

CREATE TEMP TABLE zaki_s1_targets (match_id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO zaki_s1_targets (match_id) VALUES
{stage1_id_values(s1t)};

CREATE TEMP TABLE zaki_endpoints (
  qb_id uuid PRIMARY KEY,
  still_duplicate boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO zaki_endpoints (qb_id, still_duplicate) VALUES
{stage2_endpoint_values(remaining)};

DO $$
DECLARE
  v int;
BEGIN
  IF (SELECT count(*) FROM zaki_manifest WHERE role = 'target') <> {EXPECTED['stage2_candidates']} THEN
    RAISE EXCEPTION 'STOP: manifest integrity failure (candidate count)';
  END IF;
  IF (SELECT count(*) FROM zaki_manifest WHERE role = 'survivor_guard') <> {EXPECTED['stage2_guards']} THEN
    RAISE EXCEPTION 'STOP: manifest integrity failure (guard count)';
  END IF;
  IF (SELECT count(*) FROM zaki_manifest
      WHERE role = 'target' AND authorization_status = 'APPROVED_FOR_RETIREMENT'
        AND accountant_decision = 'RETIRE') <> {n_exec} THEN
    RAISE EXCEPTION 'STOP: authorized-execution set does not match the manifest hash ({n_exec} expected)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM zaki_manifest
    WHERE role = 'target' AND authorization_status = 'APPROVED_FOR_RETIREMENT'
      AND (accountant_identity IS NULL OR btrim(accountant_identity) = ''
           OR confirmation_timestamp IS NULL)
  ) THEN
    RAISE EXCEPTION 'STOP: an authorized row lacks accountant identity or confirmation timestamp';
  END IF;
END $$;

-- ===========================================================================
-- P0c. Stage-1 completion precondition (exact ids + exact operation)
-- ===========================================================================
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM zaki_s1_targets t
  LEFT JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE m.id IS NULL
     OR m.superseded_at IS NULL
     OR m.supersede_operation_id IS DISTINCT FROM '{STAGE1_OPERATION_ID}'
     OR NOT EXISTS (
       SELECT 1 FROM public.reconciliation_audit_log a
       WHERE a.reconciliation_match_id = t.match_id
         AND a.action = '{AUDIT_ACTION}'
         AND a.operation_id = '{STAGE1_OPERATION_ID}'
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: stage 1 has not completed with this package (% of % targets missing); run stage 1 first', v_bad, {EXPECTED['stage1_targets']};
  END IF;
END $$;

-- ===========================================================================
-- P0d. Stage dispatcher (semantic idempotency on THIS operation id)
-- ===========================================================================
DO $$
DECLARE
  v_total  int;
  v_manual int;
  v_live   int;
  v_done   int;
  v_other  int;
BEGIN
  SELECT count(*) INTO v_total FROM public.reconciliation_matches;
  IF v_total <> {EXPECTED['total_matches']} THEN
    RAISE EXCEPTION 'STOP: total matches expected {EXPECTED['total_matches']}, found %', v_total;
  END IF;
  SELECT count(*) INTO v_manual FROM public.reconciliation_matches WHERE matched_by = 'manual';
  IF v_manual <> {EXPECTED['total_manual']} THEN
    RAISE EXCEPTION 'STOP: manual rows appeared (expected 0), found %', v_manual;
  END IF;

  -- Executable targets still live (pristine stage-2 pre-state).
  SELECT count(*) INTO v_live
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
    AND t.accountant_decision = 'RETIRE'
    AND m.superseded_at IS NULL;

  -- Executable targets already superseded by THIS operation, correct fields
  -- and audit rows.
  SELECT count(*) INTO v_done
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
    AND t.accountant_decision = 'RETIRE'
    AND m.superseded_at IS NOT NULL
    AND m.supersede_operation_id = '{STAGE2_OPERATION_ID}'
    AND m.supersede_reason = t.reason
    AND m.superseded_by_match_id IS NOT DISTINCT FROM t.survivor_id
    AND EXISTS (
      SELECT 1 FROM public.reconciliation_audit_log a
      WHERE a.reconciliation_match_id = t.match_id
        AND a.action = '{AUDIT_ACTION}'
        AND a.operation_id = '{STAGE2_OPERATION_ID}'
    );

  SELECT count(*) INTO v_other
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
    AND t.accountant_decision = 'RETIRE'
    AND m.superseded_at IS NOT NULL
    AND m.supersede_operation_id IS DISTINCT FROM '{STAGE2_OPERATION_ID}';

  IF v_other > 0 THEN
    RAISE EXCEPTION 'STOP: % stage-2 targets superseded by a different operation id; state was not produced by this package', v_other;
  END IF;

  IF v_done = {n_exec} AND v_live = 0 THEN
    PERFORM set_config('zaki.repair_mode', 'noop', true);
  ELSIF v_live = {n_exec} AND v_done = 0 THEN
    PERFORM set_config('zaki.repair_mode', 'apply', true);
  ELSE
    RAISE EXCEPTION 'STOP: unexpected partial stage-2 state (live=%, done=%)', v_live, v_done;
  END IF;
END $$;

-- ===========================================================================
-- P0e. Exact drift preconditions (every manifest row vs live DB state)
-- ===========================================================================
DO $$
DECLARE
  v_bad int;
  v_mode text := current_setting('zaki.repair_mode');
BEGIN
  -- 1. Endpoint identity + value fingerprints for EVERY manifest row.
  SELECT count(*) INTO v_bad
  FROM zaki_manifest t
  LEFT JOIN public.reconciliation_matches m ON m.id = t.match_id
  LEFT JOIN public.bank_transactions b ON b.id = t.bank_id
  LEFT JOIN public.qb_transactions q ON q.id = t.qb_id
  LEFT JOIN public.bank_statements s ON s.id = t.statement_id
  WHERE m.id IS NULL
     OR (m.user_id, m.client_entity_id, m.statement_id, m.bank_transaction_id, m.qb_transaction_id)
        IS DISTINCT FROM (t.user_id, t.client_id, t.statement_id, t.bank_id, t.qb_id)
     OR (b.user_id, b.statement_id, b.client_entity_id, b.transaction_date, b.amount)
        IS DISTINCT FROM (t.user_id, t.statement_id, t.client_id, t.bank_date, t.bank_amount)
     OR (q.user_id, q.client_entity_id, q.ledger_book_id, q.posted_date, q.amount)
        IS DISTINCT FROM (t.user_id, t.client_id, t.qb_book, t.qb_date, t.qb_amount)
     OR (s.user_id, s.client_entity_id, s.ledger_book_id, s.file_name, s.upload_date)
        IS DISTINCT FROM (t.user_id, t.client_id, t.stmt_book, t.stmt_file, t.stmt_upload)
     OR m.confidence IS DISTINCT FROM t.confidence
     OR m.matched_by IS DISTINCT FROM t.matched_by
     OR m.matched_at IS DISTINCT FROM t.matched_at
     OR m.flagged_level IS DISTINCT FROM t.flagged_level
     OR b.merchant IS DISTINCT FROM t.bank_merchant
     OR b.description IS DISTINCT FROM t.bank_desc
     OR q.description IS DISTINCT FROM t.qb_desc
     OR encode(extensions.digest(convert_to(btrim(regexp_replace(lower(b.description), '\\s+', ' ', 'g')), 'UTF8'), 'sha256'), 'hex')
        IS DISTINCT FROM t.bank_desc_fp
     OR encode(extensions.digest(convert_to(btrim(regexp_replace(lower(q.description), '\\s+', ' ', 'g')), 'UTF8'), 'sha256'), 'hex')
        IS DISTINCT FROM t.qb_desc_fp;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % manifest rows drifted from the accepted snapshot (identity/value drift)', v_bad;
  END IF;

  -- 2. Approval-state drift: every candidate and guard must still be
  --    approved with its exact snapshot stamps; guards must still be live.
  SELECT count(*) INTO v_bad
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE m.approved_at IS NULL
     OR m.approved_at IS DISTINCT FROM t.approved_at
     OR m.approved_by IS DISTINCT FROM t.approved_by
     OR (t.role = 'survivor_guard'
         AND (m.superseded_at IS NOT NULL
              OR m.confidence IS DISTINCT FROM t.confidence
              OR abs((SELECT b.amount FROM public.bank_transactions b WHERE b.id = m.bank_transaction_id)
                   - (SELECT q.amount FROM public.qb_transactions q WHERE q.id = m.qb_transaction_id)) > 0.01));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % stage-2 rows drifted from the expected approval state', v_bad;
  END IF;

  -- 3. Duplicate-endpoint set must be exactly the post-stage-1 set (apply
  --    mode) / the expected post-stage-2 set (noop mode) — both directions,
  --    so an unexpected new duplicate or an unexplained resolution aborts.
  IF v_mode = 'apply' THEN
    IF EXISTS (
      (SELECT qb_transaction_id FROM (
         SELECT qb_transaction_id FROM public.reconciliation_matches
         WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
         GROUP BY qb_transaction_id HAVING count(*) > 1
       ) d)
      EXCEPT
      (SELECT qb_id FROM zaki_endpoints)
    ) THEN
      RAISE EXCEPTION 'STOP: unexpected duplicate live-auto endpoint appeared since stage 1';
    END IF;
    IF EXISTS (
      (SELECT qb_id FROM zaki_endpoints)
      EXCEPT
      (SELECT qb_transaction_id FROM (
         SELECT qb_transaction_id FROM public.reconciliation_matches
         WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
         GROUP BY qb_transaction_id HAVING count(*) > 1
       ) d)
    ) THEN
      RAISE EXCEPTION 'STOP: a stage-2 endpoint disappeared from the duplicate set before execution';
    END IF;
  ELSE
    IF EXISTS (
      (SELECT qb_transaction_id FROM (
         SELECT qb_transaction_id FROM public.reconciliation_matches
         WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
         GROUP BY qb_transaction_id HAVING count(*) > 1
       ) d)
      EXCEPT
      (SELECT qb_id FROM zaki_endpoints WHERE still_duplicate)
    ) THEN
      RAISE EXCEPTION 'STOP: an endpoint not resolved by the authorized set remains duplicate';
    END IF;
    IF EXISTS (
      (SELECT qb_id FROM zaki_endpoints WHERE still_duplicate)
      EXCEPT
      (SELECT qb_transaction_id FROM (
         SELECT qb_transaction_id FROM public.reconciliation_matches
         WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
         GROUP BY qb_transaction_id HAVING count(*) > 1
       ) d)
    ) THEN
      RAISE EXCEPTION 'STOP: an endpoint expected to remain duplicate was resolved early';
    END IF;
  END IF;

  -- 4. (Apply mode) exact pre-state: only the 10 non-duplicate smoke rows
  --    may be live-unapproved, and approved-live must be 409.
  IF v_mode = 'apply' THEN
    SELECT count(*) INTO v_bad FROM public.reconciliation_matches
    WHERE matched_by = 'auto' AND superseded_at IS NULL AND approved_at IS NULL;
    IF v_bad <> {EXPECTED['live_unapproved_after_stage1']} THEN
      RAISE EXCEPTION 'STOP: live unapproved rows expected {EXPECTED['live_unapproved_after_stage1']}, found %', v_bad;
    END IF;
    SELECT count(*) INTO v_bad FROM public.reconciliation_matches
    WHERE approved_at IS NOT NULL AND superseded_at IS NULL;
    IF v_bad <> {EXPECTED['total_approved']} THEN
      RAISE EXCEPTION 'STOP: live approved rows expected {EXPECTED['total_approved']}, found %', v_bad;
    END IF;
  END IF;
END $$;

-- ===========================================================================
-- P1. Supersede exactly the authorized rows (deterministic order)
-- ===========================================================================
DO $apply$
DECLARE
  v_rows int;
BEGIN
  IF current_setting('zaki.repair_mode') <> 'apply' THEN
    RAISE NOTICE 'STAGE 2: dispatch mode is noop — skipping application';
    RETURN;
  END IF;

  PERFORM 1 FROM public.reconciliation_matches m
  JOIN zaki_manifest t ON t.match_id = m.id
  WHERE t.role = 'target'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
    AND t.accountant_decision = 'RETIRE'
  ORDER BY m.id
  FOR UPDATE;

  UPDATE public.reconciliation_matches m SET
    superseded_at = now(),
    superseded_by_match_id = t.survivor_id,
    supersede_reason = t.reason,
    supersede_operation_id = '{STAGE2_OPERATION_ID}'
  FROM zaki_manifest t
  WHERE t.role = 'target'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
    AND t.accountant_decision = 'RETIRE'
    AND t.match_id = m.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> {n_exec} THEN
    RAISE EXCEPTION 'STOP: stage-2 supersession updated % rows, expected {n_exec}', v_rows;
  END IF;
  RAISE NOTICE 'STAGE 2: superseded % authorized rows', v_rows;

  -- One audit row per superseded row. action_by is the confirming
  -- accountant's identity from the authorization manifest — the system
  -- identity never makes stage-2 accounting judgements.
  INSERT INTO public.reconciliation_audit_log
    (id, reconciliation_match_id, action, action_by, action_at,
     old_confidence, new_confidence, client_entity_id, user_id,
     operation_id, previous_state, resulting_state, evidence)
  SELECT
    gen_random_uuid(), t.match_id, '{AUDIT_ACTION}',
    t.accountant_identity, now(),
    t.confidence, t.confidence, t.client_id, t.user_id,
    '{STAGE2_OPERATION_ID}',
    jsonb_build_object(
      'approved_at', t.approved_at,
      'approved_by', t.approved_by,
      'confidence', t.confidence,
      'matched_by', t.matched_by,
      'flagged_level', t.flagged_level,
      'superseded_at', NULL,
      'superseded_by_match_id', NULL,
      'supersede_reason', NULL,
      'supersede_operation_id', NULL
    ),
    jsonb_build_object(
      'approved_at', t.approved_at,
      'approved_by', t.approved_by,
      'confidence', t.confidence,
      'matched_by', t.matched_by,
      'flagged_level', t.flagged_level,
      'superseded_at', now(),
      'superseded_by_match_id', t.survivor_id,
      'supersede_reason', t.reason,
      'supersede_operation_id', '{STAGE2_OPERATION_ID}'
    ),
    jsonb_build_object(
      'stage', '2',
      'class', t.class,
      'reason', t.reason,
      'old_match_id', t.match_id,
      'survivor_match_id', t.survivor_id,
      'previous_approved_at', t.approved_at,
      'previous_approved_by', t.approved_by,
      'previous_confidence', t.confidence,
      'accountant_identity', t.accountant_identity,
      'confirmation_timestamp', t.confirmation_timestamp,
      'authorization_status', t.authorization_status,
      'stage1_manifest_sha256', NULL,
      'authorization_manifest_sha256', '{auth_manifest_sha}'
    )
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
    AND t.accountant_decision = 'RETIRE'
    AND m.superseded_at IS NOT NULL
    AND m.supersede_operation_id = '{STAGE2_OPERATION_ID}';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> {n_exec} THEN
    RAISE EXCEPTION 'STOP: stage-2 audit wrote % rows, expected {n_exec}', v_rows;
  END IF;
  RAISE NOTICE 'STAGE 2: wrote % audit rows', v_rows;
END;
$apply$;

-- ===========================================================================
-- P2. Exact postconditions (set identity, not just counts)
-- ===========================================================================
DO $post$
DECLARE
  v int;
  v_mode text := current_setting('zaki.repair_mode');
BEGIN
  -- 1. The superseded set is EXACTLY stage-1 targets ∪ authorized retirees.
  IF EXISTS (
    ((SELECT match_id FROM zaki_s1_targets)
     UNION ALL
     (SELECT match_id FROM zaki_manifest
      WHERE role = 'target' AND authorization_status = 'APPROVED_FOR_RETIREMENT'
        AND accountant_decision = 'RETIRE'))
    EXCEPT
    (SELECT id FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'FAIL: an authorized or stage-1 target is not superseded';
  END IF;
  IF EXISTS (
    (SELECT id FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL)
    EXCEPT
    ((SELECT match_id FROM zaki_s1_targets)
     UNION ALL
     (SELECT match_id FROM zaki_manifest
      WHERE role = 'target' AND authorization_status = 'APPROVED_FOR_RETIREMENT'
        AND accountant_decision = 'RETIRE'))
  ) THEN
    RAISE EXCEPTION 'FAIL: a row outside the authorized sets was superseded';
  END IF;

  -- 2. Every superseded row carries the correct operation, reason, survivor.
  IF EXISTS (
    SELECT 1 FROM zaki_s1_targets t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE m.supersede_operation_id IS DISTINCT FROM '{STAGE1_OPERATION_ID}'
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 target lost its operation id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'target'
      AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
      AND t.accountant_decision = 'RETIRE'
      AND (m.supersede_operation_id IS DISTINCT FROM '{STAGE2_OPERATION_ID}'
           OR m.supersede_reason IS DISTINCT FROM t.reason
           OR m.superseded_by_match_id IS DISTINCT FROM t.survivor_id)
  ) THEN
    RAISE EXCEPTION 'FAIL: superseded target fields differ from the authorization manifest';
  END IF;

  -- 3. Audit mapping: exact sets for both operations.
  IF EXISTS (
    (SELECT reconciliation_match_id FROM public.reconciliation_audit_log
     WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE1_OPERATION_ID}')
    EXCEPT
    (SELECT match_id FROM zaki_s1_targets)
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 audit row exists for a non-target';
  END IF;
  IF EXISTS (
    (SELECT reconciliation_match_id FROM public.reconciliation_audit_log
     WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE2_OPERATION_ID}')
    EXCEPT
    (SELECT match_id FROM zaki_manifest
     WHERE role = 'target' AND authorization_status = 'APPROVED_FOR_RETIREMENT'
       AND accountant_decision = 'RETIRE')
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-2 audit row exists for a non-authorized row';
  END IF;
  IF EXISTS (
    (SELECT match_id FROM zaki_s1_targets)
    EXCEPT
    (SELECT reconciliation_match_id FROM public.reconciliation_audit_log
     WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE1_OPERATION_ID}')
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 target lacks its repair audit row';
  END IF;
  IF EXISTS (
    (SELECT match_id FROM zaki_manifest
     WHERE role = 'target' AND authorization_status = 'APPROVED_FOR_RETIREMENT'
       AND accountant_decision = 'RETIRE')
    EXCEPT
    (SELECT reconciliation_match_id FROM public.reconciliation_audit_log
     WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE2_OPERATION_ID}')
  ) THEN
    RAISE EXCEPTION 'FAIL: an authorized retiree lacks its repair audit row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT reconciliation_match_id FROM public.reconciliation_audit_log
      WHERE action = '{AUDIT_ACTION}'
        AND operation_id IN ('{STAGE1_OPERATION_ID}', '{STAGE2_OPERATION_ID}')
      GROUP BY reconciliation_match_id HAVING count(*) > 1
    ) d
  ) THEN
    RAISE EXCEPTION 'FAIL: a target has more than one repair audit row';
  END IF;

  -- 4. Stage-2 audit rows record the confirming accountant, never the system.
  IF EXISTS (
    SELECT 1 FROM public.reconciliation_audit_log a
    JOIN zaki_manifest t ON t.match_id = a.reconciliation_match_id
    WHERE a.operation_id = '{STAGE2_OPERATION_ID}'
      AND (a.action_by IS DISTINCT FROM t.accountant_identity
           OR a.action_by IS NULL
           OR a.action_by = '{STAGE1_ACTOR}')
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-2 audit row does not carry the confirming accountant identity';
  END IF;

  -- 5. Intended survivors unchanged: live, approved, same stamps.
  IF EXISTS (
    SELECT 1 FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'survivor_guard'
      AND (m.approved_at IS NULL
           OR m.superseded_at IS NOT NULL
           OR m.approved_at IS DISTINCT FROM t.approved_at
           OR m.approved_by IS DISTINCT FROM t.approved_by
           OR m.confidence IS DISTINCT FROM t.confidence)
  ) THEN
    RAISE EXCEPTION 'FAIL: an intended survivor was modified or superseded';
  END IF;

  -- 6. Non-executed candidates remain untouched and live.
  IF EXISTS (
    SELECT 1 FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'target'
      AND NOT (t.authorization_status = 'APPROVED_FOR_RETIREMENT'
               AND t.accountant_decision = 'RETIRE')
      AND m.superseded_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: a non-authorized candidate was superseded';
  END IF;

  IF v_mode = 'apply' THEN
    -- 7. Global invariants + exact counts.
    SELECT count(*) INTO v FROM public.reconciliation_matches;
    IF v <> {EXPECTED['total_matches']} THEN
      RAISE EXCEPTION 'FAIL: total matches changed to % (no deletes allowed)', v;
    END IF;
    SELECT count(*) INTO v FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL;
    IF v <> {EXPECTED['stage1_targets'] + n_exec} THEN
      RAISE EXCEPTION 'FAIL: superseded rows expected {EXPECTED['stage1_targets'] + n_exec}, found %', v;
    END IF;
    SELECT count(*) INTO v FROM public.reconciliation_matches WHERE superseded_at IS NULL;
    IF v <> {EXPECTED['total_matches'] - EXPECTED['stage1_targets'] - n_exec} THEN
      RAISE EXCEPTION 'FAIL: live rows expected {EXPECTED['total_matches'] - EXPECTED['stage1_targets'] - n_exec}, found %', v;
    END IF;
    SELECT count(*) INTO v FROM public.reconciliation_audit_log
    WHERE action = '{AUDIT_ACTION}' AND operation_id IN ('{STAGE1_OPERATION_ID}', '{STAGE2_OPERATION_ID}');
    IF v <> {EXPECTED['stage1_targets'] + n_exec} THEN
      RAISE EXCEPTION 'FAIL: repair audit rows expected {EXPECTED['stage1_targets'] + n_exec}, found %', v;
    END IF;
    SELECT count(*) INTO v FROM public.reconciliation_matches
    WHERE superseded_at IS NOT NULL AND supersede_reason IS NULL;
    IF v <> 0 THEN
      RAISE EXCEPTION 'FAIL: % superseded rows lack a reason', v;
    END IF;

    -- 8. Exact remaining duplicate-endpoint set.
    IF EXISTS (
      (SELECT qb_transaction_id FROM (
         SELECT qb_transaction_id FROM public.reconciliation_matches
         WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
         GROUP BY qb_transaction_id HAVING count(*) > 1
       ) d)
      EXCEPT
      (SELECT qb_id FROM zaki_endpoints WHERE still_duplicate)
    ) THEN
      RAISE EXCEPTION 'FAIL: an endpoint not in the authorized remainder set is still duplicate';
    END IF;
    IF EXISTS (
      (SELECT qb_id FROM zaki_endpoints WHERE still_duplicate)
      EXCEPT
      (SELECT qb_transaction_id FROM (
         SELECT qb_transaction_id FROM public.reconciliation_matches
         WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
         GROUP BY qb_transaction_id HAVING count(*) > 1
       ) d)
    ) THEN
      RAISE EXCEPTION 'FAIL: an endpoint expected to remain duplicate was resolved early';
    END IF;
  ELSE
    RAISE NOTICE 'STAGE 2: ALREADY APPLIED — verified % authorized rows carry this operation with correct fields and audit rows; no-op commit', {n_exec};
  END IF;
END;
$post$;

COMMIT;
"""
    return s2


def stage1_id_values(s1t):
    return sql_values(["match_id"], [{"match_id": r["match_id"]} for r in s1t])


def stage2_endpoint_values(rows):
    return sql_values(
        ["qb_transaction_id", "still_duplicate"],
        [
            {
                "qb_transaction_id": r["qb_transaction_id"],
                "still_duplicate": r["still_duplicate"],
            }
            for r in rows
        ],
    )


def cmd_sql(auth_manifest, snapshot_dir, dry_run=False):
    snap = load_snapshot(snapshot_dir)
    (s1t, s1g, s2t, s2g, dup_eps, dup_after_s1, r6) = build_rows(snap)

    stage1_manifest_path = MANIFEST_DIR / "stage1-unapproved-targets.csv"
    stage1_manifest_sha = sha256_file(stage1_manifest_path)

    auth_rows = read_csv(auth_manifest)
    auth_sha = sha256_file(auth_manifest)
    auth_targets = [r for r in auth_rows if r["role"] == "target"]
    auth_guards = [r for r in auth_rows if r["role"] == "survivor_guard"]
    if len(auth_targets) != EXPECTED["stage2_candidates"]:
        raise SystemExit(
            f"authorization manifest has {len(auth_targets)} candidates, "
            f"expected {EXPECTED['stage2_candidates']}"
        )
    if len(auth_guards) != EXPECTED["stage2_guards"]:
        raise SystemExit(
            f"authorization manifest has {len(auth_guards)} guards, "
            f"expected {EXPECTED['stage2_guards']}"
        )
    n_exec = sum(
        1 for r in auth_targets
        if r["authorization_status"] == "APPROVED_FOR_RETIREMENT"
        and r["accountant_decision"] == "RETIRE"
    )
    # Every authorized retiree must reference a live guard (its survivor);
    # a NULL survivor (R5 synthetic test rows) is legitimate.
    guard_ids = {r["match_id"] for r in auth_guards}
    for r in auth_targets:
        if (
            r["authorization_status"] == "APPROVED_FOR_RETIREMENT"
            and r["accountant_decision"] == "RETIRE"
            and r["intended_survivor_match_id"]
            and r["intended_survivor_match_id"] not in guard_ids
        ):
            raise SystemExit(
                f"authorized retiree {r['match_id']} references survivor "
                f"{r['intended_survivor_match_id']} which is not guarded"
            )

    s1_sql = stage1_sql(s1t, s1g, dup_eps, dup_after_s1, stage1_manifest_sha)
    s2_sql = stage2_sql(auth_targets, auth_guards, s1t, dup_after_s1,
                        auth_sha, n_exec)

    if dry_run:
        print(s1_sql)
        print("=" * 80)
        print(s2_sql)
        return

    SQL_STAGE1.write_text(s1_sql, encoding="utf-8")
    SQL_STAGE2.write_text(s2_sql, encoding="utf-8")
    print(f"wrote {SQL_STAGE1}")
    print(f"wrote {SQL_STAGE2} (authorization manifest sha256={auth_sha[:16]}…, {n_exec} authorized)")


def cmd_verify(snapshot_dir, auth_manifest=None):
    errors = []
    identities = json.load(open(MANIFEST_DIR / "manifest-identities.json"))

    # 1. Manifest files exist and hash to the recorded identities.
    for name, meta in identities["manifests"].items():
        path = MANIFEST_DIR / name
        if not path.exists():
            errors.append(f"missing manifest {name}")
            continue
        got = sha256_file(path)
        if got != meta["sha256"]:
            errors.append(f"manifest {name} hash mismatch: {got} != {meta['sha256']}")
        if len(read_csv(path)) != meta["rows"]:
            errors.append(f"manifest {name} row count changed")

    # 2. Snapshot provenance hashes still match (if the snapshot dir exists).
    snap_dir = Path(snapshot_dir)
    if snap_dir.exists():
        prov = identities["package"]["snapshot_provenance"]
        for name, meta in prov.items():
            p = snap_dir / name
            if not p.exists():
                errors.append(f"snapshot file {name} missing from {snap_dir}")
            elif sha256_file(p) != meta["sha256"]:
                errors.append(f"snapshot file {name} hash drifted")
    else:
        print(f"note: snapshot dir {snap_dir} absent — provenance not re-checked")

    # 3. Classification still reproducible from the snapshot.
    if snap_dir.exists():
        try:
            snap = load_snapshot(str(snap_dir))
            build_rows(snap)
        except SystemExit as e:
            errors.append(f"classification re-derivation failed: {e}")

    # 4. Stage-1 SQL binds the current stage-1 manifest hash and the fixed
    #    operation ids.
    s1 = SQL_STAGE1.read_text(encoding="utf-8")
    want_sha = identities["manifests"]["stage1-unapproved-targets.csv"]["sha256"]
    if want_sha not in s1:
        errors.append("stage-1 SQL does not embed the current stage-1 manifest hash")
    for op in (STAGE1_OPERATION_ID,):
        if op not in s1:
            errors.append(f"stage-1 SQL missing operation id {op}")

    # 5. Stage-2 SQL binds the authorization manifest it was generated from.
    s2 = SQL_STAGE2.read_text(encoding="utf-8")
    auth_name = auth_manifest or "stage2-test-authorization-manifest.csv"
    auth_path = (
        Path(auth_manifest) if auth_manifest else MANIFEST_DIR / auth_name
    )
    auth_sha = sha256_file(auth_path)
    if auth_sha not in s2:
        errors.append(
            f"stage-2 SQL does not embed the hash of {auth_name} "
            f"({auth_sha})"
        )
    if STAGE2_OPERATION_ID not in s2:
        errors.append(f"stage-2 SQL missing operation id {STAGE2_OPERATION_ID}")
    if STAGE1_OPERATION_ID not in s2:
        errors.append("stage-2 SQL missing the stage-1 sequencing operation id")

    # 6. Determinism: regenerating the SQL must be byte-identical.
    import io
    import contextlib
    snap = load_snapshot(str(snap_dir)) if snap_dir.exists() else None
    if snap is not None:
        (s1t, s1g, s2t, s2g, dup_eps, dup_after_s1, r6) = build_rows(snap)
        stage1_manifest_sha = sha256_file(
            MANIFEST_DIR / "stage1-unapproved-targets.csv"
        )
        regen1 = stage1_sql(s1t, s1g, dup_eps, dup_after_s1, stage1_manifest_sha)
        auth_rows = read_csv(auth_path)
        auth_targets = [r for r in auth_rows if r["role"] == "target"]
        auth_guards = [r for r in auth_rows if r["role"] == "survivor_guard"]
        n_exec = sum(
            1 for r in auth_targets
            if r["authorization_status"] == "APPROVED_FOR_RETIREMENT"
            and r["accountant_decision"] == "RETIRE"
        )
        regen2 = stage2_sql(auth_targets, auth_guards, s1t, dup_after_s1,
                            auth_sha, n_exec)
        if regen1 != s1:
            errors.append("stage-1 SQL is not byte-identical to a regeneration")
        if regen2 != s2:
            errors.append("stage-2 SQL is not byte-identical to a regeneration")

    if errors:
        print("VERIFY FAILED:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("VERIFY OK: manifests, hashes, classification, and SQL binding all consistent.")


# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--snapshot-dir", default="/tmp/zaki-repair-design")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("manifests")
    sp = sub.add_parser("sql")
    sp.add_argument(
        "--auth-manifest",
        default=None,
        help="signed stage-2 authorization manifest CSV "
             "(default: manifests/stage2-test-authorization-manifest.csv)",
    )
    vp = sub.add_parser("verify")
    vp.add_argument("--auth-manifest", default=None)
    args = p.parse_args()

    if args.command == "manifests":
        cmd_manifests(args.snapshot_dir, MANIFEST_DIR)
    elif args.command == "sql":
        auth = (
            Path(args.auth_manifest)
            if args.auth_manifest
            else MANIFEST_DIR / "stage2-test-authorization-manifest.csv"
        )
        cmd_sql(auth, args.snapshot_dir)
    elif args.command == "verify":
        cmd_verify(args.snapshot_dir, args.auth_manifest)


if __name__ == "__main__":
    main()
