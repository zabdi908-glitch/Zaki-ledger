#!/usr/bin/env python3
"""Deterministic repair-package builder — Zaki Ledger 013-pre historical repair.

Builds the hash-locked manifests and the split Stage-1/Stage-2 repair SQL from
the accepted production snapshot inventories captured 2026-08-16 (see
docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md §2–§9).

This script is READ-ONLY with respect to any database: it consumes the
snapshot JSONs under --snapshot-dir (only for regeneration/verification) and
the committed manifests under manifests/, and never opens a network
connection.

AUTHORIZATION MODEL (hardened):

  The accountant's stage-2 authorization is a DECISION OVER an immutable
  committed basis. The committed basis
  (manifests/stage2-immutable-basis.json) fixes, for each of the 102
  decision-permitted candidate rows and the 87 survivor-guard rows: match id,
  QB/bank/statement ids, tenant/user/client/book ids, practice id, amounts,
  dates, description fingerprints, approval stamps, class, reason, action,
  evidence summary, the PERMITTED survivor set, and the PERMITTED decision
  set. The authorization manifest contains ONLY decision fields
  (match_id, decision, accountant identity, confirmation timestamp, optional
  note). The builder validates every decision against the committed basis:

    - decision match_id must exist in the basis and be decision-permitted;
    - decision must be an element of the row's permitted decision set;
    - the surviving row for an authorized retirement comes from the basis
      (permitted survivor set), never from the manifest;
    - reason, action, class, QB/bank/statement ids, fingerprints, and all
      accounting identity come from the basis, never from the manifest;
    - no more than one member of an R6 pair may retire;
    - every decision's confirmation_timestamp must not predate the recorded
      stage-1 execution (the stage-1 checkpoint precedes stage-2
      authorization);
    - unknown manifest keys (including any attempt to smuggle legacy
      identity/reason/survivor/action/class columns) are rejected.

  Counts are never sufficient.

ENVIRONMENT-MODE BARRIER:

  Every generated artifact carries environment_mode = REHEARSAL or
  PRODUCTION, bound into the SQL (a hard identity gate executed inside the
  repair transaction), the audit evidence, and the artifact identity hash.
  REHEARSAL artifacts execute only against the scratch restore database
  `repair_drill`; PRODUCTION artifacts execute only against database
  `postgres` on PostgreSQL 17 with the session GUC
  zaki.repair_project_ref = fqvekbzwghjurkcawpgg. Rehearsal manifests are
  refused by PRODUCTION builds, and vice versa.

STAGE-2 FREEZE:

  Production (and rehearsal) execution uses the `freeze` subcommand: it
  builds the exact SQL artifact from the committed basis + the signed
  authorization manifest + the stage-1 execution RECEIPT EXPORT (the
  immutable database-side receipt row written by stage 1 inside its own
  transaction is the authorization root — the export is operator evidence
  only; the stage-2 artifact itself revalidates the actual DB row and
  recomputes the exact stage-1 state before any stage-2 work), writes it to
  a unique immutable path (overwrite refused), records its SHA-256 and
  identity in a freeze record, and the runner executes only a hash-verified
  frozen artifact. `verify --artifact <freeze.json>` independently
  re-proves the frozen bytes before execution. Every artifact binds the
  stable EXECUTION_PACKAGE_SHA256 (content-based package identity — see
  EXECUTION_PACKAGE.md; `package-sha` prints it), never the git HEAD, so
  evidence-only commits cannot invalidate the package.

Accepted classification (validated on every build):

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

  manifests  Write the committed manifests from the snapshot: duplicate
             endpoints, stage-1 targets+guards, the stage-2 immutable basis
             and candidate inventory, the R6 review rows, the test-decisions
             list, the authorization-manifest template, and the REHEARSAL
             test authorization manifest, plus manifest-identities.json.
  package-sha  Print the stable EXECUTION_PACKAGE_SHA256 and the per-file
             digest lines it is computed from (sha256sum format over the
             documented sorted package file list — see EXECUTION_PACKAGE.md).
  sql        REHEARSAL-ONLY regeneration of the committed 14a/14b working
             copies. --auth-manifest is REQUIRED (no default — missing
             authorization input fails closed). The stage-2 working copy is
             a deterministic pre-execution staging artifact (empty stage-1
             receipt-sha placeholder); per-run frozen artifacts are built
             with `freeze` + `--stage1-receipt`.
  freeze     Build an immutable execution artifact (stage 1 or stage 2) +
             freeze record. Stage 2 requires --auth-manifest,
             --stage1-artifact, and --stage1-receipt (the stage-1 execution
             receipt export; every derivable field is independently
             revalidated against the committed manifests and the
             byte-identical frozen stage-1 artifact — the ACTUAL
             authorization is the database-side receipt row, revalidated by
             the stage-2 artifact at execution). PRODUCTION mode requires
             --project-ref fqvekbzwghjurkcawpgg. Overwrite is refused.
  verify     Package consistency: manifest hashes, snapshot provenance,
             classification re-derivation, committed SQL byte-identity with
             regeneration (--auth-manifest REQUIRED for the stage-2 binding).
             verify --artifact <freeze.json> INDEPENDENTLY re-proves a
             frozen artifact by REGENERATING the expected bytes from the
             committed basis + authorization inputs into a temporary
             location and requiring byte-identity + SHA-256 match with the
             freeze record (stage-2 records additionally require
             --stage1-artifact, --auth-manifest, --stage1-receipt).
  rehearsal-manifest  Generate a REHEARSAL authorization manifest for the
             rehearsal chain from the committed test-decisions list, stamped
             with a fresh confirmation timestamp (post-stage-1 by
             construction).

Usage:

  python3 bin/build_repair_package.py manifests --snapshot-dir /tmp/zaki-repair-design
  python3 bin/build_repair_package.py package-sha
  python3 bin/build_repair_package.py sql --auth-manifest manifests/stage2-rehearsal-authorization-manifest.json
  python3 bin/build_repair_package.py verify --auth-manifest manifests/stage2-rehearsal-authorization-manifest.json
  python3 bin/build_repair_package.py freeze --stage 1 --environment-mode REHEARSAL --out-dir artifacts
  python3 bin/build_repair_package.py freeze --stage 2 --environment-mode PRODUCTION \
      --auth-manifest <signed.json> --stage1-artifact <frozen-14a.sql> \
      --stage1-receipt <receipt-export.json> --project-ref fqvekbzwghjurkcawpgg \
      --out-dir <window-artifacts>
  python3 bin/build_repair_package.py verify --artifact artifacts/freeze-14a-*.json
  python3 bin/build_repair_package.py verify --artifact artifacts/freeze-14b-*.json \
      --stage1-artifact artifacts/14a-*.sql --auth-manifest <signed.json> \
      --stage1-receipt <receipt-export.json>
"""

import argparse
import csv
import datetime
import hashlib
import json
import re
import sys
import tempfile
import unicodedata
from collections import defaultdict
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_DIR = ROOT / "manifests"
SQL_STAGE1 = ROOT / "14a-stage1-unapproved-repair.sql"
SQL_STAGE2 = ROOT / "14b-stage2-approved-repair.sql"
PREP_SQL = ROOT / "13-repair-prep.sql"

BASIS_PATH = MANIFEST_DIR / "stage2-immutable-basis.json"
TEST_DECISIONS_PATH = MANIFEST_DIR / "stage2-test-decisions.json"
AUTH_TEMPLATE_PATH = MANIFEST_DIR / "stage2-authorization-manifest-template.json"
REHEARSAL_MANIFEST_PATH = (
    MANIFEST_DIR / "stage2-rehearsal-authorization-manifest.json"
)

# ---------------------------------------------------------------------------
# Fixed package constants
# ---------------------------------------------------------------------------

# Fixed per-package-release operation ids. Semantic idempotency is keyed on
# these: a re-run proves its exact targets already carry THIS operation id;
# rows superseded by any other operation id abort the run. The ids are
# IDENTICAL for rehearsal and production so a rehearsal run proves the exact
# production semantics; the environment mode is bound into the artifact
# identity and the audit evidence instead (see ARTIFACT identity below).
STAGE1_OPERATION_ID = "0a1a1a01-4a5e-4b1a-8c01-013000000001"
STAGE2_OPERATION_ID = "0a1a1a01-4a5e-4b1a-8c01-013000000002"

# Shared advisory lock key ('ZAKI'). Both stages serialize on it, so the two
# stages also serialize against each other.
ADVISORY_LOCK = "0x5A414B49"

# ---------------------------------------------------------------------------
# Execution-side finite timeouts (reviewed values, not copied blindly — see
# execution-window.md §1.4 for the full analysis). Both are transaction-local
# (SET LOCAL), so a timeout aborts the whole repair transaction (rollback,
# zero partial changes) and the runbook treats it as STOP, never as retry.
# ---------------------------------------------------------------------------
# lock_timeout: against a frozen, verified-quiescent app every ACCESS
# EXCLUSIVE acquisition is immediate (rehearsal-verified: <1s total). 30s is
# ~10x+ headroom for a stray short writer and still strictly finite: a
# session holding a conflicting lock longer than 30s means an unexcluded
# writer is active — STOP. SQLSTATE on timeout: 55P03 (lock_not_available).
LOCK_TIMEOUT = "30s"
# statement_timeout: every repair statement is millisecond-scale on the
# snapshot population (573 matches / 409 audit rows; rehearsal-verified).
# 120s is ~10^3-10^4x headroom and still finite: a statement exceeding it
# means something pathological (bloat, trigger loop, index corruption) —
# STOP. SQLSTATE on timeout: 57014 (query_canceled).
STATEMENT_TIMEOUT = "120s"

# Artifact-sha session GUC. The execution driver verifies the artifact
# SHA-256 against its freeze record, then passes it in via PGOPTIONS; the
# repair transaction records it verbatim into the immutable audit evidence.
# An artifact cannot know its own file hash at build time (self-reference),
# so the driver-mediated GUC is the binding mechanism: the DB-side no-op
# revalidation compares the stored evidence (first run's sha) against the
# expected evidence built from the current GUC (this run's sha), so a rerun
# only verifies as a no-op when the exact frozen artifact sha is supplied.
REPAIR_ARTIFACT_SHA_GUC = "zaki.repair_artifact_sha256"

# Execution-package sha session GUC. EXECUTION_PACKAGE_SHA256 (below) is a
# stable, content-based identity of the production-relevant package files —
# unlike the git HEAD, it does NOT change when an evidence commit is added
# on top. The value is known at build time (the package file list excludes
# the generated artifacts), so every artifact embeds it as a literal AND
# requires the driver to pass the identical value via PGOPTIONS; the
# DB-side stage-1 receipt, the audit evidence, and the freeze records bind
# it. Git commits are used separately: P = execution-package commit, E =
# evidence-only descendant proving P (recorded in the evidence, never bound
# into artifact bytes).
REPAIR_PACKAGE_SHA_GUC = "zaki.repair_package_sha256"

# ---------------------------------------------------------------------------
# EXECUTION_PACKAGE_SHA256 — the stable package identity (deterministic,
# content-based). sha256 over the concatenation of sha256sum-format lines
#   "<file_sha256>  <relpath>\n"
# for the sorted file list below (relpaths are package-relative; the 013
# migration lives one level up and is referenced as `../migrations/…`).
# Exactly this list and ordering are documented in EXECUTION_PACKAGE.md.
#
# Included: everything production-relevant — migration 013, repair prep,
# stage-1 generator inputs (manifests), stage-2 builder + its tests
# (validation/locking logic), the immutable candidate basis + authorization
# template/test manifests, and the production repair runbook.
# Excluded (narrative/evidence/regeneration outputs, documented in
# EXECUTION_PACKAGE.md): rehearsal/ tooling, extract/ read-only queries,
# artifacts/ (generated per-run outputs), README/reports/EVIDENCE, and the
# generated SQL working copies — none of them is a production execution
# input. No excluded file participates in artifact bytes.
# ---------------------------------------------------------------------------
EXECUTION_PACKAGE_FILES = [
    "../migrations/013_reconciliation_claim_hardening.sql",
    "13-repair-prep.sql",
    "bin/build_repair_package.py",
    "bin/test_builder_binding.py",
    "execution-window.md",
    "manifests/duplicate-endpoints.csv",
    "manifests/r6-review.csv",
    "manifests/stage1-unapproved-targets.csv",
    "manifests/stage2-approved-candidates.csv",
    "manifests/stage2-authorization-manifest-template.json",
    "manifests/stage2-immutable-basis.json",
    "manifests/stage2-rehearsal-authorization-manifest.json",
    "manifests/stage2-test-decisions.json",
]


def execution_package_sha256():
    """Stable content-based package identity (sha256sum-style digest of the
    sorted documented file list). Deterministic: depends only on file
    content, never on git HEAD or file timestamps."""
    lines = []
    for rel in EXECUTION_PACKAGE_FILES:
        p = ROOT / rel
        if not p.is_file():
            raise SystemExit(
                f"execution-package file missing: {rel} — the package "
                f"identity is incomplete"
            )
        lines.append(f"{sha256_file(p)}  {rel}\n")
    return sha256_text("".join(lines))

STAGE1_ACTOR = "zaki-repair-stage1-system"
AUDIT_ACTION = "match_repair_superseded"

# Environment-mode barrier (mechanical, not a warning).
MODES = ("REHEARSAL", "PRODUCTION")
PROD_PROJECT_REF = "fqvekbzwghjurkcawpgg"
REHEARSAL_DB = "repair_drill"
PROD_DB = "postgres"
PROD_SERVER_VERSION_PREFIX = "17"
PROJECT_REF_GUC = "zaki.repair_project_ref"
MODE_GATE_REHEARSAL_MARK = "REHEARSAL artifact refuses database identity"
MODE_GATE_PRODUCTION_MARK = (
    "PRODUCTION artifact requires the exact production database identity"
)

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
    "stage1_guards": 101,          # 14 R2 approved survivors + 87 R3 exact survivors
    "stage2_candidates": 102,      # decision-permitted basis rows: 93 R3 + 1 R5 + 8 R6 pair members
    "stage2_retireable": 98,       # full-repair retirement population (93 R3 + 1 R5 + 4 R6)
    "stage2_guards": 87,           # R3 exact survivors (R6 keep rows are candidates now)
    "stage2_basis_rows": 189,      # 102 candidates + 87 guards
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

PERMITTED_DECISIONS = ["RETIRE", "DO_NOT_REPAIR"]

# Fixed rehearsal constants for the committed test authorization manifest.
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


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_hex64(v):
    return isinstance(v, str) and bool(re.fullmatch(r"[0-9a-f]{64}", v))


def fmt_amount(v):
    return f"{float(v):.2f}"


def fmt_confidence(v):
    return f"{float(v):.4f}".rstrip("0").rstrip(".")


def parse_iso_ts(text):
    """ISO-8601 timestamptz with possible 'Z'; returns datetime (aware)."""
    if text is None:
        raise SystemExit("missing ISO timestamp")
    t = str(text).strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    return datetime.datetime.fromisoformat(t)


def artifact_identity_stage1(mode, stage1_manifest_sha, basis_sha,
                             execution_package_sha, project_ref):
    return sha256_text(
        "|".join([
            STAGE1_OPERATION_ID,
            mode,
            stage1_manifest_sha,
            basis_sha,
            execution_package_sha,
            project_ref or "-",
        ])
    )


def artifact_identity_stage2(mode, stage1_manifest_sha, basis_sha,
                             auth_manifest_sha, stage1_artifact_sha,
                             receipt_sha, execution_package_sha, project_ref):
    return sha256_text(
        "|".join([
            STAGE1_OPERATION_ID,
            STAGE2_OPERATION_ID,
            mode,
            stage1_manifest_sha,
            basis_sha,
            auth_manifest_sha,
            stage1_artifact_sha,
            receipt_sha,
            execution_package_sha,
            project_ref or "-",
        ])
    )


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
            f"identical-evidence approved pair on QB '{qb_desc}'; accountant "
            f"selects which side (if any) retires; permitted survivor for this "
            f"row is {survivor_id}"
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
    """Returns (stage1_targets, stage1_guards, stage2_candidates,
                stage2_guards, dup_endpoints, dup_after_stage1, r6_rows).

    stage2_candidates contains the 102 decision-permitted basis rows
    (93 R3 non-exact approved + 1 R5 approved + 8 R6 pair members, BOTH
    sides of each pair); stage2_guards contains the 87 R3 exact survivors
    (never decision-permitted). Permitted survivor/decision sets are derived
    below at serialization time.
    """
    endpoint_class, by_qb, endpoints = classify(snapshot)
    audit_by_match = audit_events_by_match(snapshot)

    stage1_targets, stage1_guards = [], []
    stage2_candidates, stage2_guards = [], []
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
            # Stage 2: the one approved test row (no survivor).
            for m in sorted(app, key=lambda x: x["match_id"]):
                row = core_row(
                    m, ep, "candidate", cls, 2, None,
                    REASONS[(cls, "approved", 2)], "SUPERSEDE",
                )
                stage2_candidates.append(row)
            continue

        if cls == "R3":
            dup_after_stage1.append({
                "qb_transaction_id": qb_id,
                "resolved_by_stage1": False,
            })
            # Stage 2: every approved non-exact row; survivor = the exact row
            # (fixed by the committed basis — never manifest-editable).
            for m in sorted(
                [m for m in app if m not in exact], key=lambda x: x["match_id"]
            ):
                row = core_row(
                    m, ep, "candidate", cls, 2,
                    survivor["match_id"],
                    REASONS[(cls, "approved", 2)], "SUPERSEDE",
                )
                stage2_candidates.append(row)
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
            # BOTH pair members are decision-permitted candidates. The
            # accountant's decision selects which side (if any) retires; the
            # permitted survivor for either side is the other member, fixed
            # by the committed basis. The earliest-upload proposal is
            # recorded for the human packet only — no default executable
            # decision exists.
            row = core_row(
                keep, ep, "candidate", cls, 2,
                retire["match_id"],
                REASONS[(cls, "approved", 2)], "SUPERSEDE",
            )
            stage2_candidates.append(row)
            row = core_row(
                retire, ep, "candidate", cls, 2,
                keep["match_id"],
                REASONS[(cls, "approved", 2)], "SUPERSEDE",
            )
            stage2_candidates.append(row)

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
    stage2_candidates.sort(key=lambda r: r["match_id"])
    stage2_guards.sort(key=lambda r: r["match_id"])
    dup_endpoints.sort(key=lambda r: r["qb_transaction_id"])
    r6_rows.sort(key=lambda r: r["qb_transaction_id"])

    assert len(stage1_targets) == EXPECTED["stage1_targets"], len(stage1_targets)
    assert len(stage1_guards) == EXPECTED["stage1_guards"], len(stage1_guards)
    assert len(stage2_candidates) == EXPECTED["stage2_candidates"], len(stage2_candidates)
    assert len(stage2_guards) == EXPECTED["stage2_guards"], len(stage2_guards)
    assert len(stage2_candidates) + len(stage2_guards) == EXPECTED["stage2_basis_rows"]
    assert len(dup_endpoints) == EXPECTED["dup_endpoints"], len(dup_endpoints)
    assert sum(1 for e in dup_after_stage1 if e["resolved_by_stage1"]) == 16
    assert len(dup_after_stage1) == EXPECTED["dup_endpoints"]
    assert len(r6_rows) == 4

    # Full-repair retirement population: 93 R3 + 1 R5 + 4 R6 = 98.
    assert sum(1 for r in stage2_candidates if r["class"] != "R6") == 94
    assert EXPECTED["stage2_retireable"] == 98

    # Survivors referenced by stage-1 targets must all be guarded.
    guard_ids = {r["match_id"] for r in stage1_guards}
    for r in stage1_targets:
        if r["intended_survivor_match_id"]:
            assert r["intended_survivor_match_id"] in guard_ids

    # R6 pair members reference each other as permitted survivors.
    candidate_ids = {r["match_id"] for r in stage2_candidates}
    for r in stage2_candidates:
        if r["class"] == "R6":
            assert r["intended_survivor_match_id"] in candidate_ids
            assert r["intended_survivor_match_id"] != r["match_id"]

    return (
        stage1_targets, stage1_guards, stage2_candidates, stage2_guards,
        dup_endpoints, dup_after_stage1, r6_rows,
    )


