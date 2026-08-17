#!/usr/bin/env python3
"""Builder-level authorization-binding failure/substitution tests (Phase 9).

NO DATABASE REQUIRED — these tests operate on the COMMITTED manifests and
basis only. Every case must fail closed: tampered authorization inputs are
rejected by the builder, and the generated SQL carries the mode gates and
binding hashes.

Cases:
  B1  candidate/survivor reversal (decision on an R3 survivor guard) — reject
  B2  arbitrary candidate replacement (match_id not in the basis) — reject
  B3  identity smuggling: decision entries carrying reason/action/class/
      survivor/qb/bank keys — reject (unknown keys)
  B4  top-level identity smuggling (legacy CSV-style fields) — reject
  B5  R6 swap legality: authorizing the proposal-KEEP member is a permitted
      choice whose survivor is the pair partner (from the basis)
  B6  R6 both-members-retire — reject
  B7  missing --auth-manifest on `sql` / stage-2 freeze — hard failure
  B8  rehearsal manifest in production mode — reject
  B9  production build against a wrong project identity — reject
  B10 R6 decision timestamp before the stage-1 checkpoint (receipt) — reject
  B11 wrong basis_sha256 in a manifest — reject
  B12 legacy CSV-shaped authorization manifest — reject
  B13 stage-2 freeze without a stage-1 receipt export — reject
  B14 receipt export bound to a different stage-1 artifact — reject
  B15 frozen artifacts are immutable (second freeze of identical inputs
      refuses to overwrite)
  B16 generated SQL carries the mode gates, operation ids, package-sha
      bindings, the receipt validation, and the binding hashes
      (REHEARSAL + PRODUCTION)
  B17 SQL emission is deterministic (byte-identical regeneration)
  B18 receipt tampering (survivor-mapping digest) — reject
  B19 receipt tampering (target digest) — reject
  B20 receipt tampering (postcondition digest format) — reject
  B21 receipt tampering (execution package sha) — reject
  B22 coordinated artifact+receipt tamper rejected by regeneration
  B23 arbitrary caller-fabricated stage-1 proof JSON — reject (missing
      receipt fields; no proof schema is accepted)
  B24 valid stage-2 freeze passes independent regeneration verification
  B25 coordinated SQL+freeze-record tamper FAILS verification
  B26 stale freeze-record sha FAILS verification
  B27 EXECUTION_PACKAGE_SHA256 determinism + file-list coverage (the
      content-based package identity, stable across evidence commits)
  B28 clean-clone verification (skipped when run inside a clone): the
      committed HEAD must pass `verify` + this suite from a fresh clone

Usage: python3 bin/test_builder_binding.py   (exit 0 = all pass)
"""

import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BUILDER = HERE / "build_repair_package.py"

spec = importlib.util.spec_from_file_location("build_repair_package", BUILDER)
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)

PASS = 0
FAIL = 0


def run(name, fn):
    global PASS, FAIL
    try:
        fn()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — test harness
        FAIL += 1
        print(f"FAIL: {name}: {type(e).__name__}: {e}")
        return
    PASS += 1
    print(f"PASS: {name}")


def expect_reject(name, fn, fragment=None):
    """Assert fn raises SystemExit (optionally mentioning fragment)."""

    def _inner():
        try:
            fn()
        except SystemExit as e:
            msg = str(e)
            if fragment and fragment not in msg:
                raise AssertionError(
                    f"rejected but without expected fragment "
                    f"{fragment!r}; got: {msg}"
                )
            return
        raise AssertionError("accepted — expected rejection")

    run(name, _inner)


def expect_accept(name, fn):
    def _inner():
        try:
            return fn()
        except SystemExit as e:
            raise AssertionError(f"rejected — expected acceptance: {e}")

    run(name, _inner)


def basis():
    return bp.load_committed_basis()


def basis_by_id():
    return {r["match_id"]: r for r in basis()["rows"]}


def make_manifest(rows, mode="REHEARSAL", basis_sha=None):
    doc = {
        "package": "repair-013-pre",
        "manifest_schema_version": 1,
        "environment_mode": mode,
        "basis_sha256": basis_sha or bp.sha256_file(bp.BASIS_PATH),
        "decisions": rows,
    }
    with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
        return Path(f.name)


def decision(match_id, decision="RETIRE",
             identity="test-accountant",
             ts="2026-08-17T09:30:00+00:00"):
    return {
        "match_id": match_id,
        "decision": decision,
        "accountant_identity": identity,
        "confirmation_timestamp": ts,
        "note": "",
    }


