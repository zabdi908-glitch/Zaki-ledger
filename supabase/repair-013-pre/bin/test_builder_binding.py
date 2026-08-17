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
def make_stage1_artifact_proof(tmp, mode="REHEARSAL"):
    """Deterministic stage-1 artifact + schema-v2 execution proof pair."""
    pkg = bp.load_committed_package()
    ident1 = bp.artifact_identity_stage1(
        mode, pkg["stage1_manifest_sha"], pkg["basis_sha"], None)
    sql1 = bp.stage1_sql(
        pkg["s1t"], pkg["s1g"], pkg["s2c"], pkg["dup_after_s1"],
        pkg["stage1_manifest_sha"], pkg["basis_sha"], mode, None, ident1)
    s1_path = Path(tmp) / "14a-frozen.sql"
    s1_path.write_text(sql1, encoding="utf-8")
    proof_path = Path(tmp) / "proof.json"
    bp.build_stage1_proof(
        s1_path, mode, "repair_drill", "2026-08-17T09:00:00+00:00",
        "APPLIED", None, None, proof_path)
    return s1_path, proof_path


def b13():
    with tempfile.TemporaryDirectory() as tmp:
        s1_path, _ = make_stage1_artifact_proof(tmp)
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
        s1_path, proof_path = make_stage1_artifact_proof(tmp)
        # A DIFFERENT artifact file (edited bytes) with the same proof.
        other = Path(tmp) / "14a-other.sql"
        other.write_text(
            s1_path.read_text(encoding="utf-8").replace(
                "-- Package:", "-- Package (edited):", 1),
            encoding="utf-8")
        cand = find_first("candidate", "R3")
        manifest = make_manifest([decision(cand["match_id"])])
        expect_reject(
            "B14 proof bound to a different stage-1 artifact",
            lambda: bp.cmd_freeze(2, "REHEARSAL", manifest, other,
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
# B16 — SQL carries the mode gates, operation ids, binding hashes, the
#       artifact-sha GUC, the finite timeouts, and the exact stage-1
#       revalidation manifest.
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
            s2c_rows, s2g_rows, pkg["s1t"], pkg["s1g"], pkg["dup_after_s1"],
            manifest_sha, pkg["basis_sha"], stage1_artifact_sha, proof_sha,
            "REHEARSAL", None, ident, 1)
        for needle in (bp.MODE_GATE_REHEARSAL_MARK, bp.STAGE1_OPERATION_ID,
                       bp.STAGE2_OPERATION_ID, manifest_sha,
                       pkg["basis_sha"], stage1_artifact_sha, proof_sha,
                       ident, bp.REPAIR_ARTIFACT_SHA_GUC, "artifact_sha256",
                       bp.LOCK_TIMEOUT, bp.STATEMENT_TIMEOUT,
                       "Stage-1 checkpoint revalidation"):
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
# B18-B22 — stage-1 proof tampering (schema v2, blocker 2): the builder
#           revalidates every derivable field; caller-created JSON is not
#           accepted merely because fields are present.
# ---------------------------------------------------------------------------
def _tampered_proof(tmp, mutate):
    s1_path, proof_path = make_stage1_artifact_proof(tmp)
    doc = json.load(open(proof_path, encoding="utf-8"))
    mutate(doc)
    bad = Path(tmp) / "proof-tampered.json"
    with open(bad, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    return str(s1_path), str(bad)


def b18():
    with tempfile.TemporaryDirectory() as tmp:
        s1, bad = _tampered_proof(tmp, lambda d: d.update(
            survivor_mappings={
                k: ("tampered" if i == 0 else v)
                for i, (k, v) in enumerate(d["survivor_mappings"].items())}))
        expect_reject(
            "B18 proof tampering (survivor mapping) rejected",
            lambda: bp.load_stage1_proof(bad, "REHEARSAL", s1),
            "survivor_mappings",
        )


def b19():
    with tempfile.TemporaryDirectory() as tmp:
        s1, bad = _tampered_proof(tmp, lambda d: d.update(
            target_ids=list(reversed(d["target_ids"]))))
        expect_reject(
            "B19 proof tampering (target ids re-sequenced) rejected",
            lambda: bp.load_stage1_proof(bad, "REHEARSAL", s1),
            "target_ids",
        )


def b20():
    with tempfile.TemporaryDirectory() as tmp:
        s1, bad = _tampered_proof(
            tmp, lambda d: d.update(postcondition_digest_sha256="0" * 64))
        expect_reject(
            "B20 proof tampering (postcondition digest) rejected",
            lambda: bp.load_stage1_proof(bad, "REHEARSAL", s1),
            "postcondition digest",
        )


def b21():
    with tempfile.TemporaryDirectory() as tmp:
        s1, bad = _tampered_proof(
            tmp, lambda d: d.update(package_git_sha="0" * 40))
        expect_reject(
            "B21 proof tampering (package git sha) rejected",
            lambda: bp.load_stage1_proof(bad, "REHEARSAL", s1),
            "package_git_sha",
        )


def b22():
    # Coordinated tamper of artifact bytes AND the proof's recorded sha:
    # the sha matches again, but the byte-identity regeneration check still
    # rejects the edited artifact.
    with tempfile.TemporaryDirectory() as tmp:
        s1_path, proof_path = make_stage1_artifact_proof(tmp)
        edited = Path(tmp) / "14a-edited.sql"
        edited.write_text(
            s1_path.read_text(encoding="utf-8").replace(
                "-- Package:", "-- Package (edited):", 1),
            encoding="utf-8")
        doc = json.load(open(proof_path, encoding="utf-8"))
        doc["artifact_sha256"] = bp.sha256_file(edited)
        with open(proof_path, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")
        expect_reject(
            "B22 coordinated artifact+proof tamper rejected by regeneration",
            lambda: bp.load_stage1_proof(proof_path, "REHEARSAL", edited),
            "not byte-identical",
        )


# ---------------------------------------------------------------------------
# B23 — legacy schema-v1 proof is refused outright.
# ---------------------------------------------------------------------------
def b23():
    with tempfile.TemporaryDirectory() as tmp:
        s1_path, _ = make_stage1_artifact_proof(tmp)
        legacy = Path(tmp) / "proof-v1.json"
        legacy.write_text(json.dumps({
            "package": "repair-013-pre",
            "proof_schema_version": 1,
            "stage": 1,
            "artifact_file": s1_path.name,
            "artifact_sha256": bp.sha256_file(s1_path),
            "environment_mode": "REHEARSAL",
            "database": "repair_drill",
            "executed_at": "2026-08-17T09:00:00+00:00",
            "result": "APPLIED",
        }, indent=2) + "\n", encoding="utf-8")
        expect_reject(
            "B23 legacy v1 caller-created proof rejected",
            lambda: bp.load_stage1_proof(legacy, "REHEARSAL", s1_path),
            "no longer accepted",
        )


# ---------------------------------------------------------------------------
# B24-B26 — independent frozen-artifact verification (blocker 3): a
#           coordinated modification of the frozen SQL AND the freeze
#           record must still FAIL because the regenerated bytes differ.
# ---------------------------------------------------------------------------
def _freeze_stage2(tmp):
    s1_path, proof_path = make_stage1_artifact_proof(tmp)
    cand = find_first("candidate", "R3")
    manifest = make_manifest([decision(cand["match_id"])])
    bp.cmd_freeze(2, "REHEARSAL", manifest, s1_path, proof_path, None,
                  tmp, None)
    records = sorted(glob.glob(os.path.join(tmp, "freeze-14b-*.json")))
    assert records, "no stage-2 freeze record produced"
    record = Path(records[-1])
    artifact = Path(tmp) / json.load(open(record, encoding="utf-8"))[
        "artifact_file"]
    return s1_path, proof_path, manifest, artifact, record


def b24():
    # Valid stage-2 freeze passes independent verification.
    with tempfile.TemporaryDirectory() as tmp:
        s1, proof, manifest, artifact, record = _freeze_stage2(tmp)

        def _inner():
            bp.verify_frozen_artifact(
                str(record), stage1_artifact=str(s1),
                auth_manifest=str(manifest), stage1_proof=str(proof))

        run("B24 valid stage-2 freeze passes independent regeneration "
            "verification", _inner)


def b25():
    # Coordinated tamper: edit BOTH the frozen SQL and the freeze record
    # (recorded sha recomputed). Byte-identity regeneration must FAIL.
    with tempfile.TemporaryDirectory() as tmp:
        s1, proof, manifest, artifact, record = _freeze_stage2(tmp)
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
                auth_manifest=str(manifest), stage1_proof=str(proof)),
            "NOT byte-identical",
        )


def b26():
    # Freeze-record-only tamper (sha re-recorded, SQL untouched is already
    # covered by B25; here: sha left stale) must also FAIL.
    with tempfile.TemporaryDirectory() as tmp:
        s1, proof, manifest, artifact, record = _freeze_stage2(tmp)
        doc = json.load(open(record, encoding="utf-8"))
        doc["artifact_sha256"] = "0" * 64
        with open(record, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")
        expect_reject(
            "B26 stale freeze-record sha FAILS verification",
            lambda: bp.verify_frozen_artifact(
                str(record), stage1_artifact=str(s1),
                auth_manifest=str(manifest), stage1_proof=str(proof)),
            "sha256",
        )


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
    b18()
    b19()
    b20()
    b21()
    b22()
    b23()
    b24()
    b25()
    b26()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
