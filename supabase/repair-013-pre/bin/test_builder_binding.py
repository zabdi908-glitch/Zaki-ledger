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
  B10 R6 decision timestamp before the stage-1 checkpoint (proof) — reject
  B11 wrong basis_sha256 in a manifest — reject
  B12 legacy CSV-shaped authorization manifest — reject
  B13 stage-2 freeze without a stage-1 execution proof — reject
  B14 stage-1 execution proof bound to a different stage-1 artifact — reject
  B15 frozen artifacts are immutable (second freeze of identical inputs
      refuses to overwrite)
  B16 generated SQL carries the mode gates, operation ids, and binding
      hashes (REHEARSAL + PRODUCTION)
  B17 SQL emission is deterministic (byte-identical regeneration)

Usage: python3 bin/test_builder_binding.py   (exit 0 = all pass)
"""

import importlib.util
import json
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

    proof = {
        "executed_at": bp.parse_iso_ts("2026-08-17T09:00:00+00:00"),
        "executed_at_iso": "2026-08-17T09:00:00+00:00",
    }
    manifest = make_manifest([decision(member["match_id"])])

    def _inner():
        decisions, _ = bp.validate_auth_manifest(manifest, "REHEARSAL",
                                                 proof=proof)
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
    proof = {
        "executed_at": bp.parse_iso_ts("2026-08-17T12:00:00+00:00"),
        "executed_at_iso": "2026-08-17T12:00:00+00:00",
    }
    manifest = make_manifest(
        [decision(member["match_id"], ts="2026-08-17T11:59:59+00:00")],
        mode="PRODUCTION")
    expect_reject(
        "B10 R6 decision before the stage-1 checkpoint",
        lambda: bp.validate_auth_manifest(manifest, "PRODUCTION", proof=proof),
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
# B13/B14 — stage-2 freeze proof requirements.
# ---------------------------------------------------------------------------
def b13():
    with tempfile.TemporaryDirectory() as tmp:
        pkg = bp.load_committed_package()
        stage1 = bp.stage1_sql(
            pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
            pkg["stage1_manifest_sha"], pkg["basis_sha"], "REHEARSAL", None,
            bp.artifact_identity_stage1("REHEARSAL",
                                        pkg["stage1_manifest_sha"],
                                        pkg["basis_sha"], None),
        )
        s1_path = Path(tmp) / "14a.sql"
        s1_path.write_text(stage1, encoding="utf-8")
        cand = find_first("candidate", "R3")
        manifest = make_manifest([decision(cand["match_id"])])
        expect_reject(
            "B13 stage-2 freeze without a stage-1 execution proof",
            lambda: bp.cmd_freeze(2, "REHEARSAL", manifest, s1_path, None,
                                  None, tmp, None),
            "stage-1 checkpoint",
        )


def b14():
    with tempfile.TemporaryDirectory() as tmp:
        pkg = bp.load_committed_package()
        stage1 = bp.stage1_sql(
            pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
            pkg["stage1_manifest_sha"], pkg["basis_sha"], "REHEARSAL", None,
            bp.artifact_identity_stage1("REHEARSAL",
                                        pkg["stage1_manifest_sha"],
                                        pkg["basis_sha"], None),
        )
        s1_path = Path(tmp) / "14a.sql"
        s1_path.write_text(stage1, encoding="utf-8")
        proof_path = Path(tmp) / "proof.json"
        proof_path.write_text(json.dumps({
            "package": "repair-013-pre",
            "proof_schema_version": 1,
            "stage": 1,
            "artifact_file": "14a.sql",
            "artifact_sha256": "0" * 64,  # bound to a DIFFERENT artifact
            "environment_mode": "REHEARSAL",
            "database": "repair_drill",
            "executed_at": "2026-08-17T09:00:00+00:00",
            "result": "APPLIED",
        }, indent=2) + "\n", encoding="utf-8")
        cand = find_first("candidate", "R3")
        manifest = make_manifest([decision(cand["match_id"])])
        expect_reject(
            "B14 proof bound to a different stage-1 artifact",
            lambda: bp.cmd_freeze(2, "REHEARSAL", manifest, s1_path,
                                  proof_path, None, tmp, None),
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
# B16 — SQL carries the mode gates, operation ids, and binding hashes.
# ---------------------------------------------------------------------------
def b16():
    def _inner():
        pkg = bp.load_committed_package()
        cand = find_first("candidate", "R3")
        manifest = make_manifest([decision(cand["match_id"])])
        decisions, manifest_sha = bp.validate_auth_manifest(manifest,
                                                            "REHEARSAL")
        s2c_rows, s2g_rows = bp.join_decisions(pkg["basis_rows"], decisions)
        stage1_artifact_sha = "a" * 64
        proof_sha = "b" * 64
        ident = bp.artifact_identity_stage2(
            "REHEARSAL", pkg["stage1_manifest_sha"], pkg["basis_sha"],
            manifest_sha, stage1_artifact_sha, proof_sha, None)
        sql = bp.stage2_sql(
            s2c_rows, s2g_rows, pkg["s1t"], pkg["dup_after_s1"],
            manifest_sha, pkg["basis_sha"], stage1_artifact_sha, proof_sha,
            "REHEARSAL", None, ident, 1)
        for needle in (bp.MODE_GATE_REHEARSAL_MARK, bp.STAGE1_OPERATION_ID,
                       bp.STAGE2_OPERATION_ID, manifest_sha,
                       pkg["basis_sha"], stage1_artifact_sha, proof_sha,
                       ident):
            assert needle in sql, f"stage-2 SQL missing {needle}"
        assert bp.MODE_GATE_PRODUCTION_MARK not in sql

        ident1 = bp.artifact_identity_stage1(
            "REHEARSAL", pkg["stage1_manifest_sha"], pkg["basis_sha"], None)
        sql1 = bp.stage1_sql(
            pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
            pkg["stage1_manifest_sha"], pkg["basis_sha"], "REHEARSAL", None,
            ident1)
        for needle in (bp.MODE_GATE_REHEARSAL_MARK, bp.STAGE1_OPERATION_ID,
                       pkg["stage1_manifest_sha"], pkg["basis_sha"], ident1):
            assert needle in sql1, f"stage-1 SQL missing {needle}"

        ident_p = bp.artifact_identity_stage1(
            "PRODUCTION", pkg["stage1_manifest_sha"], pkg["basis_sha"],
            bp.PROD_PROJECT_REF)
        sql_p = bp.stage1_sql(
            pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
            pkg["stage1_manifest_sha"], pkg["basis_sha"], "PRODUCTION",
            bp.PROD_PROJECT_REF, ident_p)
        for needle in (bp.MODE_GATE_PRODUCTION_MARK, bp.PROD_PROJECT_REF,
                       "server_version_num", bp.PROJECT_REF_GUC):
            assert needle in sql_p, f"PRODUCTION SQL missing {needle}"
        assert bp.MODE_GATE_REHEARSAL_MARK not in sql_p

    run("B16 SQL carries mode gates, operation ids, and binding hashes",
        _inner)


# ---------------------------------------------------------------------------
# B17 — deterministic emission.
# ---------------------------------------------------------------------------
def b17():
    def _inner():
        pkg = bp.load_committed_package()
        ident1 = bp.artifact_identity_stage1(
            "REHEARSAL", pkg["stage1_manifest_sha"], pkg["basis_sha"], None)
        a = bp.stage1_sql(pkg["s1t"], pkg["s1g"], pkg["s2c"],
                          pkg["dup_after_s1"], pkg["stage1_manifest_sha"],
                          pkg["basis_sha"], "REHEARSAL", None, ident1)
        b = bp.stage1_sql(pkg["s1t"], pkg["s1g"], pkg["s2c"],
                          pkg["dup_after_s1"], pkg["stage1_manifest_sha"],
                          pkg["basis_sha"], "REHEARSAL", None, ident1)
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
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