def find_first(role, cls=None):
    for r in basis()["rows"]:
        if r["role"] == role and (cls is None or r["class"] == cls):
            return r
    raise AssertionError(f"no basis row for role={role} cls={cls}")


# ---------------------------------------------------------------------------
# B1 — candidate/survivor reversal: a decision on an R3 survivor guard.
# ---------------------------------------------------------------------------
def b1():
    guard = find_first("survivor_guard", "R3")
    manifest = make_manifest([decision(guard["match_id"])])
    expect_reject(
        "B1 candidate/survivor reversal (guard authorized to retire)",
        lambda: bp.validate_auth_manifest(manifest, "REHEARSAL"),
        "candidate/survivor reversal",
    )


# ---------------------------------------------------------------------------
# B2 — arbitrary candidate replacement: a match_id outside the basis.
# ---------------------------------------------------------------------------
def b2():
    manifest = make_manifest(
        [decision("11111111-2222-3333-4444-555555555555")])
    expect_reject(
        "B2 arbitrary candidate replacement",
        lambda: bp.validate_auth_manifest(manifest, "REHEARSAL"),
        "not part of the committed stage-2 basis",
    )


# ---------------------------------------------------------------------------
# B3/B4 — identity smuggling: unknown keys at decision and top level.
# ---------------------------------------------------------------------------
def b3():
    cand = find_first("candidate", "R3")
    row = decision(cand["match_id"])
    for smuggled in ("reason", "action", "class", "intended_survivor_match_id",
                     "qb_transaction_id", "bank_transaction_id",
                     "survivor_match_id"):
        row[smuggled] = "smuggled"
    manifest = make_manifest([row])
    expect_reject(
        "B3 decision-entry identity smuggling (reason/action/class/survivor)",
        lambda: bp.validate_auth_manifest(manifest, "REHEARSAL"),
        "cannot be redefined by the authorization manifest",
    )


def b4():
    cand = find_first("candidate", "R3")
    doc = {
        "package": "repair-013-pre",
        "manifest_schema_version": 1,
        "environment_mode": "REHEARSAL",
        "basis_sha256": bp.sha256_file(bp.BASIS_PATH),
        "decisions": [decision(cand["match_id"])],
        "reason": "smuggled",  # legacy top-level identity column
    }
    with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        path = Path(f.name)
    expect_reject(
        "B4 top-level identity smuggling",
        lambda: bp.validate_auth_manifest(path, "REHEARSAL"),
        "unknown top-level keys",
    )


# ---------------------------------------------------------------------------
# B5 — R6 swap is a PERMITTED choice with the pair partner as survivor.
# ---------------------------------------------------------------------------
def b5():
    rows = basis()["rows"]
    r6 = [r for r in rows if r["class"] == "R6"]
    # proposal KEEP member: the one NOT chosen by the committed test
    # decisions.
    test = json.load(open(bp.TEST_DECISIONS_PATH, encoding="utf-8"))
    retire_choices = {d["match_id"] for d in test["choices"]
                      if d["match_id"] in {r["match_id"] for r in r6}}
    keep_members = [r for r in r6 if r["match_id"] not in retire_choices]
    assert len(keep_members) == 4
    member = keep_members[0]
    partner = member["intended_survivor_match_id"]
    assert partner and partner != member["match_id"]

    receipt = {
        "executed_at": bp.parse_iso_ts("2026-08-17T09:00:00+00:00"),
        "executed_at_iso": "2026-08-17T09:00:00+00:00",
    }
    manifest = make_manifest([decision(member["match_id"])])

    def _inner():
        decisions, _ = bp.validate_auth_manifest(manifest, "REHEARSAL",
                                                 receipt=receipt)
        assert len(decisions) == 1
        assert decisions[0]["match_id"] == member["match_id"]
        cands, guards = bp.join_decisions(rows, decisions)
        by_id = {r["match_id"]: r for r in cands}
        assert by_id[member["match_id"]]["intended_survivor_match_id"] == partner
        return decisions

    run("B5 R6 swap accepted with pair-partner survivor (basis, not manifest)",
        _inner)


# ---------------------------------------------------------------------------
# B6 — both R6 members authorized to retire.
# ---------------------------------------------------------------------------
def b6():
    rows = basis()["rows"]
    r6 = [r for r in rows if r["class"] == "R6"]
    by_qb = {}
    for r in r6:
        by_qb.setdefault(r["qb_transaction_id"], []).append(r)
    pair = next(v for v in by_qb.values() if len(v) == 2)
    manifest = make_manifest([decision(pair[0]["match_id"]),
                              decision(pair[1]["match_id"])])
    expect_reject(
        "B6 both R6 pair members authorized to retire",
        lambda: bp.validate_auth_manifest(manifest, "REHEARSAL"),
        "BOTH pair members",
    )


