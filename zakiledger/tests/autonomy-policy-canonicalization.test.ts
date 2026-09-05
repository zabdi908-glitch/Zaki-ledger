import { describe, expect, it } from "vitest";
import {
  actionFingerprint,
  canonicalPolicyJson,
  canonicalizePolicyInput,
  policyDecisionKey,
} from "../lib/autonomy-policy-canonicalization";
import { BASE_INPUT, requestFor } from "./autonomy-policy-fixtures";

describe("Step 7 policy canonicalization", () => {
  it("sorts object keys and preserves exact signed bigint minor units", () => {
    expect(canonicalPolicyJson({ z: -9007199254740993n, a: 1n }))
      .toBe('{"a":1,"z":-9007199254740993}');
    expect(canonicalPolicyJson({ b: { y: 2, x: 1 }, a: true }))
      .toBe('{"a":true,"b":{"x":1,"y":2}}');
  });

  it("rejects decimal strings and numbers as authoritative policy money", () => {
    const stringMoney = { ...BASE_INPUT, amount: { ...BASE_INPUT.amount, amountMinor: "100.00" as unknown as bigint } };
    const numberMoney = { ...BASE_INPUT, amount: { ...BASE_INPUT.amount, amountMinor: 100 as unknown as bigint } };
    expect(canonicalizePolicyInput(stringMoney).issues.map((item) => item.code)).toContain("MONEY_NOT_INTEGER_MINOR_UNITS");
    expect(canonicalizePolicyInput(numberMoney).issues.map((item) => item.code)).toContain("MONEY_NOT_INTEGER_MINOR_UNITS");
  });

  it("normalizes set-like evidence order and rejects duplicate members", () => {
    const second = { ...BASE_INPUT.evidence.facts[0], evidenceId: "artifact-b", sha256: "c".repeat(64) };
    const left = canonicalizePolicyInput({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, facts: [second, ...BASE_INPUT.evidence.facts] } });
    const right = canonicalizePolicyInput({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, facts: [...BASE_INPUT.evidence.facts, second] } });
    expect(left.normalizedInputSha256).toBe(right.normalizedInputSha256);
    const duplicate = canonicalizePolicyInput({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, facts: [BASE_INPUT.evidence.facts[0], BASE_INPUT.evidence.facts[0]] } });
    expect(duplicate.issues.map((item) => item.code)).toContain("DUPLICATE_SET_MEMBER");
  });

  it("makes semantically ordered action lines fingerprint-sensitive", () => {
    const first = actionFingerprint({ lines: [{ id: "a" }, { id: "b" }] });
    const second = actionFingerprint({ lines: [{ id: "b" }, { id: "a" }] });
    expect(first).not.toBe(second);
  });

  it("uses only semantic hashes in the deterministic decision key", () => {
    const request = requestFor();
    const first = policyDecisionKey(request.bundleSha256, request.clientSnapshotSha256, request.canonicalInput);
    const second = policyDecisionKey(request.bundleSha256, request.clientSnapshotSha256, request.canonicalInput);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});
