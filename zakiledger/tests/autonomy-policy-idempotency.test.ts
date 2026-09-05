import { describe, expect, it } from "vitest";
import { InMemoryAutonomyPolicyDecisionStore } from "../lib/autonomy-policy-store";
import { requestFor } from "./autonomy-policy-fixtures";

describe("Step 7 decision idempotency", () => {
  it("returns the original decision for an identical retry", async () => {
    const store = new InMemoryAutonomyPolicyDecisionStore();
    const first = await store.evaluateAndRecord(requestFor(), { policyBundleId: "bundle", clientPolicySnapshotId: "snapshot", requestedBy: "test", correlationId: "first" });
    const retry = await store.evaluateAndRecord(requestFor(), { policyBundleId: "bundle", clientPolicySnapshotId: "snapshot", requestedBy: "test", correlationId: "retry" });
    expect(retry.id).toBe(first.id);
    expect(retry.decisionKey).toBe(first.decisionKey);
    expect(retry.reused).toBe(true);
    expect(store.size).toBe(1);
  });

  it("converges concurrent identical attempts on one immutable decision", async () => {
    const store = new InMemoryAutonomyPolicyDecisionStore();
    const records = await Promise.all(Array.from({ length: 12 }, () => store.evaluateAndRecord(requestFor(), { policyBundleId: "bundle", clientPolicySnapshotId: "snapshot", requestedBy: "test", correlationId: null })));
    expect(new Set(records.map((record) => record.id)).size).toBe(1);
    expect(store.size).toBe(1);
  });
});