# ---------------------------------------------------------------------------
# B7 — missing --auth-manifest fails closed (subprocess, exit != 0).
# ---------------------------------------------------------------------------
def b7():
    def _inner():
        r = subprocess.run(
            [sys.executable, str(BUILDER), "sql"],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            raise AssertionError("sql without --auth-manifest succeeded")
        if "--auth-manifest" not in r.stderr or "required" not in r.stderr:
            raise AssertionError(f"unexpected message: {r.stderr}")

    run("B7a sql without --auth-manifest fails closed", _inner)

    def _inner2():
        r = subprocess.run(
            [sys.executable, str(BUILDER), "freeze", "--stage", "2",
             "--environment-mode", "REHEARSAL"],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            raise AssertionError("stage-2 freeze without manifest succeeded")
        if "missing authorization input fails closed" not in r.stderr:
            raise AssertionError(f"unexpected message: {r.stderr}")

    run("B7b stage-2 freeze without --auth-manifest fails closed", _inner2)


# ---------------------------------------------------------------------------
# B8 — rehearsal manifest in PRODUCTION mode.
# ---------------------------------------------------------------------------
def b8():
    expect_reject(
        "B8 rehearsal manifest refused in PRODUCTION mode",
        lambda: bp.validate_auth_manifest(
            bp.REHEARSAL_MANIFEST_PATH, "PRODUCTION"),
        "does not match the requested mode",
    )


# ---------------------------------------------------------------------------
# B9 — production build against a wrong project identity.
# ---------------------------------------------------------------------------
def b9():
    with tempfile.TemporaryDirectory() as tmp:
        expect_reject(
            "B9 PRODUCTION freeze with wrong project identity",
            lambda: bp.cmd_freeze(
                1, "PRODUCTION", None, None, None,
                "gzwtxebgevgapchoslmp", tmp, None),
            "exact project identity",
        )


# ---------------------------------------------------------------------------
# B10 — R6 decision timestamp before the stage-1 checkpoint.
# ---------------------------------------------------------------------------
def b10():
    rows = basis()["rows"]
    r6 = [r for r in rows if r["class"] == "R6"]
    member = r6[0]
    receipt = {
        "executed_at": bp.parse_iso_ts("2026-08-17T12:00:00+00:00"),
        "executed_at_iso": "2026-08-17T12:00:00+00:00",
    }
    manifest = make_manifest(
        [decision(member["match_id"], ts="2026-08-17T11:59:59+00:00")],
        mode="PRODUCTION")
    expect_reject(
        "B10 R6 decision before the stage-1 checkpoint",
        lambda: bp.validate_auth_manifest(manifest, "PRODUCTION",
                                          receipt=receipt),
        "stage-1 checkpoint",
    )


# ---------------------------------------------------------------------------
# B11 — wrong basis sha.
# ---------------------------------------------------------------------------
def b11():
    cand = find_first("candidate", "R3")
    manifest = make_manifest([decision(cand["match_id"])],
                             basis_sha="0" * 64)
    expect_reject(
        "B11 manifest bound to a different basis sha",
        lambda: bp.validate_auth_manifest(manifest, "REHEARSAL"),
        "different accounting identity",
    )


# ---------------------------------------------------------------------------
# B12 — legacy CSV-shaped manifest.
# ---------------------------------------------------------------------------
def b12():
    cand = find_first("candidate", "R3")
    with tempfile.NamedTemporaryFile(
            "w", suffix=".csv", delete=False, encoding="utf-8") as f:
        f.write(
            "match_id,role,accountant_decision,accountant_identity,"
            "confirmation_timestamp,authorization_status\n"
            f"{cand['match_id']},target,RETIRE,test-accountant,"
            "2026-08-17T00:00:00+00:00,APPROVED_FOR_RETIREMENT\n"
        )
        path = Path(f.name)
    expect_reject(
        "B12 legacy CSV-shaped authorization manifest rejected",
        lambda: bp.validate_auth_manifest(path, "REHEARSAL"),
        "unreadable",
    )


# ---------------------------------------------------------------------------
# B13/B14 — stage-2 freeze receipt requirements. The receipt export is
#           OPERATOR EVIDENCE ONLY: the freeze revalidates its derivable
#           fields (consistency), while the actual authorization is the
#           immutable database-side receipt row validated by the stage-2
#           artifact at execution (see the G20 execution-level case).
# ---------------------------------------------------------------------------
def make_stage1_receipt_export(tmp, mode="REHEARSAL"):
    """Deterministic stage-1 artifact + a fabricated-but-derivably-correct
    receipt export. Exactly what a forged caller-created export looks like
    when every derivable field matches the committed package: the freeze
    accepts it by design (evidence consistency), and only the database-side
    receipt validation can reject it (G20)."""
    pkg = bp.load_committed_package()
    ident1 = bp.artifact_identity_stage1(
        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"],
        bp.execution_package_sha256(), None)
    sql1 = bp.stage1_sql(
        pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
        pkg["stage1_manifest_sha"], pkg["basis_sha"], mode, None, ident1,
        bp.execution_package_sha256())
    s1_path = Path(tmp) / "14a-frozen.sql"
    s1_path.write_text(sql1, encoding="utf-8")
    receipt_path = Path(tmp) / "receipt-export.json"
    doc = {
        "receipt_sha256": "f" * 64,
        "execution_package_sha256": bp.execution_package_sha256(),
        "artifact_sha256": bp.sha256_file(s1_path),
        "operation_id": bp.STAGE1_OPERATION_ID,
        "environment_mode": mode,
        "project_ref": None,
        "target_manifest_sha256": pkg["stage1_manifest_sha"],
        "target_digest_sha256": bp.stage1_target_digest(pkg["s1t"]),
        "survivor_mapping_digest_sha256": (
            bp.stage1_survivor_mapping_digest(pkg["s1t"])),
        "audit_digest_sha256": "a" * 64,
        "postcondition_digest_sha256": "b" * 64,
        "executed_at": "2026-08-17T09:00:00+00:00",
        "db_identity": "repair_drill",
    }
    with open(receipt_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    return s1_path, receipt_path


def b13():
    with tempfile.TemporaryDirectory() as tmp:
        s1_path, _ = make_stage1_receipt_export(tmp)
        cand = find_first("candidate", "R3")
        manifest = make_manifest([decision(cand["match_id"])])
        expect_reject(
            "B13 stage-2 freeze without a stage-1 receipt export",
            lambda: bp.cmd_freeze(2, "REHEARSAL", manifest, s1_path, None,
                                  None, tmp, None),
            "stage-1 database-side checkpoint",
        )


def b14():
    with tempfile.TemporaryDirectory() as tmp:
        s1_path, receipt_path = make_stage1_receipt_export(tmp)
        # A DIFFERENT artifact file (edited bytes) with the same receipt.
        other = Path(tmp) / "14a-other.sql"
        other.write_text(
            s1_path.read_text(encoding="utf-8").replace(
                "-- Package:", "-- Package (edited):", 1),
            encoding="utf-8")
        cand = find_first("candidate", "R3")
        manifest = make_manifest([decision(cand["match_id"])])
        expect_reject(
            "B14 receipt bound to a different stage-1 artifact",
            lambda: bp.cmd_freeze(2, "REHEARSAL", manifest, other,
                                  receipt_path, None, tmp, None),
            "different artifact",
        )


# ---------------------------------------------------------------------------
# B15 — frozen artifacts are immutable (overwrite refused).
# ---------------------------------------------------------------------------
def b15():
    with tempfile.TemporaryDirectory() as tmp:
        bp.cmd_freeze(1, "REHEARSAL", None, None, None, None, tmp,
                      "2026-08-17T09:00:00+00:00")
        expect_reject(
            "B15 second freeze of identical inputs refused (immutable)",
            lambda: bp.cmd_freeze(1, "REHEARSAL", None, None, None, None,
                                  tmp, "2026-08-17T09:00:00+00:00"),
            "immutable once frozen",
        )


# ---------------------------------------------------------------------------
# B16 — SQL carries the mode gates, operation ids, binding hashes, the
#       artifact-sha + package-sha GUC gates, the finite timeouts, the
#       database-side receipt machinery, and the exact stage-1 revalidation
#       manifest.
# ---------------------------------------------------------------------------
def b16():
    def _inner():
        pkg = bp.load_committed_package()
        package_sha = bp.execution_package_sha256()
        cand = find_first("candidate", "R3")
        manifest = make_manifest([decision(cand["match_id"])])
        decisions, manifest_sha = bp.validate_auth_manifest(manifest,
                                                            "REHEARSAL")
        s2c_rows, s2g_rows = bp.join_decisions(pkg["basis_rows"], decisions)
        stage1_artifact_sha = "a" * 64
        receipt_sha = "b" * 64
        ident = bp.artifact_identity_stage2(
            "REHEARSAL", pkg["stage1_manifest_sha"], pkg["basis_sha"],
            manifest_sha, stage1_artifact_sha, receipt_sha, package_sha,
            None)
        sql = bp.stage2_sql(
            s2c_rows, s2g_rows, pkg["s1t"], pkg["s1g"], pkg["dup_after_s1"],
            manifest_sha, pkg["basis_sha"], stage1_artifact_sha, receipt_sha,
            package_sha, "REHEARSAL", None, ident, 1)
        for needle in (bp.MODE_GATE_REHEARSAL_MARK, bp.STAGE1_OPERATION_ID,
                       bp.STAGE2_OPERATION_ID, manifest_sha,
                       pkg["basis_sha"], stage1_artifact_sha, receipt_sha,
                       package_sha, ident, bp.REPAIR_ARTIFACT_SHA_GUC,
                       bp.REPAIR_PACKAGE_SHA_GUC, "artifact_sha256",
                       "execution_package_sha256", "stage1_receipt_sha256",
                       bp.LOCK_TIMEOUT, bp.STATEMENT_TIMEOUT,
                       "Stage-1 checkpoint revalidation",
                       "Stage-1 execution receipt",
                       "repair_stage1_receipt",
                       "expected exactly one stage-1 execution receipt"):
            assert needle in sql, f"stage-2 SQL missing {needle}"
        assert bp.MODE_GATE_PRODUCTION_MARK not in sql
        # The FULL committed stage-1 manifest is embedded for the exact
        # stage-1 revalidation: a stage-1 target id (never a candidate) and
        # a stage-1 survivor-guard id must both appear in the stage-2 SQL.
        s1_target = pkg["s1t"][0]["match_id"]
        s1_guard = pkg["s1g"][0]["match_id"]
        assert s1_target in sql, "stage-2 SQL does not embed stage-1 targets"
        assert s1_guard in sql, "stage-2 SQL does not embed stage-1 guards"

        ident1 = bp.artifact_identity_stage1(
            "REHEARSAL", pkg["stage1_manifest_sha"], pkg["basis_sha"],
            package_sha, None)
        sql1 = bp.stage1_sql(
            pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
            pkg["stage1_manifest_sha"], pkg["basis_sha"], "REHEARSAL", None,
            ident1, package_sha)
        for needle in (bp.MODE_GATE_REHEARSAL_MARK, bp.STAGE1_OPERATION_ID,
                       pkg["stage1_manifest_sha"], pkg["basis_sha"], ident1,
                       package_sha, bp.REPAIR_PACKAGE_SHA_GUC,
                       "repair_stage1_receipt",
                       "STAGE 1: wrote execution receipt"):
            assert needle in sql1, f"stage-1 SQL missing {needle}"

        ident_p = bp.artifact_identity_stage1(
            "PRODUCTION", pkg["stage1_manifest_sha"], pkg["basis_sha"],
            package_sha, bp.PROD_PROJECT_REF)
        sql_p = bp.stage1_sql(
            pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
            pkg["stage1_manifest_sha"], pkg["basis_sha"], "PRODUCTION",
            bp.PROD_PROJECT_REF, ident_p, package_sha)
        for needle in (bp.MODE_GATE_PRODUCTION_MARK, bp.PROD_PROJECT_REF,
                       "server_version_num", bp.PROJECT_REF_GUC,
                       package_sha):
            assert needle in sql_p, f"PRODUCTION SQL missing {needle}"
        assert bp.MODE_GATE_REHEARSAL_MARK not in sql_p

    run("B16 SQL carries mode gates, operation ids, package-sha and "
        "receipt bindings", _inner)


# ---------------------------------------------------------------------------
# B18-B23 — stage-1 receipt tampering: the builder revalidates every
#           DERIVABLE field of the export; caller-created proof JSON is not
#           accepted (only a database receipt export has the required
#           fields). The database-side digests are format-checked here and
#           validated against live state by the stage-2 artifact (G20).
# ---------------------------------------------------------------------------
def _tampered_receipt(tmp, mutate):
    s1_path, receipt_path = make_stage1_receipt_export(tmp)
    doc = json.load(open(receipt_path, encoding="utf-8"))
    mutate(doc)
    bad = Path(tmp) / "receipt-tampered.json"
    with open(bad, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    return str(s1_path), str(bad)


def b18():
    with tempfile.TemporaryDirectory() as tmp:
        s1, bad = _tampered_receipt(tmp, lambda d: d.update(
            survivor_mapping_digest_sha256="0" * 64))
        expect_reject(
            "B18 receipt tampering (survivor-mapping digest) rejected",
            lambda: bp.load_stage1_receipt(bad, "REHEARSAL", s1),
            "survivor_mapping_digest_sha256",
        )


def b19():
    with tempfile.TemporaryDirectory() as tmp:
        s1, bad = _tampered_receipt(
            tmp, lambda d: d.update(target_digest_sha256="0" * 64))
        expect_reject(
            "B19 receipt tampering (target digest) rejected",
            lambda: bp.load_stage1_receipt(bad, "REHEARSAL", s1),
            "target_digest_sha256",
        )


def b20():
    with tempfile.TemporaryDirectory() as tmp:
        s1, bad = _tampered_receipt(
            tmp, lambda d: d.update(postcondition_digest_sha256="not-a-hash"))
        expect_reject(
            "B20 receipt tampering (postcondition digest format) rejected",
            lambda: bp.load_stage1_receipt(bad, "REHEARSAL", s1),
            "postcondition_digest_sha256",
        )


def b21():
    with tempfile.TemporaryDirectory() as tmp:
        s1, bad = _tampered_receipt(
            tmp, lambda d: d.update(execution_package_sha256="0" * 64))
        expect_reject(
            "B21 receipt tampering (execution package sha) rejected",
            lambda: bp.load_stage1_receipt(bad, "REHEARSAL", s1),
            "EXECUTION_PACKAGE_SHA256",
        )


def b22():
    # Coordinated tamper of artifact bytes AND the receipt's recorded sha:
    # the sha matches again, but the byte-identity regeneration check still
    # rejects the edited artifact.
    with tempfile.TemporaryDirectory() as tmp:
        s1_path, receipt_path = make_stage1_receipt_export(tmp)
        edited = Path(tmp) / "14a-edited.sql"
        edited.write_text(
            s1_path.read_text(encoding="utf-8").replace(
                "-- Package:", "-- Package (edited):", 1),
            encoding="utf-8")
        doc = json.load(open(receipt_path, encoding="utf-8"))
        doc["artifact_sha256"] = bp.sha256_file(edited)
        with open(receipt_path, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")
        expect_reject(
            "B22 coordinated artifact+receipt tamper rejected by "
            "regeneration",
            lambda: bp.load_stage1_receipt(receipt_path, "REHEARSAL",
                                           edited),
            "not byte-identical",
        )


# ---------------------------------------------------------------------------
# B23 — arbitrary caller-fabricated stage-1 proof JSON is refused outright:
#       no proof schema of any version is accepted; only a database receipt
#       export (with the receipt fields) passes the field checks, and its
#       derivable fields must match the committed package.
# ---------------------------------------------------------------------------
def b23():
    with tempfile.TemporaryDirectory() as tmp:
        s1_path, _ = make_stage1_receipt_export(tmp)
        fake = Path(tmp) / "fake-proof.json"
        fake.write_text(json.dumps({
            "package": "repair-013-pre",
            "proof_schema_version": 2,
            "stage": 1,
            "artifact_file": s1_path.name,
            "artifact_sha256": bp.sha256_file(s1_path),
            "environment_mode": "REHEARSAL",
            "database": "repair_drill",
            "executed_at": "2026-08-17T09:00:00+00:00",
            "result": "APPLIED",
        }, indent=2) + "\n", encoding="utf-8")
        expect_reject(
            "B23 arbitrary caller-fabricated stage-1 proof JSON rejected",
            lambda: bp.load_stage1_receipt(fake, "REHEARSAL", s1_path),
            "missing field",
        )


# ---------------------------------------------------------------------------
# B24-B26 — independent frozen-artifact verification (blocker 3): a
#           coordinated modification of the frozen SQL AND the freeze
#           record must still FAIL because the regenerated bytes differ.
# ---------------------------------------------------------------------------
def _freeze_stage2(tmp):
    s1_path, receipt_path = make_stage1_receipt_export(tmp)
    cand = find_first("candidate", "R3")
    manifest = make_manifest([decision(cand["match_id"])])
    bp.cmd_freeze(2, "REHEARSAL", manifest, s1_path, receipt_path, None,
                  tmp, None)
    records = sorted(glob.glob(os.path.join(tmp, "freeze-14b-*.json")))
    assert records, "no stage-2 freeze record produced"
    record = Path(records[-1])
    artifact = Path(tmp) / json.load(open(record, encoding="utf-8"))[
        "artifact_file"]
    return s1_path, receipt_path, manifest, artifact, record


def b24():
    # Valid stage-2 freeze passes independent verification.
    with tempfile.TemporaryDirectory() as tmp:
        s1, receipt, manifest, artifact, record = _freeze_stage2(tmp)

        def _inner():
            bp.verify_frozen_artifact(
                str(record), stage1_artifact=str(s1),
                auth_manifest=str(manifest), stage1_receipt=str(receipt))

        run("B24 valid stage-2 freeze passes independent regeneration "
            "verification", _inner)


def b25():
    # Coordinated tamper: edit BOTH the frozen SQL and the freeze record
    # (recorded sha recomputed). Byte-identity regeneration must FAIL.
    with tempfile.TemporaryDirectory() as tmp:
        s1, receipt, manifest, artifact, record = _freeze_stage2(tmp)
        content = artifact.read_text(encoding="utf-8")
        assert "unsupported_approved_claim" in content
        tampered = content.replace(
            "unsupported_approved_claim", "unsupported_approved_claimX")
        artifact.write_text(tampered, encoding="utf-8")
        doc = json.load(open(record, encoding="utf-8"))
        doc["artifact_sha256"] = bp.sha256_file(artifact)
        with open(record, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")
        expect_reject(
            "B25 coordinated SQL+freeze-record tamper FAILS verification",
            lambda: bp.verify_frozen_artifact(
                str(record), stage1_artifact=str(s1),
                auth_manifest=str(manifest), stage1_receipt=str(receipt)),
            "NOT byte-identical",
        )


def b26():
    # Freeze-record-only tamper (sha re-recorded, SQL untouched is already
    # covered by B25; here: sha left stale) must also FAIL.
    with tempfile.TemporaryDirectory() as tmp:
        s1, receipt, manifest, artifact, record = _freeze_stage2(tmp)
        doc = json.load(open(record, encoding="utf-8"))
        doc["artifact_sha256"] = "0" * 64
        with open(record, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")
        expect_reject(
            "B26 stale freeze-record sha FAILS verification",
            lambda: bp.verify_frozen_artifact(
                str(record), stage1_artifact=str(s1),
                auth_manifest=str(manifest), stage1_receipt=str(receipt)),
            "sha256",
        )


# ---------------------------------------------------------------------------
# B27 — EXECUTION_PACKAGE_SHA256: deterministic, content-based (never git
#       HEAD), and computed over a documented file list that fully exists
#       on disk. This is the stable identity the artifacts bind — it does
#       NOT change when an evidence-only commit is added (Codex finding 3).
# ---------------------------------------------------------------------------
def b27():
    def _inner():
        a = bp.execution_package_sha256()
        b = bp.execution_package_sha256()
        assert a == b, "package sha is not deterministic"
        assert len(a) == 64 and all(c in "0123456789abcdef" for c in a)
        assert bp.EXECUTION_PACKAGE_FILES == sorted(
            bp.EXECUTION_PACKAGE_FILES), "package file list must be sorted"
        for rel in bp.EXECUTION_PACKAGE_FILES:
            assert (bp.ROOT / rel).is_file(), f"package file missing: {rel}"
        # Migration 013 and the prep must be in the list (production inputs).
        assert "13-repair-prep.sql" in bp.EXECUTION_PACKAGE_FILES
        assert ("../migrations/013_reconciliation_claim_hardening.sql"
                in bp.EXECUTION_PACKAGE_FILES)
        # Generated outputs and narrative evidence are excluded.
        assert "14a-stage1-unapproved-repair.sql" not in (
            bp.EXECUTION_PACKAGE_FILES)

    run("B27 EXECUTION_PACKAGE_SHA256 deterministic with full file-list "
        "coverage", _inner)


# ---------------------------------------------------------------------------
# B28 — clean-clone verification: the committed HEAD must pass the package
#       `verify` and this suite from a FRESH CLONE (no local state). The
#       committed frozen artifacts (freeze records) must each pass
#       `verify --artifact` against their bound committed inputs, found by
#       sha. Skipped when run inside a clone (env-guarded) to avoid
#       recursion.
# ---------------------------------------------------------------------------
def b28():
    if os.environ.get("ZAKI_REPAIR_NO_CLEAN_CLONE"):
        print("SKIP: B28 clean-clone verification (already inside a clone)")
        return

    def _inner():
        repo = bp.ROOT.parent.parent  # the Zaki-ledger git root
        with tempfile.TemporaryDirectory() as tmp:
            clone = Path(tmp) / "clone"
            r = subprocess.run(
                ["git", "clone", "--quiet", str(repo), str(clone)],
                capture_output=True, text=True,
            )
            if r.returncode != 0:
                raise AssertionError(f"git clone failed: {r.stderr}")
            env = dict(os.environ)
            env["ZAKI_REPAIR_NO_CLEAN_CLONE"] = "1"
            v = subprocess.run(
                [sys.executable,
                 str(clone / "supabase/repair-013-pre/bin/"
                     "build_repair_package.py"),
                 "verify",
                 "--auth-manifest",
                 "manifests/stage2-rehearsal-authorization-manifest.json"],
                cwd=str(clone / "supabase/repair-013-pre"),
                capture_output=True, text=True, env=env,
            )
            if v.returncode != 0 or "VERIFY OK" not in v.stdout:
                raise AssertionError(
                    f"clean-clone verify failed: {v.stdout} {v.stderr}")
            t = subprocess.run(
                [sys.executable,
                 str(clone / "supabase/repair-013-pre/bin/"
                     "test_builder_binding.py")],
                cwd=str(clone / "supabase/repair-013-pre"),
                capture_output=True, text=True, env=env,
            )
            if t.returncode != 0:
                raise AssertionError(
                    f"clean-clone builder tests failed: {t.stdout} "
                    f"{t.stderr}")
            # Committed frozen artifacts (present after the rehearsal
            # evidence commit): each freeze record must verify against its
            # bound committed inputs, located by recorded sha.
            art_dir = clone / "supabase/repair-013-pre/artifacts"
            records = sorted(art_dir.glob("freeze-14b-*.json"))
            for record in records:
                rec = json.load(open(record, encoding="utf-8"))
                bound = {}
                want = {
                    "stage1_artifact_sha256": "stage1-artifact",
                    "authorization_manifest_sha256": "auth-manifest",
                    "stage1_receipt_sha256": "stage1-receipt",
                }
                for sha_key, label in want.items():
                    found = [
                        p for p in art_dir.iterdir()
                        if p.is_file()
                        and bp.sha256_file(p) == rec.get(sha_key)
                    ]
                    if len(found) != 1:
                        raise AssertionError(
                            f"clean-clone: cannot locate {label} bound by "
                            f"{record.name} ({sha_key}={rec.get(sha_key)})")
                    bound[label] = str(found[0])
                a = subprocess.run(
                    [sys.executable,
                     str(clone / "supabase/repair-013-pre/bin/"
                         "build_repair_package.py"),
                     "verify", "--artifact", str(record),
                     "--stage1-artifact", bound["stage1-artifact"],
                     "--auth-manifest", bound["auth-manifest"],
                     "--stage1-receipt", bound["stage1-receipt"]],
                    cwd=str(clone / "supabase/repair-013-pre"),
                    capture_output=True, text=True, env=env,
                )
                if a.returncode != 0 or "VERIFY OK" not in a.stdout:
                    raise AssertionError(
                        f"clean-clone verify --artifact {record.name} "
                        f"failed: {a.stdout} {a.stderr}")

    run("B28 clean-clone verification (verify + builder tests + committed "
        "frozen artifacts from a fresh clone)", _inner)


# ---------------------------------------------------------------------------
# B17 — deterministic emission.
# ---------------------------------------------------------------------------
def b17():
    def _inner():
        pkg = bp.load_committed_package()
        package_sha = bp.execution_package_sha256()
        ident1 = bp.artifact_identity_stage1(
            "REHEARSAL", pkg["stage1_manifest_sha"], pkg["basis_sha"],
            package_sha, None)
        a = bp.stage1_sql(pkg["s1t"], pkg["s1g"], pkg["s2c"],
                          pkg["dup_after_s1"], pkg["stage1_manifest_sha"],
                          pkg["basis_sha"], "REHEARSAL", None, ident1,
                          package_sha)
        b = bp.stage1_sql(pkg["s1t"], pkg["s1g"], pkg["s2c"],
                          pkg["dup_after_s1"], pkg["stage1_manifest_sha"],
                          pkg["basis_sha"], "REHEARSAL", None, ident1,
                          package_sha)
        assert a == b

    run("B17 SQL emission is deterministic", _inner)


if __name__ == "__main__":
    b1()
    b2()
    b3()
    b4()
    b5()
    b6()
    b7()
    b8()
    b9()
    b10()
    b11()
    b12()
    b13()
    b14()
    b15()
    b16()
    b17()
    b18()
    b19()
    b20()
    b21()
    b22()
    b23()
    b24()
    b25()
    b26()
    b27()
    b28()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