# ---------------------------------------------------------------------------
# Committed-basis assembly (the immutable authorization contract)
# ---------------------------------------------------------------------------

BASIS_ROW_KEYS = [
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
    "permitted_survivor_match_ids", "permitted_decisions",
    "evidence_summary",
]


def build_basis_rows(stage2_candidates, stage2_guards):
    """Assemble the committed basis document rows.

    Candidates carry their permitted survivor set and permitted decision
    set; guards are never decision-permitted.
    """
    rows = []
    for r in stage2_candidates:
        row = {k: r.get(k, "") for k in BASIS_ROW_KEYS}
        row["permitted_survivor_match_ids"] = (
            [r["intended_survivor_match_id"]]
            if r["intended_survivor_match_id"]
            else []
        )
        row["permitted_decisions"] = list(PERMITTED_DECISIONS)
        rows.append(row)
    for r in stage2_guards:
        row = {k: r.get(k, "") for k in BASIS_ROW_KEYS}
        row["permitted_survivor_match_ids"] = []
        row["permitted_decisions"] = []
        rows.append(row)
    rows.sort(key=lambda r: (r["role"], r["match_id"]))
    return rows


def basis_document(basis_rows):
    return {
        "package": "repair-013-pre",
        "basis_schema_version": 1,
        "stage1_operation_id": STAGE1_OPERATION_ID,
        "stage2_operation_id": STAGE2_OPERATION_ID,
        "rows": basis_rows,
    }


def write_json(path, doc):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")


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

