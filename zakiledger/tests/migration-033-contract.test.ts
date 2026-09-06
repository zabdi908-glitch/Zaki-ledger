import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const path = resolve(process.cwd(), "..", "supabase", "migrations", "033_audit_reversibility_foundation.sql");
const sql = readFileSync(path, "utf8");
const withoutComments = sql.replace(/--.*$/gm, "");

const tables = [
  "audit_streams",
  "audit_events",
  "audit_state_snapshots",
  "audit_event_links",
  "correction_operations",
  "correction_operation_steps",
  "correction_relationships",
  "provider_reversibility_bundles",
  "audit_integrity_checkpoints",
];

describe("migration 033 audit and reversibility foundation", () => {
  it("is atomic and additive and leaves Step 5 runtime persistence untouched", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(withoutComments).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    expect(withoutComments).not.toMatch(/ALTER\s+TABLE\s+public\.(?:posting_|provider_posting|quickbooks_)/i);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(?:claim_posting|transition_posting|prepare_quickbooks|dispatch_)/i);
  });

  it("creates all nine requested record families with RLS and tenant-scoped reads", () => {
    for (const table of tables) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE public\\.${table}\\b`, "i"));
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"));
    }
    expect(sql).toContain("canonical_can_access_client_v1(client_entity_id)");
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*TO/i);
  });

  it("makes audit facts, snapshots, links, corrections, bundles, and checkpoints immutable", () => {
    for (const table of tables.filter((table) => table !== "audit_streams")) {
      expect(sql).toMatch(new RegExp(`CREATE TRIGGER ${table}_[a-z_]*immutable`, "i"));
    }
    expect(sql).toContain("audit_streams_head_guard");
    expect(sql).toContain("audit stream head may only advance by one event");
  });

  it("serializes tenant streams and binds event-key retries to a chained event hash", () => {
    expect(sql).toContain("UNIQUE (client_entity_id, event_key)");
    expect(sql).toContain("UNIQUE (stream_id, stream_sequence)");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("AUDIT_EVENT_KEY_INTEGRITY_CONFLICT");
    expect(sql).toContain("previous_event_hash");
    expect(sql).toContain("v_previous_hash, v_event_hash");
  });

  it("stores immutable before/after state and fail-closed, non-authorizing linear plans", () => {
    expect(sql).toMatch(/snapshot_role\s+text NOT NULL CHECK \(snapshot_role IN \('BEFORE', 'AFTER', 'OBSERVED'\)\)/);
    expect(sql).toContain("before_snapshot_id                uuid NOT NULL");
    expect(sql).toContain("after_state_verification          text NOT NULL CHECK (after_state_verification = 'READ_BACK_AND_FINGERPRINT')");
    expect(sql).toContain("execution_permission_granted    boolean NOT NULL DEFAULT false CHECK (NOT execution_permission_granted)");
    expect(sql).toContain("execution_state                 text NOT NULL DEFAULT 'DISABLED' CHECK (execution_state = 'DISABLED')");
    expect(sql).toContain("compound correction plan must be contiguous and complete");
    expect(sql).toContain("ORIGINAL_OUTCOME_UNCERTAIN");
    expect(sql).toContain("(planner_decision <> 'SAFE_METHOD' AND step_count = 0)");
  });

  it("accepts only the exact ratified v1 capability artifact", () => {
    expect(sql).toContain("ONLY_RATIFIED_V1_REVERSIBILITY_BUNDLE_ACCEPTED");
    expect(sql).toContain("e192d819d7927ca9884bdc157afd668d2a89de10b4c607c257fdcac93bc5057f");
    expect(sql).toContain("v_bundle->>'grantsExecutionPermission' <> 'false'");
  });

  it("contains no provider mutation or correction execution routine", () => {
    expect(sql).not.toMatch(/\b(?:qboPost|createQuickBooksBill|createXeroDraftBill|executeCorrection|provider-adapters)\b/i);
    expect(sql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[^;]*(?:update|delete|void|archive|inactivate)_(?:qbo|xero|provider)/i);
  });
});
