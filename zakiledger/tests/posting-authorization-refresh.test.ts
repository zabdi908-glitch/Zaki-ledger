import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PostingAuthorizationRefreshService } from "../lib/posting-authorization-refresh";

const ACTOR_ID = "e1000000-0000-4000-8000-000000000001";
const VENDOR_ID = "e1000000-0000-4000-8000-000000000002";
const BILL_ID = "e1000000-0000-4000-8000-000000000003";
const REQUEST_ID = "e1000000-0000-4000-8000-000000000004";

describe("posting human-authorization refresh service", () => {
  it("passes only the authenticated actor, existing operation IDs, idempotency key, and fixed TTL", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        kind: "REFRESHED",
        authorizations: [
          { operationId: VENDOR_ID, authorizationId: "auth-1", expiresAt: "future", refreshed: true },
          { operationId: BILL_ID, authorizationId: "auth-2", expiresAt: "future", refreshed: true },
        ],
      },
      error: null,
    });
    const service = new PostingAuthorizationRefreshService({ rpc } as never);
    await expect(service.refresh({
      actorUserId: ACTOR_ID,
      operationIds: [VENDOR_ID, BILL_ID],
      refreshRequestId: REQUEST_ID,
    })).resolves.toMatchObject({ kind: "REFRESHED" });
    expect(rpc).toHaveBeenCalledWith("refresh_posting_human_authorizations_v1", {
      p_operation_ids: [VENDOR_ID, BILL_ID],
      p_actor_user_id: ACTOR_ID,
      p_refresh_request_id: REQUEST_ID,
      p_ttl_seconds: 3600,
    });
  });

  it("propagates a fail-closed RPC result without inventing authorization", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { kind: "BLOCKED", operationId: BILL_ID, reasonCode: "CURRENT_TAX_MAPPING_INVALID" },
      error: null,
    });
    const service = new PostingAuthorizationRefreshService({ rpc } as never);
    await expect(service.refresh({
      actorUserId: ACTOR_ID,
      operationIds: [BILL_ID],
      refreshRequestId: REQUEST_ID,
    })).resolves.toEqual({
      kind: "BLOCKED",
      operationId: BILL_ID,
      reasonCode: "CURRENT_TAX_MAPPING_INVALID",
    });
  });

  it("does not expose database error payloads as a successful result", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "database secret" } });
    const service = new PostingAuthorizationRefreshService({ rpc } as never);
    await expect(service.refresh({
      actorUserId: ACTOR_ID,
      operationIds: [VENDOR_ID],
      refreshRequestId: REQUEST_ID,
    })).rejects.toThrow("Posting authorization refresh failed");
  });
});

describe("migration 025 authorization-refresh contract", () => {
  const migration = readFileSync(
    join(process.cwd(), "..", "supabase", "migrations", "025_posting_human_authorization_refresh.sql"),
    "utf8",
  );

  it("requires an authorized actor and exact active destination scope", () => {
    expect(migration).toContain("posting_actor_can_post_v1");
    expect(migration).toContain("'ACTOR_UNAUTHORIZED'");
    expect(migration).toContain("connection.external_organisation_id = v_operation.external_organisation_id");
    expect(migration).toContain("connection.status = 'active'");
  });

  it("revalidates current immutable evidence and account/tax mappings before any write", () => {
    const validation = migration.indexOf("posting_dispatch_evidence_status_v1");
    const insert = migration.indexOf("INSERT INTO public.posting_human_authorizations");
    expect(validation).toBeGreaterThan(0);
    expect(validation).toBeLessThan(insert);
    expect(migration).toContain("eligible_provider_posting_accounts");
    expect(migration).toContain("eligible_provider_tax_treatments");
    expect(migration).toContain("mapping.evidence_fingerprint");
  });

  it("copies the exact immutable operation scope and fingerprint into a fresh approval", () => {
    expect(migration).toContain("v_operation.authorized_request_fingerprint");
    expect(migration).toContain("v_operation.operation_kind");
    expect(migration).toContain("v_operation.external_object_type");
    expect(migration).toContain("v_expires_at := now() + make_interval");
    expect(migration).toContain("'immutableIntentFingerprint'");
  });

  it("keeps approval history append-only and writes a user-attributed audit event", () => {
    expect(migration).toContain("INSERT INTO public.posting_human_authorizations");
    expect(migration).not.toMatch(/UPDATE public\.posting_human_authorizations/);
    expect(migration).not.toMatch(/DELETE FROM public\.posting_human_authorizations/);
    expect(migration).toContain("'MANUAL_INTERVENTION', 'POSTING_HUMAN_AUTHORIZATION_REFRESHED'");
    expect(migration).toContain("'USER', p_actor_user_id");
  });

  it("changes no posting intent and creates no posting operation", () => {
    expect(migration).not.toContain("INSERT INTO public.posting_operations");
    expect(migration).toMatch(/SET human_authorization_id = v_new_authorization_id,\s+row_version = row_version \+ 1/);
    expect(migration).not.toMatch(/SET[\s\S]{0,200}(requested_object|evidence_snapshot|account_treatment_snapshot|tax_treatment_snapshot)/);
  });

  it("serializes batches and makes an exact refresh request replay-safe", () => {
    expect(migration).toContain("ORDER BY id FOR UPDATE");
    expect(migration).toContain("refreshRequestId");
    expect(migration).toContain("'refreshed', false");
  });

  it("grants only the service role and contains no provider call or posting dispatch", () => {
    expect(migration).toContain("TO service_role");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated, service_role");
    expect(migration).not.toMatch(/fetch\(|createVendor|createBill|PROVIDER_RESPONSE|DISPATCH'/);
  });
});