CANDIDATES_HEADER = CORE_HEADER + [
    "permitted_survivor_match_ids", "permitted_decisions",
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


# ---------------------------------------------------------------------------
# Authorization manifest (thin, decision-only)
# ---------------------------------------------------------------------------

MANIFEST_TOP_KEYS = {
    "package", "manifest_schema_version", "environment_mode",
    "basis_sha256", "decisions",
}
DECISION_KEYS = {
    "match_id", "decision", "accountant_identity", "confirmation_timestamp",
    "note",
}


def build_test_decisions(r6_rows, stage2_candidates):
    """The fixed REHEARSAL test choices: RETIRE the 94 fixed candidates and
    the 4 R6 retire-proposal members (earliest-upload proposal). Committed
    and hash-locked; stamped with a fresh confirmation timestamp by the
    rehearsal chain at run time."""
    by_id = {r["match_id"]: r for r in stage2_candidates}
    retire_ids = {r["retire_candidate_match_id"] for r in r6_rows}
    choices = []
    for r in stage2_candidates:
        if r["class"] != "R6" or r["match_id"] in retire_ids:
            choices.append({
                "match_id": r["match_id"],
                "decision": "RETIRE",
                "note": "REHEARSAL test choice (committed test-decisions list)",
            })
    choices.sort(key=lambda d: d["match_id"])
    assert len(choices) == EXPECTED["stage2_retireable"], len(choices)
    return choices


def auth_manifest_document(basis_sha, mode, decisions):
    return {
        "package": "repair-013-pre",
        "manifest_schema_version": 1,
        "environment_mode": mode,
        "basis_sha256": basis_sha,
        "decisions": decisions,
    }


def validate_auth_manifest(path, mode, receipt=None):
    """Validate the thin authorization manifest against the COMMITTED basis.

    Returns (decisions, manifest_sha). Raises SystemExit on any deviation —
    the manifest is a decision over the basis, never a redefinition of it.
    `receipt` (a load_stage1_receipt result) enforces the post-stage-1
    ordering: every confirmation timestamp must follow the stage-1 receipt's
    database-recorded executed_at.
    """
    manifest_path = Path(path)
    try:
        data = json.load(open(manifest_path, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"authorization manifest unreadable: {e}")

    if not isinstance(data, dict):
        raise SystemExit("authorization manifest must be a JSON object")
    unknown = set(data.keys()) - MANIFEST_TOP_KEYS
    if unknown:
        raise SystemExit(
            f"authorization manifest contains unknown top-level keys "
            f"{sorted(unknown)} — accounting identity cannot be redefined "
            f"by the manifest"
        )
    for key in MANIFEST_TOP_KEYS:
        if key not in data:
            raise SystemExit(f"authorization manifest missing key '{key}'")

    if data["environment_mode"] != mode:
        raise SystemExit(
            f"authorization manifest mode {data['environment_mode']!r} does "
            f"not match the requested mode {mode!r}"
        )
    if data["manifest_schema_version"] != 1:
        raise SystemExit("unsupported authorization manifest schema version")

    basis = load_committed_basis()
    basis_sha = sha256_file(BASIS_PATH)
    if data["basis_sha256"] != basis_sha:
        raise SystemExit(
            f"authorization manifest basis_sha256 {data['basis_sha256']} "
            f"does not match the committed basis {basis_sha} — the manifest "
            f"was built against a different accounting identity"
        )

    basis_by_id = {r["match_id"]: r for r in basis["rows"]}
    decisions = data.get("decisions")
    if not isinstance(decisions, list):
        raise SystemExit("manifest 'decisions' must be a list")

    seen = set()
    n_exec = 0
    for i, d in enumerate(decisions):
        if not isinstance(d, dict):
            raise SystemExit(f"decision {i} is not an object")
        unknown = set(d.keys()) - DECISION_KEYS
        if unknown:
            raise SystemExit(
                f"decision for {d.get('match_id', i)} contains unknown keys "
                f"{sorted(unknown)} — identity/reason/action/class/survivor "
                f"columns cannot be redefined by the authorization manifest"
            )
        match_id = d.get("match_id")
        if not match_id or match_id in seen:
            raise SystemExit(f"decision {i}: missing or duplicate match_id")
        seen.add(match_id)
        row = basis_by_id.get(match_id)
        if row is None:
            raise SystemExit(
                f"decision references match_id {match_id} which is not part "
                f"of the committed stage-2 basis (arbitrary target "
                f"replacement rejected)"
            )
        if row["role"] != "candidate":
            raise SystemExit(
                f"match_id {match_id} is a committed survivor guard — "
                f"candidate/survivor reversal is rejected"
            )
        decision = d.get("decision")
        if decision not in row["permitted_decisions"]:
            raise SystemExit(
                f"decision {decision!r} for {match_id} is outside the "
                f"permitted decision set {row['permitted_decisions']} of the "
                f"committed basis"
            )
        identity = (d.get("accountant_identity") or "").strip()
        ts = (d.get("confirmation_timestamp") or "").strip()
        if not identity or not ts:
            raise SystemExit(
                f"decision for {match_id} lacks accountant_identity or "
                f"confirmation_timestamp"
            )
        try:
            parsed_ts = parse_iso_ts(ts)
        except ValueError as e:
            raise SystemExit(
                f"decision for {match_id} has an invalid "
                f"confirmation_timestamp {ts!r}: {e}"
            )
        if receipt is not None:
            if parsed_ts < receipt["executed_at"]:
                raise SystemExit(
                    f"decision for {match_id} has confirmation_timestamp "
                    f"{ts} earlier than the recorded stage-1 execution "
                    f"{receipt['executed_at_iso']} — stage-2 authorization "
                    f"must follow the stage-1 checkpoint"
                )
        if decision == "RETIRE":
            n_exec += 1

    # R6 pairs: at most one member may retire.
    r6_retired = defaultdict(list)
    for d in decisions:
        if d.get("decision") != "RETIRE":
            continue
        row = basis_by_id[d["match_id"]]
        if row["class"] == "R6":
            r6_retired[row["qb_transaction_id"]].append(d["match_id"])
    for qb_id, ids in r6_retired.items():
        if len(ids) > 1:
            raise SystemExit(
                f"R6 endpoint {qb_id} authorizes BOTH pair members for "
                f"retirement ({', '.join(ids)}) — the survivor must remain"
            )

    # Authorized retirees reference only their basis survivor (which must be
    # guarded: present in the basis rows).
    for d in decisions:
        if d.get("decision") != "RETIRE":
            continue
        row = basis_by_id[d["match_id"]]
        survivor = row.get("intended_survivor_match_id") or ""
        permitted = row.get("permitted_survivor_match_ids") or []
        if survivor and survivor not in permitted:
            raise SystemExit(
                f"internal basis inconsistency: survivor {survivor} for "
                f"{d['match_id']} not in its permitted survivor set"
            )
        if survivor and survivor not in basis_by_id:
            raise SystemExit(
                f"basis survivor {survivor} for {d['match_id']} is not part "
                f"of the committed basis"
            )

    manifest_sha = sha256_file(manifest_path)
    return decisions, manifest_sha


def load_committed_basis():
    try:
        doc = json.load(open(BASIS_PATH, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"committed basis unreadable: {e}")
    if doc.get("basis_schema_version") != 1:
        raise SystemExit("unsupported committed basis schema version")
    rows = doc.get("rows")
    if not isinstance(rows, list) or len(rows) != EXPECTED["stage2_basis_rows"]:
        raise SystemExit(
            f"committed basis row count {len(rows) if isinstance(rows, list) else 'n/a'} "
            f"!= {EXPECTED['stage2_basis_rows']}"
        )
    return doc


def load_committed_package():
    """Load everything the SQL emitter needs from COMMITTED files only."""
    s1 = read_csv(MANIFEST_DIR / "stage1-unapproved-targets.csv")
    s1t = [r for r in s1 if r["role"] == "target"]
    s1g = [r for r in s1 if r["role"] == "survivor_guard"]
    if len(s1t) != EXPECTED["stage1_targets"] or len(s1g) != EXPECTED["stage1_guards"]:
        raise SystemExit("committed stage-1 manifest has unexpected role counts")

    dup_eps = read_csv(MANIFEST_DIR / "duplicate-endpoints.csv")
    if len(dup_eps) != EXPECTED["dup_endpoints"]:
        raise SystemExit("committed duplicate-endpoint inventory has unexpected size")
    dup_after_s1 = [
        {
            "qb_transaction_id": r["qb_transaction_id"],
            "resolved_by_stage1": r["class"] in ("R2", "R5"),
        }
        for r in dup_eps
    ]
    if sum(1 for e in dup_after_s1 if e["resolved_by_stage1"]) != 16:
        raise SystemExit("committed duplicate-endpoint inventory resolution map drifted")

    basis = load_committed_basis()
    s2c = [r for r in basis["rows"] if r["role"] == "candidate"]
    s2g = [r for r in basis["rows"] if r["role"] == "survivor_guard"]
    if len(s2c) != EXPECTED["stage2_candidates"] or len(s2g) != EXPECTED["stage2_guards"]:
        raise SystemExit("committed basis has unexpected role counts")
    # SQL temp-table key names: candidates carry their committed basis
    # survivor under `survivor_id`.
    for r in s2c:
        r["survivor_id"] = r.get("intended_survivor_match_id") or ""

    stage1_manifest_sha = sha256_file(MANIFEST_DIR / "stage1-unapproved-targets.csv")
    basis_sha = sha256_file(BASIS_PATH)
    return {
        "s1t": s1t, "s1g": s1g, "dup_eps": dup_eps,
        "dup_after_s1": dup_after_s1, "s2c": s2c, "s2g": s2g,
        "stage1_manifest_sha": stage1_manifest_sha, "basis_sha": basis_sha,
        "basis_rows": basis["rows"],
    }


# ---------------------------------------------------------------------------
# Stage-1 execution receipt (database-side authorization root). Stage 1
# writes an immutable receipt row INSIDE ITS OWN TRANSACTION (same
# transaction as the 154 supersessions and audit rows), recording
# database-derived digests of the exact state it produced. Stage 2 validates
# that actual database row AND independently recomputes the exact stage-1
# state before any stage-2 work. A caller-created export is OPERATOR
# EVIDENCE ONLY — never the authorization root (Codex finding 1).
#
# Two digest families:
#  - DERIVABLE digests (target digest, survivor-mapping digest) are computed
#    in SQL over the manifest temp table and are also computable offline
#    from the committed stage-1 manifest — the builder revalidates them
#    byte-exactly (stage1_target_digest / stage1_survivor_mapping_digest).
#  - SQL-AUTHORITY digests (audit digest, postcondition digest) are computed
#    in SQL over LIVE rows (runtime timestamps included) with PG-specific
#    jsonb::text rendering; they are recomputed by the stage-2 artifact in
#    SQL from live state and compared to the receipt's recorded values. The
#    builder checks their format only and NEVER recomputes them (PG jsonb
#    rendering is not reproducible in Python, and the DB is the authority).
# ---------------------------------------------------------------------------

def stage1_target_digest(s1t):
    """sha256 over the exact 154 stage-1 target ids, comma-joined in
    match_id order (identical to the SQL-side string_agg)."""
    return sha256_text(",".join(sorted(r["match_id"] for r in s1t)))


def stage1_survivor_mapping_digest(s1t):
    """sha256 over 'match_id:survivor_id' pairs (empty for no survivor),
    comma-joined in match_id order (identical to the SQL-side string_agg)."""
    return sha256_text(",".join(
        f"{r['match_id']}:{r['intended_survivor_match_id'] or ''}"
        for r in sorted(s1t, key=lambda r: r["match_id"])
    ))


def expected_stage1_sql(mode, pkg, project_ref=None):
    """Deterministic stage-1 regeneration from the committed package files."""
    package_sha = execution_package_sha256()
    identity = artifact_identity_stage1(
        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"], package_sha,
        project_ref,
    )
    return stage1_sql(
        pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
        pkg["stage1_manifest_sha"], pkg["basis_sha"], mode, project_ref,
        identity, package_sha,
    )


def load_stage1_receipt(path, mode, stage1_artifact_path):
    """Independently revalidate every DERIVABLE field of a stage-1 receipt
    export against the committed manifests and the supplied frozen stage-1
    artifact. The receipt's canonical hash (receipt_sha256) and its
    audit/postcondition digests are DATABASE-SIDE authorities computed
    inside the stage-1 transaction over live state; the builder checks their
    format only and never recomputes them (PG-specific rendering).

    A caller-fabricated export therefore only satisfies this check if its
    derivable fields genuinely match the committed package — and even then
    it is OPERATOR EVIDENCE ONLY, never the authorization root: stage-2
    execution validates the ACTUAL database-side receipt row and
    independently recomputes the exact stage-1 state before any stage-2
    work (Codex finding 1)."""
    receipt_path = Path(path)
    try:
        receipt = json.load(open(receipt_path, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"stage-1 receipt export unreadable: {e}")

    pkg = load_committed_package()
    project_ref = PROD_PROJECT_REF if mode == "PRODUCTION" else None
    expected_db = PROD_DB if mode == "PRODUCTION" else REHEARSAL_DB

    def reject(msg):
        raise SystemExit(f"stage-1 receipt export rejected: {msg}")

    if not isinstance(receipt, dict):
        reject("receipt must be a JSON object")
    for key in ("receipt_sha256", "execution_package_sha256",
                "artifact_sha256", "operation_id", "environment_mode",
                "target_manifest_sha256", "target_digest_sha256",
                "survivor_mapping_digest_sha256", "audit_digest_sha256",
                "postcondition_digest_sha256", "executed_at", "db_identity"):
        if key not in receipt:
            reject(f"missing field '{key}' — caller-created stage-1 proof "
                   f"JSON is not accepted; only a database receipt export")
    if not _is_hex64(receipt.get("receipt_sha256")):
        reject("receipt_sha256 is not a 64-hex sha256")
    if receipt.get("execution_package_sha256") != execution_package_sha256():
        reject(
            "execution_package_sha256 does not match the checked-out "
            "package's stable EXECUTION_PACKAGE_SHA256 — the receipt was "
            "produced by a different package state"
        )
    if receipt.get("operation_id") != STAGE1_OPERATION_ID:
        reject("receipt records a different stage-1 operation id")
    if receipt.get("environment_mode") != mode:
        reject(
            f"receipt environment_mode {receipt.get('environment_mode')!r} "
            f"does not match the requested mode {mode!r}"
        )
    if (receipt.get("project_ref") or None) != project_ref:
        reject(
            f"receipt project_ref does not match the {mode} project "
            f"identity {project_ref!r}"
        )
    if receipt.get("target_manifest_sha256") != pkg["stage1_manifest_sha"]:
        reject("receipt binds a different stage-1 manifest than the committed one")
    if receipt.get("db_identity") != expected_db:
        reject(
            f"receipt db_identity {receipt.get('db_identity')!r} is not "
            f"the {mode} database identity {expected_db!r}"
        )

    # The frozen artifact must hash to the recorded sha AND be byte-identical
    # to the deterministic regeneration — a receipt cannot attest a foreign
    # or edited artifact.
    artifact_sha = sha256_file(stage1_artifact_path)
    if receipt.get("artifact_sha256") != artifact_sha:
        reject(
            "receipt artifact_sha256 does not match the supplied "
            "--stage1-artifact file — the receipt attests a different "
            "artifact"
        )
    content = Path(stage1_artifact_path).read_text(encoding="utf-8")
    if content != expected_stage1_sql(mode, pkg, project_ref):
        reject(
            "supplied stage-1 artifact is not byte-identical to the "
            "package's deterministic stage-1 build"
        )

    # Derivable digests — recomputed from the committed manifest, never
    # trusted from the export.
    if receipt.get("target_digest_sha256") != stage1_target_digest(pkg["s1t"]):
        reject(
            "receipt target_digest_sha256 does not match the digest of the "
            "exact committed 154 stage-1 targets"
        )
    if receipt.get("survivor_mapping_digest_sha256") != stage1_survivor_mapping_digest(
            pkg["s1t"]):
        reject(
            "receipt survivor_mapping_digest_sha256 does not match the "
            "digest of the exact committed stage-1 survivor assignments"
        )
    for key in ("audit_digest_sha256", "postcondition_digest_sha256"):
        if not _is_hex64(receipt.get(key)):
            reject(
                f"{key} is not a 64-hex sha256 (database-side digest — "
                f"validated by the stage-2 artifact against live state, "
                f"never recomputed here)"
            )

    try:
        executed_at = parse_iso_ts(receipt.get("executed_at"))
    except (SystemExit, ValueError):
        reject("receipt has no valid executed_at")

    return {
        "record": receipt,
        "executed_at": executed_at,
        "executed_at_iso": str(receipt.get("executed_at")),
        "artifact_sha256": artifact_sha,
        "receipt_sha256": receipt.get("receipt_sha256"),
        "target_digest_sha256": receipt.get("target_digest_sha256"),
        "survivor_mapping_digest_sha256": receipt.get("survivor_mapping_digest_sha256"),
        "audit_digest_sha256": receipt.get("audit_digest_sha256"),
        "postcondition_digest_sha256": receipt.get("postcondition_digest_sha256"),
    }


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
    return sql_values(CORE_HEADER, rows)


def candidate_row_values(rows):
    cols = ["match_id", "class", "reason", "approved_at", "approved_by",
            "confidence", "survivor_id"]
    return sql_values(cols, rows)


def endpoint_values(rows):
    cols = ["qb_transaction_id", "resolved_by_stage1"]
    return sql_values(cols, rows)


def qb_id_values(rows):
    return sql_values(["qb_transaction_id"], rows)


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


# Evidence JSON shapes shared by the apply INSERTs and the exact no-op
# verification. Both derive from the same temp-manifest columns, so the
# applied rows and the re-verified rows are identical by construction.
def _previous_state_sql():
    return (
        "jsonb_build_object(\n"
        "       'approved_at', t.approved_at,\n"
        "       'approved_by', t.approved_by,\n"
        "       'confidence', t.confidence,\n"
        "       'matched_by', t.matched_by,\n"
        "       'flagged_level', t.flagged_level,\n"
        "       'superseded_at', NULL,\n"
        "       'superseded_by_match_id', NULL,\n"
        "       'supersede_reason', NULL,\n"
        "       'supersede_operation_id', NULL)"
    )


def _resulting_state_sql(stage_op):
    return (
        "jsonb_build_object(\n"
        "       'approved_at', t.approved_at,\n"
        "       'approved_by', t.approved_by,\n"
        "       'confidence', t.confidence,\n"
        "       'matched_by', t.matched_by,\n"
        "       'flagged_level', t.flagged_level,\n"
        "       'superseded_at', m.superseded_at,\n"
        "       'superseded_by_match_id', t.survivor_id,\n"
        "       'supersede_reason', t.reason,\n"
        f"       'supersede_operation_id', '{stage_op}')"
    )


def _artifact_sha_sql(literal=None):
    """The audit-evidence artifact sha. For the stage-1 artifact's OWN
    evidence and the stage-2 artifact's own evidence the value comes from
    the execution-driver GUC (the artifact cannot know its own file hash at
    build time — self-reference); for the stage-1 evidence EXPECTED by the
    stage-2 artifact the stage-1 artifact sha is a build-time literal (the
    stage-2 build binds the exact stage-1 artifact it sequences on)."""
    if literal:
        return f"'{literal}'"
    return f"current_setting('{REPAIR_ARTIFACT_SHA_GUC}', true)"


def _evidence_s1_sql(stage1_manifest_sha, basis_sha, mode, artifact_identity,
                     execution_package_sha, artifact_sha_literal=None):
    return (
        "jsonb_build_object(\n"
        "       'stage', '1',\n"
        "       'class', t.class,\n"
        "       'reason', t.reason,\n"
        "       'old_match_id', t.match_id,\n"
        "       'survivor_match_id', t.survivor_id,\n"
        "       'previous_approved_at', t.approved_at,\n"
        "       'previous_approved_by', t.approved_by,\n"
        "       'previous_confidence', t.confidence,\n"
        f"       'stage1_manifest_sha256', '{stage1_manifest_sha}',\n"
        f"       'stage2_basis_sha256', '{basis_sha}',\n"
        f"       'execution_package_sha256', '{execution_package_sha}',\n"
        f"       'environment_mode', '{mode}',\n"
        f"       'artifact_identity', '{artifact_identity}',\n"
        f"       'artifact_sha256', {_artifact_sha_sql(artifact_sha_literal)})"
    )


def _evidence_s2_sql(auth_manifest_sha, basis_sha, stage1_artifact_sha,
                     receipt_sha, execution_package_sha, mode,
                     artifact_identity):
    return (
        "jsonb_build_object(\n"
        "       'stage', '2',\n"
        "       'class', t.class,\n"
        "       'reason', t.reason,\n"
        "       'old_match_id', t.match_id,\n"
        "       'survivor_match_id', t.survivor_id,\n"
        "       'previous_approved_at', t.approved_at,\n"
        "       'previous_approved_by', t.approved_by,\n"
        "       'previous_confidence', t.confidence,\n"
        "       'accountant_decision', t.accountant_decision,\n"
        "       'accountant_identity', t.accountant_identity,\n"
        "       'confirmation_timestamp', t.confirmation_timestamp,\n"
        "       'authorization_status', t.authorization_status,\n"
        "       'accountant_note', t.accountant_note,\n"
        f"       'stage1_artifact_sha256', '{stage1_artifact_sha}',\n"
        f"       'stage1_receipt_sha256', '{receipt_sha}',\n"
        f"       'stage2_basis_sha256', '{basis_sha}',\n"
        f"       'authorization_manifest_sha256', '{auth_manifest_sha}',\n"
        f"       'execution_package_sha256', '{execution_package_sha}',\n"
        f"       'environment_mode', '{mode}',\n"
        f"       'artifact_identity', '{artifact_identity}',\n"
        f"       'artifact_sha256', {_artifact_sha_sql()})"
    )


# Exact-evidence audit verification predicate (Phase 8). Used both by the
# dispatcher (a row with altered evidence is neither live nor done — the run
# aborts as partial state) and by the postconditions.
def _evidence_match_s1(previous_state, resulting_state, evidence):
    return (
        f"a.action_by = '{STAGE1_ACTOR}'\n"
        "  AND a.action_at IS NOT DISTINCT FROM m.superseded_at\n"
        f"  AND a.previous_state IS NOT DISTINCT FROM {previous_state}\n"
        f"  AND a.resulting_state IS NOT DISTINCT FROM {resulting_state}\n"
        f"  AND a.evidence IS NOT DISTINCT FROM {evidence}"
    )


def _evidence_match_s2(previous_state, resulting_state, evidence):
    return (
        "a.action_by IS NOT DISTINCT FROM t.accountant_identity\n"
        "  AND a.action_at IS NOT DISTINCT FROM m.superseded_at\n"
        f"  AND a.previous_state IS NOT DISTINCT FROM {previous_state}\n"
        f"  AND a.resulting_state IS NOT DISTINCT FROM {resulting_state}\n"
        f"  AND a.evidence IS NOT DISTINCT FROM {evidence}"
    )


def _mode_gate_sql(mode):
    """Hard environment-mode identity gate, executed inside the repair
    transaction before any lock or write."""
    if mode == "REHEARSAL":
        return f"""-- =============================================================================
-- P0.0 Environment-mode identity gate (mechanical, not a warning)
-- =============================================================================
-- REHEARSAL artifacts execute ONLY against the scratch restore database.
-- This gate is part of the artifact; it cannot be skipped or edited without
-- changing the artifact hash.
DO $mode_gate$
DECLARE
  v_db text := current_database();
BEGIN
  IF v_db IS DISTINCT FROM '{REHEARSAL_DB}' THEN
    RAISE EXCEPTION '{MODE_GATE_REHEARSAL_MARK} % (rehearsal artifacts execute only against the scratch restore)', v_db;
  END IF;
END;
$mode_gate$;"""
    return f"""-- =============================================================================
-- P0.0 Environment-mode identity gate (mechanical, not a warning)
-- =============================================================================
-- PRODUCTION artifacts execute ONLY against the exact production database
-- identity: database 'postgres', PostgreSQL 17, and the session GUC
-- {PROJECT_REF_GUC} = '{PROD_PROJECT_REF}' (set by the execution driver,
-- e.g. PGOPTIONS="-c {PROJECT_REF_GUC}={PROD_PROJECT_REF}"). This gate is
-- part of the artifact; it cannot be skipped or edited without changing the
-- artifact hash.
DO $mode_gate$
DECLARE
  v_db  text := current_database();
  v_ver text := current_setting('server_version_num');
  v_ref text := current_setting('{PROJECT_REF_GUC}', true);
BEGIN
  IF v_db IS DISTINCT FROM '{PROD_DB}'
     OR substring(v_ver from 1 for 2) IS DISTINCT FROM '{PROD_SERVER_VERSION_PREFIX}'
     OR v_ref IS DISTINCT FROM '{PROD_PROJECT_REF}' THEN
    RAISE EXCEPTION '{MODE_GATE_PRODUCTION_MARK} (database=%, server_version_num=%, project_ref=%; expected database={PROD_DB}, server_version_num {PROD_SERVER_VERSION_PREFIX}xxxx, project_ref={PROD_PROJECT_REF})',
      v_db, v_ver, COALESCE(v_ref, '<unset>');
  END IF;
END;
$mode_gate$;"""


def _timeouts_sql():
    """Finite transaction-local timeouts, set BEFORE any potentially
    blocking lock. On timeout the enclosing transaction aborts (rollback —
    zero partial changes); the runbook treats it as STOP, never retry.
    SQLSTATEs: lock timeout 55P03 (lock_not_available), statement timeout
    57014 (query_canceled)."""
    return f"""-- ===========================================================================
-- P0a. Finite execution timeouts (transaction-local; timeout -> rollback)
-- ===========================================================================
-- lock_timeout:      {LOCK_TIMEOUT} — no indefinite wait on any lock
--                    (advisory, table, or row). SQLSTATE 55P03 on timeout.
-- statement_timeout: {STATEMENT_TIMEOUT} — bounds every single statement.
--                    SQLSTATE 57014 on timeout.
-- Both are reviewed values (execution-window.md §1.4), not arbitrary:
-- against a frozen, verified-quiescent app lock acquisition is immediate
-- (rehearsal-verified) and every repair statement is millisecond-scale.
SET LOCAL lock_timeout = '{LOCK_TIMEOUT}';
SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}';"""


def _artifact_sha_gate_sql():
    """The exact frozen artifact sha must be supplied by the execution
    driver (PGOPTIONS GUC) and recorded into the immutable audit evidence.
    A missing or malformed value aborts BEFORE any lock or write."""
    return f"""-- ===========================================================================
-- P0b. Frozen-artifact sha gate (driver-supplied, evidence-bound)
-- ===========================================================================
-- The execution driver verifies the artifact SHA-256 against its freeze
-- record and passes it via PGOPTIONS="-c {REPAIR_ARTIFACT_SHA_GUC}=<sha>".
-- The value is recorded verbatim into every repair audit row's evidence
-- (the audit-evidence immutability triggers protect it from UPDATE/DELETE).
DO $artifact_sha_gate$
DECLARE
  v_sha text := current_setting('{REPAIR_ARTIFACT_SHA_GUC}', true);
BEGIN
  IF v_sha IS NULL OR v_sha !~ '^[0-9a-f]{{64}}$' THEN
    RAISE EXCEPTION 'STOP: {REPAIR_ARTIFACT_SHA_GUC} is missing or malformed (got %) — the execution driver must verify the artifact sha256 against its freeze record and pass it via PGOPTIONS', COALESCE(v_sha, '<unset>');
  END IF;
END;
$artifact_sha_gate$;"""


def _package_sha_gate_sql(package_sha):
    """The exact EXECUTION_PACKAGE_SHA256 must be supplied by the execution
    driver (PGOPTIONS GUC) and must equal the literal embedded in the
    artifact. The value is known at build time (the package file list
    excludes generated artifacts), so the literal is authoritative and the
    driver GUC proves the operator is running this exact package state —
    independent of any later evidence-only commits (Codex finding 3)."""
    return f"""-- ===========================================================================
-- P0b2. Execution-package sha gate (driver-supplied, embedded-literal match)
-- ===========================================================================
-- The execution driver passes EXECUTION_PACKAGE_SHA256 via PGOPTIONS. The
-- artifact embeds the same value as a literal (the package identity is
-- content-based over the documented package file list — see
-- EXECUTION_PACKAGE.md — so it is known at build time and stable across
-- evidence-only commits). A missing or different value aborts BEFORE any
-- lock or write.
DO $package_sha_gate$
DECLARE
  v_sha text := current_setting('{REPAIR_PACKAGE_SHA_GUC}', true);
BEGIN
  IF v_sha IS DISTINCT FROM '{package_sha}' THEN
    RAISE EXCEPTION 'STOP: {REPAIR_PACKAGE_SHA_GUC} must be % (got %) — the execution driver must pass the EXECUTION_PACKAGE_SHA256 of the checked-out package', '{package_sha}', COALESCE(v_sha, '<unset>');
  END IF;
END;
$package_sha_gate$;"""


# ---------------------------------------------------------------------------
# Stage-1 execution receipt SQL (database-side authorization root).
# Digests computed inside the stage-1 transaction over LIVE state:
#   target/survivor digests — over the manifest temp table (also derivable
#     offline from the committed manifest; the builder revalidates them);
#   audit digest — over the exact 154 inserted repair audit rows;
#   postcondition digest — over the live superseded target + survivor-guard
#     rows (runtime superseded_at included).
# Stage 2 recomputes the SAME expressions from live state and requires
# byte-exact equality with the receipt's recorded values. The canonical
# receipt hash is sha256 over the full receipt JSON (minus receipt_sha256);
# jsonb normalizes key order, so the stage-1 build_object rendering and the
# stage-2 (to_jsonb(row) - 'receipt_sha256') rendering are byte-identical.
# ---------------------------------------------------------------------------
def _receipt_target_digest_expr(manifest_table):
    return (
        "encode(extensions.digest(convert_to("
        f"(SELECT string_agg(match_id::text, ',' ORDER BY match_id) "
        f"FROM {manifest_table} WHERE role = 'target'), "
        "'UTF8'), 'sha256'), 'hex')"
    )


def _receipt_survivor_digest_expr(manifest_table):
    return (
        "encode(extensions.digest(convert_to("
        f"(SELECT string_agg(match_id::text || ':' || "
        f"COALESCE(NULLIF(survivor_id::text, ''), ''), ',' ORDER BY match_id) "
        f"FROM {manifest_table} WHERE role = 'target'), "
        "'UTF8'), 'sha256'), 'hex')"
    )


def _receipt_audit_digest_expr():
    return (
        "encode(extensions.digest(convert_to("
        "coalesce((SELECT jsonb_agg(to_jsonb(a) "
        "ORDER BY a.reconciliation_match_id)::text "
        "FROM public.reconciliation_audit_log a "
        f"WHERE a.action = '{AUDIT_ACTION}' "
        f"AND a.operation_id = '{STAGE1_OPERATION_ID}'), '[]'), "
        "'UTF8'), 'sha256'), 'hex')"
    )


def _receipt_postcondition_digest_expr(manifest_table):
    return (
        "encode(extensions.digest(convert_to("
        "coalesce((SELECT jsonb_agg(jsonb_build_object("
        "'role', t.role, 'match_id', m.id, "
        "'superseded_at', m.superseded_at, "
        "'superseded_by_match_id', m.superseded_by_match_id, "
        "'supersede_reason', m.supersede_reason, "
        "'supersede_operation_id', m.supersede_operation_id, "
        "'approved_at', m.approved_at, 'approved_by', m.approved_by, "
        "'confidence', m.confidence) ORDER BY t.role, m.id)::text "
        f"FROM {manifest_table} t "
        "JOIN public.reconciliation_matches m ON m.id = t.match_id), '[]'), "
        "'UTF8'), 'sha256'), 'hex')"
    )


def _receipt_canonical_obj_sql(package_sha, mode, project_ref,
                               target_manifest_sha,
                               artifact_sha_literal=None):
    """Canonical receipt body (its sha256 is receipt_sha256)."""
    ref_sql = sql_lit(project_ref)
    return (
        "jsonb_build_object(\n"
        f"  'execution_package_sha256', '{package_sha}',\n"
        f"  'artifact_sha256', {_artifact_sha_sql(artifact_sha_literal)},\n"
        f"  'operation_id', '{STAGE1_OPERATION_ID}',\n"
        f"  'environment_mode', '{mode}',\n"
        f"  'project_ref', {ref_sql},\n"
        f"  'target_manifest_sha256', '{target_manifest_sha}',\n"
        "  'target_digest_sha256', v_target_digest,\n"
        "  'survivor_mapping_digest_sha256', v_survivor_digest,\n"
        "  'audit_digest_sha256', v_audit_digest,\n"
        "  'postcondition_digest_sha256', v_post_digest,\n"
        "  'executed_at', now(),\n"
        "  'db_identity', current_database())"
    )


def _locks_sql():
    return """-- ===========================================================================
-- P0c. Writer exclusion: database-side execution locks
-- ===========================================================================
LOCK TABLE public.bank_statements IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.bank_transactions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.qb_transactions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.client_entities IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_matches IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reconciliation_audit_log IN ACCESS EXCLUSIVE MODE;"""


def _client_entities_drift_cond(table_alias="t"):
    return (
        f"ce.id IS NULL\n"
        f"     OR ce.practice_id IS DISTINCT FROM {table_alias}.practice_id\n"
        f"     OR ce.status IS DISTINCT FROM 'active'\n"
        f"     OR ce.archived_at IS NOT NULL"
    )


def stage1_sql(s1t, s1g, s2c, dup_after_s1, stage1_manifest_sha, basis_sha,
               mode, project_ref, artifact_identity, execution_package_sha):
    previous_state = _previous_state_sql()
    resulting_state = _resulting_state_sql(STAGE1_OPERATION_ID)
    evidence = _evidence_s1_sql(stage1_manifest_sha, basis_sha, mode,
                                artifact_identity, execution_package_sha)
    ev_match = _evidence_match_s1(previous_state, resulting_state, evidence)
    receipt_canonical = _receipt_canonical_obj_sql(
        execution_package_sha, mode, project_ref, stage1_manifest_sha)
    project_ref_sql = sql_lit(project_ref)
    project_line = (
        f"-- Project:    {project_ref} (bound by the P0.0 identity gate)"
        if project_ref
        else "-- Project:    (REHEARSAL artifact — bound to the scratch restore identity)"
    )
    s1 = f"""-- =============================================================================
-- ZAKI-REPAIR-013-PRE — STAGE 1: UNAPPROVED-ROW REPAIR (exact-ID, basis-bound)
-- =============================================================================
-- Package:         supabase/repair-013-pre (historical repair hardening)
-- Environment mode: {mode}   (bound into the P0.0 identity gate, the audit
--                   evidence, and the artifact identity — see below)
{project_line}
-- Manifest:        manifests/stage1-unapproved-targets.csv
--                  SHA-256 {stage1_manifest_sha}
-- Stage-2 basis:   manifests/stage2-immutable-basis.json
--                  SHA-256 {basis_sha}
--                  (stage 1 identity-checks all 102 approved candidate rows
--                   of the committed basis that protect the affected
--                   endpoints, in addition to the 101 survivor guards)
-- Execution package: SHA-256 {execution_package_sha}
--                  (EXECUTION_PACKAGE_SHA256 — the stable content-based
--                   identity of the production-relevant package files, per
--                   EXECUTION_PACKAGE.md; embedded as a literal AND
--                   required from the execution driver via the
--                   {REPAIR_PACKAGE_SHA_GUC} GUC, so the binding is
--                   independent of any later evidence-only git commit)
-- Artifact identity: {artifact_identity}
--                  (sha256 of operation id | mode | stage-1 manifest |
--                   stage-2 basis | execution package | project ref;
--                   recomputed by bin/build_repair_package.py verify)
-- Snapshot:        production fqvekbzwghjurkcawpgg, captured 2026-08-16
--                  (docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md §2)
-- Operation:       {STAGE1_OPERATION_ID}  (fixed per package release —
--                  the semantic idempotency key; identical in rehearsal and
--                  production)
--
-- Scope: supersedes EXACTLY the 154 unapproved duplicate live-auto rows
--        listed in the stage-1 manifest. NO approved row is touched.
--        NO DELETE. One transaction. Fails closed on any drift.
--
-- Execution gate: {mode} artifacts execute only under their P0.0 identity
--        gate. PRODUCTION execution requires an explicitly authorized
--        repair window (see execution-window.md); this REHEARSAL file
--        cannot run against production.
--
-- Writer exclusion (P0c): ACCESS EXCLUSIVE table locks, taken in the
--        controlled writers' natural order (statements -> bank -> qb ->
--        client_entities -> matches -> audit), after the shared advisory
--        lock. Details and the exclusion analysis: execution-window.md.
--
-- Finite timeouts (P0a): SET LOCAL lock_timeout/statement_timeout BEFORE
--        any blocking lock — a timeout rolls the transaction back
--        (SQLSTATE 55P03/57014) and the runbook treats it as STOP.
--
-- Artifact-sha gate (P0b): the exact frozen artifact sha256 is supplied by
--        the execution driver (PGOPTIONS GUC) and recorded verbatim into
--        the immutable audit evidence.
--
-- Execution-package gate (P0b2): the EXECUTION_PACKAGE_SHA256 GUC must
--        equal the literal embedded above (stable across evidence commits).
--
-- Execution receipt (P1b): the stage-1 apply writes an immutable
--        database-side execution receipt (public.repair_stage1_receipt)
--        INSIDE THE SAME TRANSACTION as the 154 supersessions and audit
--        rows, with database-derived time/state digests. Stage 2 validates
--        that receipt row and recomputes the exact stage-1 state before
--        any stage-2 work — a caller-fabricated stage-1 "proof" JSON is
--        operator evidence only and is NEVER the authorization root.
--
-- Semantic idempotency (P0e): re-running after success proves every target
--        already carries THIS operation id with correct reason/survivor and
--        a byte-exact audit row (action, actor, action_at, previous_state,
--        resulting_state, evidence), then exits as a verified no-op. Altered
--        audit evidence or a different operation id aborts the run.

SET search_path = pg_temp, public;

BEGIN;

SET LOCAL TIME ZONE 'UTC';  -- deterministic timestamptz rendering in the
                            -- exact audit-evidence comparisons below

-- Environment identity validation FIRST — a wrong-database invocation must
-- abort before taking (or waiting on) any lock.
{_mode_gate_sql(mode)}

{_timeouts_sql()}

{_artifact_sha_gate_sql()}

{_package_sha_gate_sql(execution_package_sha)}

-- Serialize repair attempts. Both stages share this key, so stage 1 and
-- stage 2 also serialize against each other.
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});  -- 'ZAKI'

{_locks_sql()}

-- ===========================================================================
-- P0d. Manifest load (targets + survivor guards + committed-basis candidates)
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

-- Approved candidate rows of the committed stage-2 basis (102 rows). Stage 1
-- never writes them; it identity-checks that every approved row protecting
-- an affected endpoint still carries its exact snapshot approval stamps and
-- is either pristine-live or (after stage 2) superseded by the stage-2
-- operation with the basis reason/survivor.
CREATE TEMP TABLE zaki_candidates (
  match_id     uuid PRIMARY KEY,
  class        text NOT NULL,
  reason       text NOT NULL,
  approved_at  timestamptz NOT NULL,
  approved_by  text NOT NULL,
  confidence   numeric(4,3) NOT NULL,
  survivor_id  uuid
) ON COMMIT DROP;

INSERT INTO zaki_candidates
  (match_id, class, reason, approved_at, approved_by, confidence, survivor_id)
VALUES
{candidate_row_values(s2c)};

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
  IF (SELECT count(*) FROM zaki_candidates) <> {EXPECTED['stage2_candidates']} THEN
    RAISE EXCEPTION 'STOP: committed-basis candidate integrity failure';
  END IF;
  IF (SELECT count(*) FROM zaki_endpoints) <> {EXPECTED['dup_endpoints']} THEN
    RAISE EXCEPTION 'STOP: endpoint manifest integrity failure';
  END IF;
END $$;

-- ===========================================================================
-- P0f. Stage dispatcher (semantic idempotency on THIS operation id)
-- ===========================================================================
-- A row superseded by this operation counts as DONE only if its audit row
-- carries the byte-exact expected evidence (actor, action_at, previous_state,
-- resulting_state, evidence). Altered audit evidence is neither live nor
-- done: the run aborts as partial state (Phase 8 audit idempotency).
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

  -- Targets superseded by THIS operation with correct fields and exact
  -- audit evidence.
  SELECT count(*) INTO v_done
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  JOIN public.reconciliation_audit_log a
    ON a.reconciliation_match_id = t.match_id
   AND a.action = '{AUDIT_ACTION}'
   AND a.operation_id = '{STAGE1_OPERATION_ID}'
  WHERE t.role = 'target'
    AND m.superseded_at IS NOT NULL
    AND m.supersede_operation_id = '{STAGE1_OPERATION_ID}'
    AND m.supersede_reason = t.reason
    AND m.superseded_by_match_id IS NOT DISTINCT FROM t.survivor_id
    AND {ev_match};

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
-- P0g. Exact drift preconditions (every manifest row vs live DB state)
-- ===========================================================================
DO $$
DECLARE
  v_bad int;
  v_mode text := current_setting('zaki.repair_mode');
BEGIN
  -- 1. Endpoint identity + value fingerprints for EVERY manifest row,
  --    including the client_entities row identity: the tenant row must
  --    exist, carry the manifest practice_id, and be active (client_entities
  --    is lock-protected for the transaction above).
  SELECT count(*) INTO v_bad
  FROM zaki_manifest t
  LEFT JOIN public.reconciliation_matches m ON m.id = t.match_id
  LEFT JOIN public.bank_transactions b ON b.id = t.bank_id
  LEFT JOIN public.qb_transactions q ON q.id = t.qb_id
  LEFT JOIN public.bank_statements s ON s.id = t.statement_id
  LEFT JOIN public.client_entities ce ON ce.id = t.client_id
  WHERE m.id IS NULL
     OR (m.user_id, m.client_entity_id, m.statement_id, m.bank_transaction_id, m.qb_transaction_id)
        IS DISTINCT FROM (t.user_id, t.client_id, t.statement_id, t.bank_id, t.qb_id)
     OR (b.user_id, b.statement_id, b.client_entity_id, b.transaction_date, b.amount)
        IS DISTINCT FROM (t.user_id, t.statement_id, t.client_id, t.bank_date, t.bank_amount)
     OR (q.user_id, q.client_entity_id, q.ledger_book_id, q.posted_date, q.amount)
        IS DISTINCT FROM (t.user_id, t.client_id, t.qb_book, t.qb_date, t.qb_amount)
     OR (s.user_id, s.client_entity_id, s.ledger_book_id, s.file_name, s.upload_date)
        IS DISTINCT FROM (t.user_id, t.client_id, t.stmt_book, t.stmt_file, t.stmt_upload)
     OR {_client_entities_drift_cond()}
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

  -- 2. Approval/state drift: targets must be completely unapproved
  --    (approved_at AND approved_by NULL); survivors must keep their exact
  --    approved stamps and stay live.
  SELECT count(*) INTO v_bad
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE (t.role = 'target'
         AND (m.approved_at IS NOT NULL OR m.approved_by IS NOT NULL))
     OR (t.role = 'survivor_guard'
         AND (m.approved_at IS NULL
              OR m.approved_by IS DISTINCT FROM t.approved_by
              OR m.superseded_at IS NOT NULL
              OR m.approved_at IS DISTINCT FROM t.approved_at
              OR m.confidence IS DISTINCT FROM t.confidence
              OR abs((SELECT b.amount FROM public.bank_transactions b WHERE b.id = m.bank_transaction_id)
                   - (SELECT q.amount FROM public.qb_transactions q WHERE q.id = m.qb_transaction_id)) > 0.01));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % rows drifted from the expected approval state (target approved / survivor changed)', v_bad;
  END IF;

  -- 2b. Committed-basis candidates (the 102 approved rows that protect the
  --     affected endpoints): exact approval stamps and either pristine-live
  --     or (stage-2-completed state) superseded by the stage-2 operation
  --     with the basis reason/survivor and audit row. A candidate row
  --     superseded by anything else aborts.
  SELECT count(*) INTO v_bad
  FROM zaki_candidates t
  LEFT JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE m.id IS NULL
     OR m.approved_at IS DISTINCT FROM t.approved_at
     OR m.approved_by IS DISTINCT FROM t.approved_by
     OR m.confidence IS DISTINCT FROM t.confidence
     OR (m.superseded_at IS NOT NULL
         AND (m.supersede_operation_id IS DISTINCT FROM '{STAGE2_OPERATION_ID}'
              OR m.supersede_reason IS DISTINCT FROM t.reason
              OR m.superseded_by_match_id IS DISTINCT FROM t.survivor_id
              OR NOT EXISTS (
                SELECT 1 FROM public.reconciliation_audit_log a
                WHERE a.reconciliation_match_id = t.match_id
                  AND a.action = '{AUDIT_ACTION}'
                  AND a.operation_id = '{STAGE2_OPERATION_ID}')));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % approved candidate rows drifted from the committed stage-2 basis', v_bad;
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

  -- 4. (Apply mode) exact clean pre-state: targets must carry NO supersession
  --    fields at all, and so must the committed-basis candidate rows.
  IF v_mode = 'apply' THEN
    SELECT count(*) INTO v_bad
    FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'target'
      AND (m.superseded_at IS NOT NULL
           OR m.superseded_by_match_id IS NOT NULL
           OR m.supersede_reason IS NOT NULL
           OR m.supersede_operation_id IS NOT NULL);
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'STOP: % stage-1 targets carry stale supersession fields', v_bad;
    END IF;
    SELECT count(*) INTO v_bad
    FROM zaki_candidates t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE m.superseded_at IS NOT NULL
       OR m.superseded_by_match_id IS NOT NULL
       OR m.supersede_reason IS NOT NULL
       OR m.supersede_operation_id IS NOT NULL;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'STOP: % candidate rows carry stale supersession fields before stage 1', v_bad;
    END IF;
  END IF;

  -- 5. (Apply mode) exact pre-state: the affected-row population must be
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
  -- stamps, manifest hashes, environment mode, artifact identity).
  INSERT INTO public.reconciliation_audit_log
    (id, reconciliation_match_id, action, action_by, action_at,
     old_confidence, new_confidence, client_entity_id, user_id,
     operation_id, previous_state, resulting_state, evidence)
  SELECT
    gen_random_uuid(), t.match_id, '{AUDIT_ACTION}', '{STAGE1_ACTOR}', now(),
    t.confidence, t.confidence, t.client_id, t.user_id,
    '{STAGE1_OPERATION_ID}',
    {previous_state},
    {resulting_state},
    {evidence}
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
-- P1b. Stage-1 execution receipt (database-side checkpoint — the
--      authorization root for stage 2). Written INSIDE THE SAME
--      TRANSACTION as the supersessions and audit rows above: a committed
--      stage-1 result always carries its receipt, and no receipt can exist
--      without the exact stage-1 state. Digests are computed here from
--      LIVE database state with database time (executed_at = now(), the
--      same value as the audit rows' action_at). The receipt row is
--      UPDATE/DELETE-immutable (prep trigger) and unique per operation id.
-- ===========================================================================
DO $receipt$
DECLARE
  v_target_digest   text;
  v_survivor_digest text;
  v_audit_digest    text;
  v_post_digest     text;
  v_sha             text;
BEGIN
  IF current_setting('zaki.repair_mode') <> 'apply' THEN
    RAISE NOTICE 'STAGE 1: dispatch mode is noop — the existing receipt is validated in the postconditions';
    RETURN;
  END IF;

  SELECT {_receipt_target_digest_expr('zaki_manifest')} INTO v_target_digest;
  SELECT {_receipt_survivor_digest_expr('zaki_manifest')} INTO v_survivor_digest;
  SELECT {_receipt_audit_digest_expr()} INTO v_audit_digest;
  SELECT {_receipt_postcondition_digest_expr('zaki_manifest')} INTO v_post_digest;

  SELECT encode(extensions.digest(convert_to(
    {receipt_canonical}::text, 'UTF8'), 'sha256'), 'hex') INTO v_sha;

  INSERT INTO public.repair_stage1_receipt
    (receipt_sha256, execution_package_sha256, artifact_sha256, operation_id,
     environment_mode, project_ref, target_manifest_sha256,
     target_digest_sha256, survivor_mapping_digest_sha256,
     audit_digest_sha256, postcondition_digest_sha256, executed_at,
     db_identity)
  VALUES
    (v_sha, '{execution_package_sha}',
     current_setting('{REPAIR_ARTIFACT_SHA_GUC}', true),
     '{STAGE1_OPERATION_ID}', '{mode}', {project_ref_sql},
     '{stage1_manifest_sha}',
     v_target_digest, v_survivor_digest, v_audit_digest, v_post_digest,
     now(), current_database());
  RAISE NOTICE 'STAGE 1: wrote execution receipt %', v_sha;
END;
$receipt$;

-- ===========================================================================
-- P2. Exact postconditions (set identity, not just counts)
-- ===========================================================================
DO $post$
DECLARE
  v int;
  v_mode text := current_setting('zaki.repair_mode');
  v_rec public.repair_stage1_receipt%ROWTYPE;
BEGIN
  -- 0. STAGE-1 EXECUTION RECEIPT (both modes): exactly one immutable
  --    database-side receipt row must exist for this operation and carry
  --    the exact package/artifact/mode/manifest bindings and the
  --    database-derived digests of the state this artifact produced
  --    (apply mode: just written by P1b; noop mode: written by the
  --    original apply). The canonical hash must recompute from the stored
  --    row — the receipt row itself is the authorization root, never a
  --    caller-supplied JSON.
  IF (SELECT count(*) FROM public.repair_stage1_receipt) <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly one stage-1 execution receipt, found % — stage-1 state without its receipt was not produced by this package',
      (SELECT count(*) FROM public.repair_stage1_receipt);
  END IF;
  SELECT * INTO v_rec FROM public.repair_stage1_receipt;
  IF v_rec.operation_id IS DISTINCT FROM '{STAGE1_OPERATION_ID}'::uuid THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt records a different operation id';
  END IF;
  IF v_rec.environment_mode IS DISTINCT FROM '{mode}' THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt records a different environment mode';
  END IF;
  IF v_rec.project_ref IS DISTINCT FROM {project_ref_sql} THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt records a different project identity';
  END IF;
  IF v_rec.execution_package_sha256 IS DISTINCT FROM '{execution_package_sha}' THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt binds a different execution package';
  END IF;
  IF v_rec.artifact_sha256 IS DISTINCT FROM current_setting('{REPAIR_ARTIFACT_SHA_GUC}', true) THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt records a different stage-1 artifact sha than this artifact';
  END IF;
  IF v_rec.target_manifest_sha256 IS DISTINCT FROM '{stage1_manifest_sha}' THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt binds a different stage-1 manifest';
  END IF;
  IF v_rec.target_digest_sha256 IS DISTINCT FROM ({_receipt_target_digest_expr('zaki_manifest')}) THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt target digest does not match the committed stage-1 manifest';
  END IF;
  IF v_rec.survivor_mapping_digest_sha256 IS DISTINCT FROM ({_receipt_survivor_digest_expr('zaki_manifest')}) THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt survivor-mapping digest does not match the committed stage-1 manifest';
  END IF;
  IF v_rec.audit_digest_sha256 IS DISTINCT FROM ({_receipt_audit_digest_expr()}) THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt audit digest does not match the live stage-1 audit rows';
  END IF;
  IF v_rec.postcondition_digest_sha256 IS DISTINCT FROM ({_receipt_postcondition_digest_expr('zaki_manifest')}) THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt postcondition digest does not match the live stage-1 state';
  END IF;
  IF encode(extensions.digest(convert_to((to_jsonb(v_rec) - 'receipt_sha256')::text, 'UTF8'), 'sha256'), 'hex')
     IS DISTINCT FROM v_rec.receipt_sha256 THEN
    RAISE EXCEPTION 'FAIL: stage-1 receipt canonical hash does not recompute from the stored row (tampered receipt)';
  END IF;

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

  -- 3b. FULL AUDIT IDEMPOTENCY (Phase 8): every repair audit row for this
  --     operation must carry the byte-exact expected evidence. An altered
  --     audit row is an ABORT, never a silent no-op.
  IF EXISTS (
    SELECT 1
    FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    JOIN public.reconciliation_audit_log a
      ON a.reconciliation_match_id = t.match_id
     AND a.action = '{AUDIT_ACTION}'
     AND a.operation_id = '{STAGE1_OPERATION_ID}'
    WHERE t.role = 'target'
      AND NOT ({ev_match})
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 repair audit row carries altered evidence (action/actor/action_at/previous_state/resulting_state/evidence mismatch)';
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
    RAISE NOTICE 'STAGE 1: ALREADY APPLIED — verified % targets carry this operation with correct fields and byte-exact audit evidence; no-op commit',
      (SELECT count(*) FROM zaki_manifest WHERE role = 'target');
  END IF;
END;
$post$;

COMMIT;
"""
    return s1


def stage2_sql(s2c_rows, s2g_rows, s1t, s1g, dup_after_s1, auth_manifest_sha,
               basis_sha, stage1_artifact_sha, receipt_sha,
               execution_package_sha, mode, project_ref, artifact_identity,
               n_exec, stage1_manifest_sha=""):
    """Emit stage-2 SQL from the COMMITTED basis joined with the validated
    authorization manifest decisions.

    s2c_rows/s2g_rows: basis rows WITH decision columns filled from the
    validated authorization manifest (accountant_decision,
    accountant_identity, confirmation_timestamp, authorization_status,
    accountant_note).
    s1t/s1g: the FULL committed stage-1 manifest (154 targets + 101 survivor
    guards) — embedded so stage 2 revalidates the EXACT stage-1 result
    (operation id, reason, survivor, original approval state, accounting
    identity fingerprints, and byte-exact audit rows) instead of trusting
    "superseded and has an audit row" (execution-integrity blocker 1).
    dup_after_s1: post-stage-1 endpoint set (precondition in apply mode).
    """
    exec_ids = [
        r["match_id"] for r in s2c_rows
        if r["accountant_decision"] == "RETIRE"
        and r["authorization_status"] == "APPROVED_FOR_RETIREMENT"
    ]
    if len(exec_ids) != n_exec:
        raise SystemExit(
            f"authorization manifest inconsistent: {len(exec_ids)} executable "
            f"rows, expected {n_exec}"
        )
    # Pre-stage-2 duplicate endpoint set = the stage-1 remainder (91). The
    # post-stage-2 set is derived from the authorized subset: an endpoint
    # remains duplicate iff >=2 of its basis rows are NOT retired.
    pre_set = [
        r["qb_transaction_id"] for r in dup_after_s1
        if not r["resolved_by_stage1"]
    ]
    retired = set(exec_ids)
    ep_rows = defaultdict(list)
    for r in s2c_rows + s2g_rows:
        ep_rows[r["qb_transaction_id"]].append(r)
    remaining = []
    for qb_id in sorted(pre_set):
        rows = ep_rows[qb_id]
        live = [r for r in rows if r["match_id"] not in retired]
        remaining.append({"qb_transaction_id": qb_id,
                          "still_duplicate": len(live) >= 2})

    previous_state = _previous_state_sql()
    resulting_state = _resulting_state_sql(STAGE2_OPERATION_ID)
    evidence = _evidence_s2_sql(auth_manifest_sha, basis_sha,
                                stage1_artifact_sha, receipt_sha,
                                execution_package_sha, mode,
                                artifact_identity)
    ev_match = _evidence_match_s2(previous_state, resulting_state, evidence)

    # Stage-1 revalidation predicates (blocker 1): the EXACT stage-1 audit
    # evidence expected in the database, rebuilt from the committed stage-1
    # manifest with the stage-1 artifact sha as a LITERAL — stage 2 binds the
    # exact stage-1 artifact it sequences on, so a stage-1 audit row whose
    # evidence does not record that exact artifact sha aborts stage 2.
    stage1_identity = artifact_identity_stage1(
        mode, stage1_manifest_sha, basis_sha, execution_package_sha,
        project_ref,
    )
    s1_previous_state = _previous_state_sql()
    s1_resulting_state = _resulting_state_sql(STAGE1_OPERATION_ID)
    s1_evidence_reval = _evidence_s1_sql(
        stage1_manifest_sha, basis_sha, mode, stage1_identity,
        execution_package_sha, artifact_sha_literal=stage1_artifact_sha,
    )
    s1_ev_match = _evidence_match_s1(
        s1_previous_state, s1_resulting_state, s1_evidence_reval
    )
    project_ref_sql = sql_lit(project_ref)
    project_line = (
        f"-- Project:    {project_ref} (bound by the P0.0 identity gate)"
        if project_ref
        else "-- Project:    (REHEARSAL artifact — bound to the scratch restore identity)"
    )

    s2 = f"""-- =============================================================================
-- ZAKI-REPAIR-013-PRE — STAGE 2: APPROVED-ROW REPAIR (accountant-authorized)
-- =============================================================================
-- Package:         supabase/repair-013-pre (historical repair hardening)
-- Environment mode: {mode}   (bound into the P0.0 identity gate, the audit
--                   evidence, and the artifact identity — see below)
{project_line}
-- Committed basis: manifests/stage2-immutable-basis.json
--                  SHA-256 {basis_sha}
--                  (ALL accounting identity — QB/bank/statement ids, tenant/
--                   user/client/book, fingerprints, class, reason, action,
--                   permitted survivor/decision sets — comes from this
--                   committed basis, never from the authorization manifest)
-- Authorization manifest: SHA-256 {auth_manifest_sha}
--                  (decision-only: match_id, decision, accountant identity,
--                   confirmation timestamp, note; validated by
--                   bin/build_repair_package.py as a decision over the basis)
-- Stage-1 manifest: manifests/stage1-unapproved-targets.csv
--                   SHA-256 {stage1_manifest_sha}
-- Stage-1 artifact: SHA-256 {stage1_artifact_sha}  (the exact stage-1 file
--                   the operator executed)
-- Stage-1 execution receipt (database-side authorization root): canonical
--                   SHA-256 {receipt_sha}  — written by stage 1 INSIDE ITS
--                   OWN TRANSACTION; this artifact validates the ACTUAL
--                   receipt row and independently recomputes the exact
--                   stage-1 state before any stage-2 work (P0e/checkpoint).
-- Execution package: SHA-256 {execution_package_sha}
--                   (EXECUTION_PACKAGE_SHA256 — embedded literal AND
--                   required from the driver via {REPAIR_PACKAGE_SHA_GUC};
--                   stable across evidence-only commits)
-- Artifact identity: {artifact_identity}
--                  (sha256 of operation ids | mode | stage-1 manifest |
--                   stage-2 basis | authorization manifest | stage-1
--                   artifact | stage-1 receipt | execution package |
--                   project ref)
-- Stage-1 prerequisite: the stage-1 artifact above must have run with
--             operation {STAGE1_OPERATION_ID} and its immutable receipt
--             row must exist in the database.
-- Operation:  {STAGE2_OPERATION_ID}  (fixed per package release — the
--             semantic idempotency key; identical in rehearsal and
--             production)
--
-- Scope: supersedes EXACTLY the rows whose committed-basis candidates carry
--        an authorization decision RETIRE ({n_exec} rows). Rows with any
--        other or no decision are asserted untouched. The survivor for an
--        authorized retirement is the basis survivor (for R6 pairs: the
--        other member). NO DELETE. One transaction. Fails closed on any
--        drift.
--
-- Actor identity: every stage-2 audit row records the confirming
--        accountant's identity from the authorization manifest (action_by),
--        never a system identity — the system does not make accounting
--        judgements.
--
-- Execution gate: {mode} artifacts execute only under their P0.0 identity
--        gate. PRODUCTION execution requires an explicitly authorized
--        repair window (see execution-window.md); a REHEARSAL artifact
--        cannot run against production.
--
-- Finite timeouts (P0a): SET LOCAL lock_timeout/statement_timeout BEFORE
--        any blocking lock — a timeout rolls the transaction back
--        (SQLSTATE 55P03/57014) and the runbook treats it as STOP.
--
-- Artifact-sha gate (P0b): the exact frozen artifact sha256 is supplied by
--        the execution driver (PGOPTIONS GUC) and recorded verbatim into
--        the immutable audit evidence; the no-op/idempotency revalidation
--        compares it byte-exactly, so a rerun only verifies as a no-op when
--        the exact frozen artifact sha is supplied.
--
-- Execution-package gate (P0b2): the EXECUTION_PACKAGE_SHA256 GUC must
--        equal the literal embedded above (stable across evidence commits).
--
-- Stage-1 execution receipt (P0e checkpoint): the ACTUAL database-side
--        receipt row written by stage 1 is validated here — exactly one
--        row, canonical-hash recomputation, package/artifact/mode/project/
--        manifest bindings, and the database-derived target/survivor/
--        audit/postcondition digests recomputed from LIVE state. A
--        caller-fabricated stage-1 "proof" JSON can never satisfy this
--        check; it is operator evidence only.

SET search_path = pg_temp, public;

BEGIN;

SET LOCAL TIME ZONE 'UTC';  -- deterministic timestamptz rendering in the
                            -- exact audit-evidence comparisons below

-- Environment identity validation FIRST — a wrong-database invocation must
-- abort before taking (or waiting on) any lock.
{_mode_gate_sql(mode)}

{_timeouts_sql()}

{_artifact_sha_gate_sql()}

{_package_sha_gate_sql(execution_package_sha)}

-- Serialize repair attempts. Both stages share this key, so stage 1 and
-- stage 2 also serialize against each other.
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});  -- 'ZAKI'

{_locks_sql()}

-- ===========================================================================
-- P0d. Manifest load (committed basis + authorization decisions)
-- ===========================================================================
CREATE TEMP TABLE zaki_manifest (
  match_id     uuid PRIMARY KEY,
  role         text NOT NULL CHECK (role IN ('candidate','survivor_guard')),
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
  authorization_status text,
  accountant_note text
) ON COMMIT DROP;

INSERT INTO zaki_manifest
  (match_id, role, class, stage, reason, action,
   qb_id, qb_date, qb_amount, qb_desc, qb_desc_fp, qb_book,
   bank_id, bank_date, bank_amount, bank_desc, bank_desc_fp, bank_merchant,
   statement_id, stmt_file, stmt_upload, stmt_book,
   user_id, client_id, practice_id, matched_by, matched_at, confidence,
   flagged_level, approved_at, approved_by, survivor_id, evidence,
   accountant_decision, accountant_identity, confirmation_timestamp,
   authorization_status, accountant_note)
VALUES
{auth_row_values(s2c_rows + s2g_rows)};

-- The FULL committed stage-1 manifest (154 targets + 101 survivor guards).
-- Stage 2 never trusts "superseded and has an audit row": it revalidates
-- the EXACT stage-1 result — operation id, reason, survivor, original
-- unapproved state, accounting identity fingerprints, and byte-exact audit
-- rows — against these committed rows (execution-integrity blocker 1).
CREATE TEMP TABLE zaki_s1_manifest (
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

INSERT INTO zaki_s1_manifest
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
  still_duplicate boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO zaki_endpoints (qb_id, still_duplicate) VALUES
{stage2_endpoint_values(remaining)};

DO $$
DECLARE
  v int;
BEGIN
  IF (SELECT count(*) FROM zaki_manifest WHERE role = 'candidate') <> {EXPECTED['stage2_candidates']} THEN
    RAISE EXCEPTION 'STOP: manifest integrity failure (candidate count)';
  END IF;
  IF (SELECT count(*) FROM zaki_s1_manifest WHERE role = 'target') <> {EXPECTED['stage1_targets']} THEN
    RAISE EXCEPTION 'STOP: embedded stage-1 manifest integrity failure (target count)';
  END IF;
  IF (SELECT count(*) FROM zaki_s1_manifest WHERE role = 'survivor_guard') <> {EXPECTED['stage1_guards']} THEN
    RAISE EXCEPTION 'STOP: embedded stage-1 manifest integrity failure (guard count)';
  END IF;
  IF (SELECT count(*) FROM zaki_manifest WHERE role = 'survivor_guard') <> {EXPECTED['stage2_guards']} THEN
    RAISE EXCEPTION 'STOP: manifest integrity failure (guard count)';
  END IF;
  IF (SELECT count(*) FROM zaki_manifest
      WHERE role = 'candidate' AND accountant_decision = 'RETIRE'
        AND authorization_status = 'APPROVED_FOR_RETIREMENT') <> {n_exec} THEN
    RAISE EXCEPTION 'STOP: authorized-execution set does not match the authorization manifest ({n_exec} expected)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM zaki_manifest
    WHERE role = 'candidate' AND accountant_decision = 'RETIRE'
      AND (accountant_identity IS NULL OR btrim(accountant_identity) = ''
           OR confirmation_timestamp IS NULL)
  ) THEN
    RAISE EXCEPTION 'STOP: an authorized row lacks accountant identity or confirmation timestamp';
  END IF;
END $$;

-- ===========================================================================
-- P0d2. Stage-1 execution receipt (database-side authorization root). The
--       ACTUAL immutable receipt row written by stage 1 inside its own
--       transaction is validated here: exactly one row, canonical-hash
--       recomputation from the stored row, the exact package/artifact/mode/
--       project/manifest bindings, and the database-derived target /
--       survivor-mapping / audit / postcondition digests INDEPENDENTLY
--       RECOMPUTED FROM LIVE STATE. A caller-fabricated stage-1 "proof"
--       JSON can never satisfy this check (Codex finding 1) — the freeze
--       command's consistency validation of a receipt EXPORT is operator
--       evidence only, never authorization.
-- ===========================================================================
DO $$
DECLARE
  v_rec public.repair_stage1_receipt%ROWTYPE;
BEGIN
  IF (SELECT count(*) FROM public.repair_stage1_receipt) <> 1 THEN
    RAISE EXCEPTION 'STOP: expected exactly one stage-1 execution receipt, found % — stage 1 must have run: its receipt is written in the SAME TRANSACTION as the 154 supersessions; a caller-fabricated stage-1 proof JSON is not an authorization root',
      (SELECT count(*) FROM public.repair_stage1_receipt);
  END IF;
  SELECT * INTO v_rec FROM public.repair_stage1_receipt;
  IF v_rec.operation_id IS DISTINCT FROM '{STAGE1_OPERATION_ID}'::uuid THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt records a different operation id';
  END IF;
  IF v_rec.environment_mode IS DISTINCT FROM '{mode}' THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt records a different environment mode';
  END IF;
  IF v_rec.project_ref IS DISTINCT FROM {project_ref_sql} THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt records a different project identity';
  END IF;
  IF v_rec.execution_package_sha256 IS DISTINCT FROM '{execution_package_sha}' THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt binds a different execution package';
  END IF;
  IF v_rec.artifact_sha256 IS DISTINCT FROM '{stage1_artifact_sha}' THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt records a stage-1 artifact different from the one this artifact sequences on';
  END IF;
  IF v_rec.target_manifest_sha256 IS DISTINCT FROM '{stage1_manifest_sha}' THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt binds a different stage-1 manifest';
  END IF;
  IF v_rec.target_digest_sha256 IS DISTINCT FROM ({_receipt_target_digest_expr('zaki_s1_manifest')}) THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt target digest does not match the committed stage-1 manifest';
  END IF;
  IF v_rec.survivor_mapping_digest_sha256 IS DISTINCT FROM ({_receipt_survivor_digest_expr('zaki_s1_manifest')}) THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt survivor-mapping digest does not match the committed stage-1 manifest';
  END IF;
  IF v_rec.audit_digest_sha256 IS DISTINCT FROM ({_receipt_audit_digest_expr()}) THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt audit digest does not match the live stage-1 audit rows';
  END IF;
  IF v_rec.postcondition_digest_sha256 IS DISTINCT FROM ({_receipt_postcondition_digest_expr('zaki_s1_manifest')}) THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt postcondition digest does not match the live stage-1 state';
  END IF;
  IF encode(extensions.digest(convert_to((to_jsonb(v_rec) - 'receipt_sha256')::text, 'UTF8'), 'sha256'), 'hex')
     IS DISTINCT FROM v_rec.receipt_sha256 THEN
    RAISE EXCEPTION 'STOP: stage-1 receipt canonical hash does not recompute from the stored row (tampered receipt)';
  END IF;
  RAISE NOTICE 'STAGE 2: stage-1 execution receipt % validated (digests recomputed from live state)', v_rec.receipt_sha256;
END $$;

-- ===========================================================================
-- P0e. Stage-1 checkpoint revalidation (the EXACT committed stage-1 result)
-- ===========================================================================
-- Stage 2 sequences on the exact stage-1 execution. EVERY one of the 154
-- committed stage-1 targets must carry: the stage-1 operation id, the
-- committed stage-1 reason and survivor, its original unapproved state, its
-- exact snapshot accounting identity (bank/qb/statement/tenant
-- fingerprints), and EXACTLY ONE byte-exact stage-1 repair audit row
-- (action, operation, actor, action_at == superseded_at,
-- previous_state/resulting_state, and evidence incl. the stage-1 artifact
-- sha, manifest/basis hashes, mode, artifact identity). The 101 committed
-- stage-1 survivor guards must remain live with their exact approval
-- stamps. ANY divergence aborts stage 2 with ZERO stage-2 changes.
DO $$
DECLARE
  v_bad int;
BEGIN
  -- 1. Identity/value drift of every stage-1 manifest row (the same
  --    predicate the stage-1 artifact itself enforced — revalidated here,
  --    never assumed).
  SELECT count(*) INTO v_bad
  FROM zaki_s1_manifest t
  LEFT JOIN public.reconciliation_matches m ON m.id = t.match_id
  LEFT JOIN public.bank_transactions b ON b.id = t.bank_id
  LEFT JOIN public.qb_transactions q ON q.id = t.qb_id
  LEFT JOIN public.bank_statements s ON s.id = t.statement_id
  LEFT JOIN public.client_entities ce ON ce.id = t.client_id
  WHERE m.id IS NULL
     OR (m.user_id, m.client_entity_id, m.statement_id, m.bank_transaction_id, m.qb_transaction_id)
        IS DISTINCT FROM (t.user_id, t.client_id, t.statement_id, t.bank_id, t.qb_id)
     OR (b.user_id, b.statement_id, b.client_entity_id, b.transaction_date, b.amount)
        IS DISTINCT FROM (t.user_id, t.statement_id, t.client_id, t.bank_date, t.bank_amount)
     OR (q.user_id, q.client_entity_id, q.ledger_book_id, q.posted_date, q.amount)
        IS DISTINCT FROM (t.user_id, t.client_id, t.qb_book, t.qb_date, t.qb_amount)
     OR (s.user_id, s.client_entity_id, s.ledger_book_id, s.file_name, s.upload_date)
        IS DISTINCT FROM (t.user_id, t.client_id, t.stmt_book, t.stmt_file, t.stmt_upload)
     OR {_client_entities_drift_cond()}
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
    RAISE EXCEPTION 'STOP: % stage-1 manifest rows drifted from the exact committed stage-1 state (identity/value drift)', v_bad;
  END IF;

  -- 2. Targets keep their original unapproved state (approval/accounting
  --    identity of the stage-1 repair).
  SELECT count(*) INTO v_bad
  FROM zaki_s1_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND (m.approved_at IS NOT NULL OR m.approved_by IS NOT NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % stage-1 targets lost their original unapproved state', v_bad;
  END IF;

  -- 3. Targets superseded exactly as the stage-1 artifact committed:
  --    operation id, reason, and survivor link (all three, exact).
  SELECT count(*) INTO v_bad
  FROM zaki_s1_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target'
    AND (m.superseded_at IS NULL
         OR m.supersede_operation_id IS DISTINCT FROM '{STAGE1_OPERATION_ID}'
         OR m.supersede_reason IS DISTINCT FROM t.reason
         OR m.superseded_by_match_id IS DISTINCT FROM t.survivor_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % stage-1 targets do not carry the exact committed stage-1 supersession state', v_bad;
  END IF;

  -- 4. Targets: EXACTLY ONE byte-exact stage-1 repair audit row each
  --    (action, operation, actor, action_at == superseded_at,
  --    previous_state/resulting_state/evidence incl. the stage-1 artifact
  --    sha, manifest/basis hashes, mode, artifact identity, and the row
  --    stamps).
  SELECT count(*) INTO v_bad
  FROM zaki_s1_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'target' AND NOT EXISTS (
    SELECT 1 FROM public.reconciliation_audit_log a
    WHERE a.reconciliation_match_id = t.match_id
      AND a.action = '{AUDIT_ACTION}'
      AND a.operation_id = '{STAGE1_OPERATION_ID}'
      AND {s1_ev_match}
      AND a.old_confidence IS NOT DISTINCT FROM t.confidence
      AND a.new_confidence IS NOT DISTINCT FROM t.confidence
      AND a.client_entity_id = t.client_id
      AND a.user_id = t.user_id
  );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % stage-1 targets lack their exact stage-1 repair audit row (missing or altered evidence)', v_bad;
  END IF;
  SELECT count(*) INTO v_bad FROM (
    SELECT reconciliation_match_id FROM public.reconciliation_audit_log
    WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE1_OPERATION_ID}'
    GROUP BY reconciliation_match_id HAVING count(*) > 1
  ) d;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % stage-1 targets carry more than one stage-1 repair audit row', v_bad;
  END IF;

  -- 5. Survivor guards: live, approved, exact stamps — the survivors the
  --    committed stage-1 result depends on.
  SELECT count(*) INTO v_bad
  FROM zaki_s1_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'survivor_guard'
    AND (m.approved_at IS NULL
         OR m.superseded_at IS NOT NULL
         OR m.approved_at IS DISTINCT FROM t.approved_at
         OR m.approved_by IS DISTINCT FROM t.approved_by
         OR m.confidence IS DISTINCT FROM t.confidence);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % stage-1 survivor guards drifted from the exact committed stage-1 state', v_bad;
  END IF;
END $$;

-- ===========================================================================
-- P0f. Stage dispatcher (semantic idempotency on THIS operation id)
-- ===========================================================================
-- A row superseded by this operation counts as DONE only if its audit row
-- carries the byte-exact expected evidence (accountant actor, action_at,
-- previous_state, resulting_state, evidence incl. manifest hashes, mode,
-- artifact identity, and the exact frozen artifact sha). Altered audit
-- evidence is neither live nor done: the run aborts as partial state
-- (Phase 8 audit idempotency).
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
  WHERE t.role = 'candidate'
    AND t.accountant_decision = 'RETIRE'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
    AND m.superseded_at IS NULL;

  -- Executable targets already superseded by THIS operation, correct fields
  -- and byte-exact audit evidence.
  SELECT count(*) INTO v_done
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  JOIN public.reconciliation_audit_log a
    ON a.reconciliation_match_id = t.match_id
   AND a.action = '{AUDIT_ACTION}'
   AND a.operation_id = '{STAGE2_OPERATION_ID}'
  WHERE t.role = 'candidate'
    AND t.accountant_decision = 'RETIRE'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
    AND m.superseded_at IS NOT NULL
    AND m.supersede_operation_id = '{STAGE2_OPERATION_ID}'
    AND m.supersede_reason = t.reason
    AND m.superseded_by_match_id IS NOT DISTINCT FROM t.survivor_id
    AND {ev_match};

  SELECT count(*) INTO v_other
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'candidate'
    AND t.accountant_decision = 'RETIRE'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
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
-- P0g. Exact drift preconditions (every manifest row vs live DB state)
-- ===========================================================================
DO $$
DECLARE
  v_bad int;
  v_mode text := current_setting('zaki.repair_mode');
BEGIN
  -- 1. Endpoint identity + value fingerprints for EVERY manifest row,
  --    including the client_entities row identity (practice_id, active).
  SELECT count(*) INTO v_bad
  FROM zaki_manifest t
  LEFT JOIN public.reconciliation_matches m ON m.id = t.match_id
  LEFT JOIN public.bank_transactions b ON b.id = t.bank_id
  LEFT JOIN public.qb_transactions q ON q.id = t.qb_id
  LEFT JOIN public.bank_statements s ON s.id = t.statement_id
  LEFT JOIN public.client_entities ce ON ce.id = t.client_id
  WHERE m.id IS NULL
     OR (m.user_id, m.client_entity_id, m.statement_id, m.bank_transaction_id, m.qb_transaction_id)
        IS DISTINCT FROM (t.user_id, t.client_id, t.statement_id, t.bank_id, t.qb_id)
     OR (b.user_id, b.statement_id, b.client_entity_id, b.transaction_date, b.amount)
        IS DISTINCT FROM (t.user_id, t.statement_id, t.client_id, t.bank_date, t.bank_amount)
     OR (q.user_id, q.client_entity_id, q.ledger_book_id, q.posted_date, q.amount)
        IS DISTINCT FROM (t.user_id, t.client_id, t.qb_book, t.qb_date, t.qb_amount)
     OR (s.user_id, s.client_entity_id, s.ledger_book_id, s.file_name, s.upload_date)
        IS DISTINCT FROM (t.user_id, t.client_id, t.stmt_book, t.stmt_file, t.stmt_upload)
     OR {_client_entities_drift_cond()}
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

  -- 2b. (Apply mode) exact clean pre-state: no supersession fields on any
  --     candidate or guard row.
  IF v_mode = 'apply' THEN
    SELECT count(*) INTO v_bad
    FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE m.superseded_at IS NOT NULL
       OR m.superseded_by_match_id IS NOT NULL
       OR m.supersede_reason IS NOT NULL
       OR m.supersede_operation_id IS NOT NULL;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'STOP: % stage-2 rows carry stale supersession fields before execution', v_bad;
    END IF;
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
  WHERE t.role = 'candidate'
    AND t.accountant_decision = 'RETIRE'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
  ORDER BY m.id
  FOR UPDATE;

  -- The survivor is the committed-basis survivor (t.survivor_id), never a
  -- value from the authorization manifest.
  UPDATE public.reconciliation_matches m SET
    superseded_at = now(),
    superseded_by_match_id = t.survivor_id,
    supersede_reason = t.reason,
    supersede_operation_id = '{STAGE2_OPERATION_ID}'
  FROM zaki_manifest t
  WHERE t.role = 'candidate'
    AND t.accountant_decision = 'RETIRE'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
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
    {previous_state},
    {resulting_state},
    {evidence}
  FROM zaki_manifest t
  JOIN public.reconciliation_matches m ON m.id = t.match_id
  WHERE t.role = 'candidate'
    AND t.accountant_decision = 'RETIRE'
    AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
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
    ((SELECT match_id FROM zaki_s1_manifest WHERE role = 'target')
     UNION ALL
     (SELECT match_id FROM zaki_manifest
      WHERE role = 'candidate' AND accountant_decision = 'RETIRE'
        AND authorization_status = 'APPROVED_FOR_RETIREMENT'))
    EXCEPT
    (SELECT id FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'FAIL: an authorized or stage-1 target is not superseded';
  END IF;
  IF EXISTS (
    (SELECT id FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL)
    EXCEPT
    ((SELECT match_id FROM zaki_s1_manifest WHERE role = 'target')
     UNION ALL
     (SELECT match_id FROM zaki_manifest
      WHERE role = 'candidate' AND accountant_decision = 'RETIRE'
        AND authorization_status = 'APPROVED_FOR_RETIREMENT'))
  ) THEN
    RAISE EXCEPTION 'FAIL: a row outside the authorized sets was superseded';
  END IF;

  -- 2. Every superseded row carries the correct operation, reason, survivor.
  IF EXISTS (
    SELECT 1 FROM zaki_s1_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'target'
      AND m.supersede_operation_id IS DISTINCT FROM '{STAGE1_OPERATION_ID}'
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 target lost its operation id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'candidate'
      AND t.accountant_decision = 'RETIRE'
      AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
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
    (SELECT match_id FROM zaki_s1_manifest WHERE role = 'target')
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 audit row exists for a non-target';
  END IF;
  IF EXISTS (
    (SELECT reconciliation_match_id FROM public.reconciliation_audit_log
     WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE2_OPERATION_ID}')
    EXCEPT
    (SELECT match_id FROM zaki_manifest
     WHERE role = 'candidate' AND accountant_decision = 'RETIRE'
       AND authorization_status = 'APPROVED_FOR_RETIREMENT')
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-2 audit row exists for a non-authorized row';
  END IF;
  IF EXISTS (
    (SELECT match_id FROM zaki_s1_manifest WHERE role = 'target')
    EXCEPT
    (SELECT reconciliation_match_id FROM public.reconciliation_audit_log
     WHERE action = '{AUDIT_ACTION}' AND operation_id = '{STAGE1_OPERATION_ID}')
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-1 target lacks its repair audit row';
  END IF;
  IF EXISTS (
    (SELECT match_id FROM zaki_manifest
     WHERE role = 'candidate' AND accountant_decision = 'RETIRE'
       AND authorization_status = 'APPROVED_FOR_RETIREMENT')
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

  -- 4. FULL AUDIT IDEMPOTENCY (Phase 8): every stage-2 repair audit row must
  --    record the confirming accountant and carry the byte-exact expected
  --    evidence (incl. manifest hashes, environment mode, artifact identity,
  --    stage-1 artifact/proof hashes). An altered audit row is an ABORT,
  --    never a silent no-op.
  IF EXISTS (
    SELECT 1
    FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    JOIN public.reconciliation_audit_log a
      ON a.reconciliation_match_id = t.match_id
     AND a.action = '{AUDIT_ACTION}'
     AND a.operation_id = '{STAGE2_OPERATION_ID}'
    WHERE t.role = 'candidate'
      AND t.accountant_decision = 'RETIRE'
      AND t.authorization_status = 'APPROVED_FOR_RETIREMENT'
      AND (a.action_by IS NULL
           OR a.action_by = '{STAGE1_ACTOR}'
           OR NOT ({ev_match}))
  ) THEN
    RAISE EXCEPTION 'FAIL: a stage-2 repair audit row does not carry the confirming accountant identity or carries altered evidence';
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

  -- 6. Non-executed candidates remain untouched and live, with their exact
  --    approval stamps.
  IF EXISTS (
    SELECT 1 FROM zaki_manifest t
    JOIN public.reconciliation_matches m ON m.id = t.match_id
    WHERE t.role = 'candidate'
      AND NOT (t.accountant_decision = 'RETIRE'
               AND t.authorization_status = 'APPROVED_FOR_RETIREMENT')
      AND (m.superseded_at IS NOT NULL
           OR m.approved_at IS DISTINCT FROM t.approved_at
           OR m.approved_by IS DISTINCT FROM t.approved_by
           OR m.confidence IS DISTINCT FROM t.confidence)
  ) THEN
    RAISE EXCEPTION 'FAIL: a non-authorized candidate was superseded or modified';
  END IF;

  -- 7. R6 pair integrity: at most one member of each R6 pair is superseded
  --    by this operation, and every basis endpoint keeps at least one live
  --    automatic row.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT t.qb_id
      FROM zaki_manifest t
      JOIN public.reconciliation_matches m ON m.id = t.match_id
      WHERE t.class = 'R6'
        AND m.superseded_at IS NOT NULL
        AND m.supersede_operation_id = '{STAGE2_OPERATION_ID}'
      GROUP BY t.qb_id
      HAVING count(*) > 1
    ) d
  ) THEN
    RAISE EXCEPTION 'FAIL: an R6 pair has more than one member retired by stage 2';
  END IF;
  -- R5 (synthetic test rows) legitimately ends with ZERO live rows; R3 and
  -- R6 endpoints must keep their survivor.
  IF EXISTS (
    SELECT 1
    FROM (SELECT DISTINCT qb_id FROM zaki_manifest
          WHERE class IN ('R3', 'R6')) e
    WHERE (SELECT count(*) FROM public.reconciliation_matches m
           WHERE m.qb_transaction_id = e.qb_id
             AND m.superseded_at IS NULL) < 1
  ) THEN
    RAISE EXCEPTION 'FAIL: a basis endpoint lost all of its live rows';
  END IF;

  IF v_mode = 'apply' THEN
    -- 8. Global invariants + exact counts.
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

    -- 9. Exact remaining duplicate-endpoint set.
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
    RAISE NOTICE 'STAGE 2: ALREADY APPLIED — verified % authorized rows carry this operation with correct fields and byte-exact audit evidence; no-op commit', {n_exec};
  END IF;
END;
$post$;

COMMIT;
"""
    return s2


# Decision columns appended to candidate rows for the stage-2 manifest load.
AUTH_ROW_HEADER = CORE_HEADER + [
    "accountant_decision", "accountant_identity", "confirmation_timestamp",
    "authorization_status", "accountant_note",
]


def auth_row_values(rows):
    return sql_values(AUTH_ROW_HEADER, rows)


def join_decisions(basis_rows, decisions):
    """Fill decision columns on basis rows from the validated manifest.

    Returns (candidates, guards) with decision fields. Rows without a
    decision carry NULL decision columns (asserted untouched).
    """
    by_id = {d["match_id"]: d for d in decisions}
    out = []
    for r in basis_rows:
        row = dict(r)
        d = by_id.get(r["match_id"])
        if d is not None:
            row["accountant_decision"] = d["decision"]
            row["accountant_identity"] = d["accountant_identity"]
            row["confirmation_timestamp"] = d["confirmation_timestamp"]
            row["authorization_status"] = (
                "APPROVED_FOR_RETIREMENT"
                if d["decision"] == "RETIRE"
                else d["decision"]
            )
            row["accountant_note"] = d.get("note") or ""
        else:
            for c in ("accountant_decision", "accountant_identity",
                      "confirmation_timestamp", "authorization_status",
                      "accountant_note"):
                row[c] = ""
        out.append(row)
    candidates = [r for r in out if r["role"] == "candidate"]
    guards = [r for r in out if r["role"] == "survivor_guard"]
    return candidates, guards


# ---------------------------------------------------------------------------
# manifests subcommand
# ---------------------------------------------------------------------------

MANIFEST_FILES = [
    "duplicate-endpoints.csv",
    "stage1-unapproved-targets.csv",
    "stage2-approved-candidates.csv",
    "r6-review.csv",
    "stage2-immutable-basis.json",
    "stage2-test-decisions.json",
    "stage2-authorization-manifest-template.json",
    "stage2-rehearsal-authorization-manifest.json",
]


def cmd_manifests(snapshot_dir, out_dir):
    snap = load_snapshot(snapshot_dir)
    (s1t, s1g, s2c, s2g, dup_eps, dup_after_s1, r6) = build_rows(snap)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # 1. Duplicate-endpoint inventory (107 rows).
    write_csv(out / "duplicate-endpoints.csv", DUP_ENDPOINTS_HEADER, dup_eps)

    # 2. Stage-1 manifest: 154 targets + 101 survivor guards.
    write_csv(
        out / "stage1-unapproved-targets.csv",
        CORE_HEADER, s1t + s1g,
    )

    # 3. Committed stage-2 immutable basis (189 rows: 102 decision-permitted
    #    candidates + 87 survivor guards) — the authorization contract.
    basis_rows = build_basis_rows(s2c, s2g)
    write_json(out / "stage2-immutable-basis.json", basis_document(basis_rows))

    # 4. Stage-2 candidate inventory (102 decision-permitted rows, no
    #    decisions; permitted survivor/decision sets are committed columns).
    candidates_csv = []
    for r in basis_rows:
        if r["role"] != "candidate":
            continue
        row = dict(r)
        row["permitted_survivor_match_ids"] = ";".join(
            r["permitted_survivor_match_ids"])
        row["permitted_decisions"] = ";".join(r["permitted_decisions"])
        candidates_csv.append(row)
    write_csv(
        out / "stage2-approved-candidates.csv",
        CANDIDATES_HEADER, candidates_csv,
    )

    # 5. R6 human-review rows (4 endpoints).
    write_csv(out / "r6-review.csv", R6_HEADER, r6)

    # 6. REHEARSAL test choices (the fixed 98 decisions, no identity/ts).
    test_decisions = build_test_decisions(r6, s2c)
    write_json(out / "stage2-test-decisions.json", {
        "package": "repair-013-pre",
        "test_decisions_schema_version": 1,
        "choices": test_decisions,
    })

    # 7. Authorization-manifest TEMPLATE (empty decisions, REHEARSAL mode).
    #    The basis hash is filled after the basis sha is computed below.
    write_json(out / "stage2-authorization-manifest-template.json",
               auth_manifest_document("", "REHEARSAL", []))

    # 8. REHEARSAL-ONLY test authorization manifest (all 98 signed with a
    #    clearly marked test identity and a fixed timestamp). Documentation
    #    of the rehearsal choices; the rehearsal chain re-stamps a fresh
    #    confirmation timestamp via the rehearsal-manifest subcommand so the
    #    post-stage-1 ordering check is exercised at run time.
    rehearsal_decisions = []
    for d in test_decisions:
        rehearsal_decisions.append({
            "match_id": d["match_id"],
            "decision": d["decision"],
            "accountant_identity": TEST_ACCOUNTANT,
            "confirmation_timestamp": TEST_CONFIRMATION_TS,
            "note": d.get("note", ""),
        })
    write_json(out / "stage2-rehearsal-authorization-manifest.json",
               auth_manifest_document("", "REHEARSAL", rehearsal_decisions))

    # The basis sha is needed by the two JSON manifests; compute after the
    # basis file is on disk, then rewrite them.
    basis_sha = sha256_file(out / "stage2-immutable-basis.json")
    write_json(out / "stage2-authorization-manifest-template.json",
               auth_manifest_document(basis_sha, "REHEARSAL", []))
    write_json(out / "stage2-rehearsal-authorization-manifest.json",
               auth_manifest_document(basis_sha, "REHEARSAL",
                                      rehearsal_decisions))

    # 9. Identity registry.
    def manifest_row_count(name):
        path = out / name
        if name.endswith(".csv"):
            return len(read_csv(path))
        doc = json.load(open(path, encoding="utf-8"))
        for key in ("rows", "choices", "decisions"):
            if isinstance(doc.get(key), list):
                return len(doc[key])
        return 0

    identities = {
        "package": {
            "stage1_operation_id": STAGE1_OPERATION_ID,
            "stage2_operation_id": STAGE2_OPERATION_ID,
            "snapshot_provenance": {
                name: {"sha256": h} for name, h in snap["hashes"].items()
            },
            "accepted_classification": EXPECTED,
            "production_project_ref": PROD_PROJECT_REF,
        },
        "manifests": {
            name: {
                "sha256": sha256_file(out / name),
                "rows": manifest_row_count(name),
            }
            for name in MANIFEST_FILES
        },
    }
    with open(out / "manifest-identities.json", "w", encoding="utf-8") as f:
        json.dump(identities, f, indent=2)
        f.write("\n")

    print(f"manifests written to {out}")
    for name, meta in identities["manifests"].items():
        print(f"  {name}: {meta['rows']} rows  sha256={meta['sha256'][:16]}…")


# ---------------------------------------------------------------------------
# sql subcommand (REHEARSAL-only regeneration of the committed working copies)
# ---------------------------------------------------------------------------

def cmd_sql(auth_manifest, snapshot_dir):
    """Regenerate the committed 14a/14b working copies (REHEARSAL mode).

    --auth-manifest is REQUIRED: there is no default authorization input —
    omitting it fails closed. Reads only COMMITTED files (never the
    snapshot): the stage-2 build is a function of the committed basis and
    the supplied authorization manifest.
    """
    if not auth_manifest:
        raise SystemExit(
            "sql requires --auth-manifest <path>: missing authorization "
            "input fails closed (there is no default manifest)"
        )
    pkg = load_committed_package()
    package_sha = execution_package_sha256()
    decisions, auth_manifest_sha = validate_auth_manifest(
        auth_manifest, "REHEARSAL"
    )
    s2c_rows, s2g_rows = join_decisions(pkg["basis_rows"], decisions)
    n_exec = sum(
        1 for d in decisions if d.get("decision") == "RETIRE"
    )

    mode = "REHEARSAL"
    project_ref = None
    identity = artifact_identity_stage1(
        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"], package_sha,
        project_ref,
    )
    s1_sql = stage1_sql(
        pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
        pkg["stage1_manifest_sha"], pkg["basis_sha"], mode, project_ref,
        identity, package_sha,
    )
    SQL_STAGE1.write_text(s1_sql, encoding="utf-8")
    # The stage-2 working copy binds the stage-1 artifact it sequences on
    # (the sha of the exact 14a file just written; an operator runs a FROZEN
    # stage-1 artifact — see `freeze`) and carries an EMPTY stage-1 receipt
    # sha placeholder: the receipt can only exist in a database after a real
    # stage-1 execution, so the committed working copy is a deterministic
    # pre-execution staging artifact. Per-run frozen stage-2 artifacts bind
    # the executed manifest and the real database receipt (freeze +
    # --stage1-receipt) and are verified via `verify --artifact`.
    stage1_artifact_sha = sha256_file(SQL_STAGE1)
    receipt_sha = ""
    identity2 = artifact_identity_stage2(
        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"],
        auth_manifest_sha, stage1_artifact_sha, receipt_sha, package_sha,
        project_ref,
    )
    s2_sql = stage2_sql(
        s2c_rows, s2g_rows, pkg["s1t"], pkg["s1g"], pkg["dup_after_s1"],
        auth_manifest_sha, pkg["basis_sha"], stage1_artifact_sha,
        receipt_sha, package_sha, mode, project_ref, identity2, n_exec,
        stage1_manifest_sha=pkg["stage1_manifest_sha"],
    )

    SQL_STAGE2.write_text(s2_sql, encoding="utf-8")
    print(f"wrote {SQL_STAGE1} (REHEARSAL, artifact identity {identity[:16]}…)")
    print(f"wrote {SQL_STAGE2} (REHEARSAL, authorization manifest "
          f"sha256={auth_manifest_sha[:16]}…, {n_exec} authorized)")
    print("note: these working copies are REHEARSAL-mode documentation "
          "artifacts; execution uses `freeze` + the hash-verified runner.")


# ---------------------------------------------------------------------------
# freeze subcommand (immutable execution artifact + freeze record)
# ---------------------------------------------------------------------------

def _freeze_record_doc(stage, mode, artifact_file, artifact_sha,
                       artifact_identity, stage1_manifest_sha, basis_sha,
                       auth_manifest_sha, stage1_artifact_sha, receipt_sha,
                       receipt_canonical_sha, execution_package_sha,
                       project_ref, frozen_at, receipt=None):
    doc = {
        "package": "repair-013-pre",
        "freeze_schema_version": 1,
        "stage": stage,
        "environment_mode": mode,
        "artifact_file": artifact_file,
        "artifact_sha256": artifact_sha,
        "artifact_identity": artifact_identity,
        "stage1_operation_id": STAGE1_OPERATION_ID,
        "stage2_operation_id": STAGE2_OPERATION_ID,
        "stage1_manifest_sha256": stage1_manifest_sha,
        "stage2_basis_sha256": basis_sha,
        "execution_package_sha256": execution_package_sha,
        "project_ref": project_ref or "-",
        "frozen_at": frozen_at,
    }
    if stage == 2:
        doc["authorization_manifest_sha256"] = auth_manifest_sha
        doc["stage1_artifact_sha256"] = stage1_artifact_sha
        doc["stage1_receipt_sha256"] = receipt_sha
        doc["stage1_receipt_canonical_sha256"] = receipt_canonical_sha
        if receipt is not None:
            doc["stage1_receipt_target_digest_sha256"] = (
                receipt["target_digest_sha256"])
            doc["stage1_receipt_survivor_mapping_digest_sha256"] = (
                receipt["survivor_mapping_digest_sha256"])
            doc["stage1_receipt_audit_digest_sha256"] = (
                receipt["audit_digest_sha256"])
            doc["stage1_receipt_postcondition_digest_sha256"] = (
                receipt["postcondition_digest_sha256"])
    return doc


def cmd_freeze(stage, mode, auth_manifest, stage1_artifact,
               stage1_receipt, project_ref, out_dir, frozen_at):
    if stage not in (1, 2):
        raise SystemExit("freeze --stage must be 1 or 2")
    if mode not in MODES:
        raise SystemExit(f"--environment-mode must be one of {MODES}")

    if mode == "PRODUCTION":
        if project_ref != PROD_PROJECT_REF:
            raise SystemExit(
                f"PRODUCTION freeze requires --project-ref "
                f"{PROD_PROJECT_REF} (got {project_ref!r}); production "
                f"artifacts bind to the exact project identity"
            )
        if not frozen_at:
            frozen_at = datetime.datetime.now(
                datetime.timezone.utc).isoformat(timespec="seconds")
    else:
        project_ref = None
        if not frozen_at:
            frozen_at = datetime.datetime.now(
                datetime.timezone.utc).isoformat(timespec="seconds")

    pkg = load_committed_package()
    package_sha = execution_package_sha256()

    receipt_sha = ""
    receipt_canonical_sha = ""
    auth_manifest_sha = ""
    decisions = []
    if stage == 2:
        if not auth_manifest:
            raise SystemExit(
                "freeze --stage 2 requires --auth-manifest <path>: missing "
                "authorization input fails closed"
            )
        if not stage1_artifact or not stage1_receipt:
            raise SystemExit(
                "freeze --stage 2 requires --stage1-artifact <frozen 14a> "
                "and --stage1-receipt <receipt-export.json>: stage-2 "
                "authorization is only buildable after the stage-1 "
                "database-side checkpoint (a caller-created stage-1 proof "
                "JSON is operator evidence only, never the authorization "
                "root)"
            )
        # Independently revalidate every derivable field of the receipt
        # export against the committed manifests AND the byte-identical
        # frozen stage-1 artifact. NOTE: this is CONSISTENCY validation of
        # the operator evidence — the actual authorization is the immutable
        # DATABASE-SIDE receipt row, revalidated by the stage-2 artifact
        # itself before any stage-2 work (Codex finding 1).
        receipt = load_stage1_receipt(stage1_receipt, mode, stage1_artifact)
        receipt_sha = sha256_file(stage1_receipt)
        receipt_canonical_sha = receipt["receipt_sha256"]
        decisions, auth_manifest_sha = validate_auth_manifest(
            auth_manifest, mode, receipt=receipt
        )
        if not decisions:
            raise SystemExit(
                "authorization manifest contains no decisions; refusing to "
                "freeze a stage-2 artifact that could do nothing (explicit "
                "authorization required)"
            )
        stage1_artifact_sha = sha256_file(stage1_artifact)
        s2c_rows, s2g_rows = join_decisions(pkg["basis_rows"], decisions)
        n_exec = sum(1 for d in decisions if d.get("decision") == "RETIRE")
        identity = artifact_identity_stage2(
            mode, pkg["stage1_manifest_sha"], pkg["basis_sha"],
            auth_manifest_sha, stage1_artifact_sha, receipt_canonical_sha,
            package_sha, project_ref,
        )
        sql = stage2_sql(
            s2c_rows, s2g_rows, pkg["s1t"], pkg["s1g"], pkg["dup_after_s1"],
            auth_manifest_sha, pkg["basis_sha"], stage1_artifact_sha,
            receipt_canonical_sha, package_sha, mode, project_ref, identity,
            n_exec, stage1_manifest_sha=pkg["stage1_manifest_sha"],
        )
        stem = f"14b-stage2-approved-repair-{mode}-{auth_manifest_sha[:12]}"
    else:
        if auth_manifest or stage1_artifact or stage1_receipt:
            raise SystemExit(
                "freeze --stage 1 does not accept --auth-manifest/"
                "--stage1-artifact/--stage1-receipt"
            )
        identity = artifact_identity_stage1(
            mode, pkg["stage1_manifest_sha"], pkg["basis_sha"], package_sha,
            project_ref,
        )
        sql = stage1_sql(
            pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
            pkg["stage1_manifest_sha"], pkg["basis_sha"], mode, project_ref,
            identity, package_sha,
        )
        stem = f"14a-stage1-unapproved-repair-{mode}-{pkg['stage1_manifest_sha'][:12]}"

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    artifact_path = out / f"{stem}.sql"
    record_path = out / f"freeze-{stem}.json"

    artifact_sha = sha256_text(sql)
    if artifact_path.exists():
        raise SystemExit(
            f"refusing to overwrite frozen artifact {artifact_path} — "
            f"stage artifacts are immutable once frozen"
        )
    if record_path.exists():
        raise SystemExit(
            f"refusing to overwrite freeze record {record_path}"
        )
    artifact_path.write_text(sql, encoding="utf-8")
    record = _freeze_record_doc(
        stage, mode, artifact_path.name, sha256_file(artifact_path),
        identity, pkg["stage1_manifest_sha"], pkg["basis_sha"],
        auth_manifest_sha, stage1_artifact_sha if stage == 2 else "",
        receipt_sha, receipt_canonical_sha, package_sha, project_ref,
        frozen_at, receipt=receipt if stage == 2 else None,
    )
    write_json(record_path, record)
    print(f"frozen artifact: {artifact_path}")
    print(f"  sha256:        {sha256_file(artifact_path)}")
    print(f"  identity:      {identity}")
    print(f"  mode:          {mode}")
    print(f"  frozen at:     {frozen_at}")
    if stage == 2:
        print(f"  authorized:    {n_exec} rows")
        print(f"  basis:         {pkg['basis_sha']}")
        print(f"  manifest:      {auth_manifest_sha}")
        print(f"  stage-1 receipt (file sha): {receipt_sha}")
        print(f"  stage-1 receipt (db canonical): {receipt_canonical_sha}")
    print(f"freeze record:  {record_path}")


# ---------------------------------------------------------------------------
# verify subcommand
# ---------------------------------------------------------------------------

def verify_frozen_artifact(record_path, stage1_artifact=None,
                           auth_manifest=None, stage1_receipt=None):
    """INDEPENDENT frozen-artifact verification (blocker 3).

    Never trusts "SQL + freeze record together": the verifier re-reads the
    immutable candidate basis, the authorization manifest, and the stage-1
    receipt export, REGENERATES the expected artifact bytes into a
    temporary location, and requires byte-identity with the frozen artifact
    before recomputing its SHA-256 against the freeze record. A coordinated
    modification of both the SQL and the freeze record therefore still
    fails, because the regenerated bytes derive from the committed
    manifests alone.
    """
    try:
        record = json.load(open(record_path, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"freeze record unreadable: {e}")
    errors = []
    if record.get("freeze_schema_version") != 1:
        errors.append("unsupported freeze record schema version")
    artifact_file = record.get("artifact_file") or ""
    artifact_path = Path(record_path).resolve().parent / artifact_file
    stage = record.get("stage")
    mode = record.get("environment_mode")
    pkg = load_committed_package()
    package_sha = execution_package_sha256()

    if stage not in (1, 2):
        errors.append(f"freeze record has invalid stage {stage!r}")
    elif mode not in MODES:
        errors.append(f"freeze record has invalid mode {mode!r}")
    else:
        project_ref = None
        if mode == "PRODUCTION":
            if record.get("project_ref") != PROD_PROJECT_REF:
                errors.append("PRODUCTION freeze record carries the wrong project_ref")
            project_ref = record.get("project_ref")

        # 1. Read the exact committed authorization inputs (stage 2).
        decisions = []
        auth_manifest_sha = ""
        receipt_sha = ""
        stage1_artifact_sha = ""
        receipt = None
        if stage == 2:
            for flag, val in (("--stage1-artifact", stage1_artifact),
                              ("--auth-manifest", auth_manifest),
                              ("--stage1-receipt", stage1_receipt)):
                if not val:
                    errors.append(
                        f"stage-2 artifact verification requires {flag}")
                    break
            if stage1_artifact and auth_manifest and stage1_receipt:
                if sha256_file(stage1_artifact) != record.get("stage1_artifact_sha256"):
                    errors.append(
                        "stage-1 artifact sha does not match the freeze record")
                if sha256_file(stage1_receipt) != record.get("stage1_receipt_sha256"):
                    errors.append(
                        "stage-1 receipt export sha does not match the freeze record")
                else:
                    try:
                        receipt = load_stage1_receipt(
                            stage1_receipt, mode, stage1_artifact)
                    except SystemExit as e:
                        errors.append(str(e))
                    receipt_sha = sha256_file(stage1_receipt)
                try:
                    decisions, auth_manifest_sha = validate_auth_manifest(
                        auth_manifest, mode, receipt=receipt)
                except SystemExit as e:
                    errors.append(str(e))
                if auth_manifest_sha != record.get("authorization_manifest_sha256"):
                    errors.append(
                        "authorization manifest sha does not match the freeze record")
                stage1_artifact_sha = sha256_file(stage1_artifact)

        if stage == 1:
            if record.get("stage1_manifest_sha256") != pkg["stage1_manifest_sha"]:
                errors.append("freeze record stage-1 manifest sha does not match the committed manifest")
            if record.get("stage2_basis_sha256") != pkg["basis_sha"]:
                errors.append("freeze record basis sha does not match the committed basis")

        # 1b. The freeze record must bind the exact current execution
        #     package (stable content-based identity).
        if record.get("execution_package_sha256") != package_sha:
            errors.append(
                "freeze record execution_package_sha256 does not match the "
                "current EXECUTION_PACKAGE_SHA256 of the checked-out "
                "package files")

        # 2. Regenerate the expected artifact bytes into a temporary
        #    location (from committed files + validated authorization inputs
        #    only) and require BYTE-IDENTITY with the frozen artifact.
        if not errors and artifact_path.exists():
            with tempfile.TemporaryDirectory() as tmp:
                regen_path = Path(tmp) / "regen.sql"
                if stage == 1:
                    identity = artifact_identity_stage1(
                        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"],
                        package_sha, project_ref)
                    regen = stage1_sql(
                        pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
                        pkg["stage1_manifest_sha"], pkg["basis_sha"], mode,
                        project_ref, identity, package_sha)
                else:
                    identity = artifact_identity_stage2(
                        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"],
                        auth_manifest_sha, stage1_artifact_sha,
                        receipt["receipt_sha256"], package_sha, project_ref)
                    s2c_rows, s2g_rows = join_decisions(
                        pkg["basis_rows"], decisions)
                    n_exec = sum(
                        1 for d in decisions
                        if d.get("decision") == "RETIRE")
                    regen = stage2_sql(
                        s2c_rows, s2g_rows, pkg["s1t"], pkg["s1g"],
                        pkg["dup_after_s1"], auth_manifest_sha,
                        pkg["basis_sha"], stage1_artifact_sha,
                        receipt["receipt_sha256"], package_sha, mode,
                        project_ref, identity, n_exec,
                        stage1_manifest_sha=pkg["stage1_manifest_sha"])
                regen_path.write_text(regen, encoding="utf-8")
                frozen_bytes = artifact_path.read_bytes()
                regen_bytes = regen_path.read_bytes()
                if frozen_bytes != regen_bytes:
                    errors.append(
                        "frozen artifact is NOT byte-identical to the "
                        "independent regeneration from the committed basis + "
                        "authorization inputs (coordinated or unilateral "
                        "tampering rejected)")
                if identity != record.get("artifact_identity"):
                    errors.append(
                        "recomputed artifact identity does not match the "
                        "freeze record")
        elif not artifact_path.exists():
            errors.append(f"frozen artifact missing: {artifact_path}")

        # 3. Recompute the SHA-256 and require the freeze record to match.
        if artifact_path.exists() and not errors:
            got = sha256_file(artifact_path)
            if got != record.get("artifact_sha256"):
                errors.append(
                    f"frozen artifact sha256 {got} != freeze record "
                    f"{record.get('artifact_sha256')}")

        # 4. Bound hashes/identities recorded vs recomputed (stage 2).
        if stage == 2 and not errors:
            if record.get("stage1_manifest_sha256") != pkg["stage1_manifest_sha"]:
                errors.append("freeze record stage-1 manifest sha does not match the committed manifest")
            if record.get("stage2_basis_sha256") != pkg["basis_sha"]:
                errors.append("freeze record basis sha does not match the committed basis")
            if receipt is not None:
                if record.get("stage1_receipt_canonical_sha256") != receipt["receipt_sha256"]:
                    errors.append("freeze record stage-1 receipt canonical sha differs from the validated receipt export")
                if record.get("stage1_receipt_target_digest_sha256") != receipt["target_digest_sha256"]:
                    errors.append("freeze record stage-1 receipt target digest differs from the validated receipt export")
                if record.get("stage1_receipt_survivor_mapping_digest_sha256") != receipt["survivor_mapping_digest_sha256"]:
                    errors.append("freeze record stage-1 receipt survivor-mapping digest differs from the validated receipt export")
                if record.get("stage1_receipt_audit_digest_sha256") != receipt["audit_digest_sha256"]:
                    errors.append("freeze record stage-1 receipt audit digest differs from the validated receipt export")
                if record.get("stage1_receipt_postcondition_digest_sha256") != receipt["postcondition_digest_sha256"]:
                    errors.append("freeze record stage-1 receipt postcondition digest differs from the validated receipt export")

    if errors:
        print("VERIFY FAILED:")
        for e in errors:
            print(f"  - {e}")
        raise SystemExit("; ".join(errors))
    print(f"VERIFY OK: frozen artifact {artifact_path.name} is byte-identical "
          f"to an independent regeneration, SHA-256 verified, and fully "
          f"bound (identity {record.get('artifact_identity', '')[:16]}…, "
          f"mode {record.get('environment_mode')}).")


def cmd_verify(snapshot_dir, auth_manifest=None, artifact=None,
               stage1_artifact=None, stage1_receipt=None):
    if artifact:
        verify_frozen_artifact(
            artifact, stage1_artifact=stage1_artifact,
            auth_manifest=auth_manifest, stage1_receipt=stage1_receipt,
        )
        return
    if not auth_manifest:
        raise SystemExit(
            "verify requires --auth-manifest <path> for the stage-2 SQL "
            "binding (no default authorization input) or --artifact "
            "<freeze.json> for a frozen artifact"
        )
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

    # 3. Classification + committed basis still reproducible from the
    #    snapshot (byte-identical regeneration).
    if snap_dir.exists():
        try:
            snap = load_snapshot(str(snap_dir))
            (s1t, s1g, s2c, s2g, dup_eps, dup_after_s1, r6) = build_rows(snap)
            regen_basis = basis_document(build_basis_rows(s2c, s2g))
            committed_basis = json.load(open(BASIS_PATH, encoding="utf-8"))
            if regen_basis != committed_basis:
                errors.append(
                    "committed stage-2 basis is not byte-identical to a "
                    "regeneration from the accepted snapshot"
                )
            regen_decisions = build_test_decisions(r6, s2c)
            committed_decisions = json.load(
                open(TEST_DECISIONS_PATH, encoding="utf-8")
            ).get("choices")
            if regen_decisions != committed_decisions:
                errors.append(
                    "committed stage-2 test decisions are not byte-identical "
                    "to a regeneration from the accepted snapshot"
                )
        except SystemExit as e:
            errors.append(f"classification re-derivation failed: {e}")

    # 4. Stage-1 SQL binds the current stage-1 manifest hash, the committed
    #    basis hash, the REHEARSAL gate, and the fixed operation ids — and
    #    is byte-identical to a regeneration.
    s1 = SQL_STAGE1.read_text(encoding="utf-8")
    want_sha = identities["manifests"]["stage1-unapproved-targets.csv"]["sha256"]
    if want_sha not in s1:
        errors.append("stage-1 SQL does not embed the current stage-1 manifest hash")
    for op in (STAGE1_OPERATION_ID,):
        if op not in s1:
            errors.append(f"stage-1 SQL missing operation id {op}")
    if MODE_GATE_REHEARSAL_MARK not in s1:
        errors.append("stage-1 SQL missing the REHEARSAL environment-mode gate")

    # 5. Stage-2 SQL binds the authorization manifest it was generated from
    #    (the explicit --auth-manifest), the committed basis, and the
    #    REHEARSAL gate.
    s2 = SQL_STAGE2.read_text(encoding="utf-8")
    auth_path = Path(auth_manifest)
    auth_sha = sha256_file(auth_path)
    if auth_sha not in s2:
        errors.append(
            f"stage-2 SQL does not embed the hash of {auth_manifest} "
            f"({auth_sha})"
        )
    if MODE_GATE_REHEARSAL_MARK not in s2:
        errors.append("stage-2 SQL missing the REHEARSAL environment-mode gate")
    if STAGE2_OPERATION_ID not in s2:
        errors.append("stage-2 SQL missing operation id " + STAGE2_OPERATION_ID)
    if STAGE1_OPERATION_ID not in s2:
        errors.append("stage-2 SQL missing the stage-1 sequencing operation id")

    # 6. Determinism: regenerating both SQL files from the committed package
    #    files must be byte-identical (Codex finding 3 / fix D). The
    #    working copies bind the stable EXECUTION_PACKAGE_SHA256 (never git
    #    HEAD, which evidence commits change) and the stage-2 working copy
    #    is generated from the FIXED committed test authorization manifest
    #    with an empty receipt-sha placeholder — it is a deterministic
    #    pre-execution staging/documentation artifact; per-run frozen
    #    artifacts (bound to the executed manifest + real DB receipt) are
    #    verified with `verify --artifact` against their freeze records.
    pkg = load_committed_package()
    package_sha = execution_package_sha256()
    decisions, _ = validate_auth_manifest(auth_manifest, "REHEARSAL")
    s2c_rows, s2g_rows = join_decisions(pkg["basis_rows"], decisions)
    n_exec = sum(1 for d in decisions if d.get("decision") == "RETIRE")
    mode = "REHEARSAL"
    stage1_artifact_sha = sha256_file(SQL_STAGE1)
    identity1 = artifact_identity_stage1(
        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"], package_sha,
        None,
    )
    regen1 = stage1_sql(
        pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
        pkg["stage1_manifest_sha"], pkg["basis_sha"], mode, None, identity1,
        package_sha,
    )
    identity2 = artifact_identity_stage2(
        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"], auth_sha,
        stage1_artifact_sha, "", package_sha, None,
    )
    regen2 = stage2_sql(
        s2c_rows, s2g_rows, pkg["s1t"], pkg["s1g"], pkg["dup_after_s1"],
        auth_sha, pkg["basis_sha"], stage1_artifact_sha, "", package_sha,
        mode, None, identity2, n_exec,
        stage1_manifest_sha=pkg["stage1_manifest_sha"],
    )
    if regen1 != s1:
        errors.append("stage-1 SQL is not byte-identical to a regeneration")
    if regen2 != s2:
        errors.append("stage-2 SQL is not byte-identical to a regeneration")

    # 7. Both working copies must embed the current stable execution
    #    package sha (the binding that survives evidence-only commits).
    if package_sha not in s1:
        errors.append("stage-1 SQL does not embed the current EXECUTION_PACKAGE_SHA256")
    if package_sha not in s2:
        errors.append("stage-2 SQL does not embed the current EXECUTION_PACKAGE_SHA256")

    if errors:
        print("VERIFY FAILED:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("VERIFY OK: manifests, hashes, classification, committed basis, "
          "and SQL binding all consistent.")


# ---------------------------------------------------------------------------
# rehearsal-manifest subcommand
# ---------------------------------------------------------------------------

def cmd_package_sha():
    """Print the stable EXECUTION_PACKAGE_SHA256 and the per-file digest
    lines it is computed from (sha256sum format, sorted file list — see
    EXECUTION_PACKAGE.md)."""
    lines = []
    for rel in EXECUTION_PACKAGE_FILES:
        p = ROOT / rel
        if not p.is_file():
            raise SystemExit(
                f"execution-package file missing: {rel} — the package "
                f"identity is incomplete"
            )
        lines.append(f"{sha256_file(p)}  {rel}")
    total = execution_package_sha256()
    for line in lines:
        print(line)
    print(f"EXECUTION_PACKAGE_SHA256: {total}")


def cmd_rehearsal_manifest(confirmation_timestamp, identity, out_path):
    """Generate the per-run REHEARSAL authorization manifest from the
    committed test-decisions list, stamped with a fresh confirmation
    timestamp. The rehearsal chain calls this AFTER the stage-1 database
    receipt exists, so the post-stage-1 ordering check is genuinely
    exercised."""
    pkg = load_committed_package()
    try:
        test = json.load(open(TEST_DECISIONS_PATH, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"test decisions unreadable: {e}")
    choices = test.get("choices")
    if not isinstance(choices, list) or len(choices) != EXPECTED["stage2_retireable"]:
        raise SystemExit("committed test decisions are malformed")
    decisions = []
    for c in choices:
        decisions.append({
            "match_id": c["match_id"],
            "decision": c["decision"],
            "accountant_identity": identity or TEST_ACCOUNTANT,
            "confirmation_timestamp": confirmation_timestamp,
            "note": c.get("note", ""),
        })
    doc = auth_manifest_document(pkg["basis_sha"], "REHEARSAL", decisions)
    write_json(Path(out_path), doc)
    print(f"wrote {out_path} "
          f"(REHEARSAL, {len(decisions)} test decisions, "
          f"confirmation_timestamp={confirmation_timestamp}, "
          f"sha256={sha256_file(Path(out_path))[:16]}…)")


# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--snapshot-dir", default="/tmp/zaki-repair-design")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("manifests")
    sub.add_parser("package-sha")

    sp = sub.add_parser("sql")
    sp.add_argument(
        "--auth-manifest",
        default=None,
        required=True,
        help="signed stage-2 authorization manifest JSON (REQUIRED — no "
             "default; missing authorization input fails closed)",
    )

    fp = sub.add_parser("freeze")
    fp.add_argument("--stage", type=int, required=True, choices=(1, 2))
    fp.add_argument("--environment-mode", required=True, choices=MODES)
    fp.add_argument("--auth-manifest", default=None)
    fp.add_argument("--stage1-artifact", default=None)
    fp.add_argument("--stage1-receipt", default=None,
                    help="(stage 2) the stage-1 execution receipt export "
                         "(database-side; operator evidence only — the "
                         "stage-2 artifact validates the actual DB row)")
    fp.add_argument("--project-ref", default=None)
    fp.add_argument("--out-dir", default=str(ROOT / "artifacts"))
    fp.add_argument("--frozen-at", default=None,
                    help="freeze timestamp (ISO-8601; default: now)")

    vp = sub.add_parser("verify")
    vp.add_argument("--auth-manifest", default=None)
    vp.add_argument("--artifact", default=None,
                    help="freeze record JSON of a frozen artifact")
    vp.add_argument("--stage1-artifact", default=None,
                    help="(with --artifact of a stage-2 record) the frozen "
                         "stage-1 artifact the stage-2 build sequenced on")
    vp.add_argument("--stage1-receipt", default=None,
                    help="(with --artifact of a stage-2 record) the stage-1 "
                         "execution receipt export")

    rp = sub.add_parser("rehearsal-manifest")
    rp.add_argument("--confirmation-timestamp", required=True,
                    help="ISO-8601 timestamp AFTER the stage-1 checkpoint")
    rp.add_argument("--identity", default=TEST_ACCOUNTANT)
    rp.add_argument("--out", required=True)

    args = p.parse_args()

    if args.command == "manifests":
        cmd_manifests(args.snapshot_dir, MANIFEST_DIR)
    elif args.command == "package-sha":
        cmd_package_sha()
    elif args.command == "sql":
        cmd_sql(args.auth_manifest, args.snapshot_dir)
    elif args.command == "freeze":
        cmd_freeze(
            args.stage, args.environment_mode, args.auth_manifest,
            args.stage1_artifact, args.stage1_receipt,
            args.project_ref, args.out_dir, args.frozen_at,
        )
    elif args.command == "verify":
        cmd_verify(args.snapshot_dir, args.auth_manifest, args.artifact,
                   stage1_artifact=args.stage1_artifact,
                   stage1_receipt=args.stage1_receipt)
    elif args.command == "rehearsal-manifest":
        cmd_rehearsal_manifest(
            args.confirmation_timestamp, args.identity, args.out,
        )


if __name__ == "__main__":
    main()

