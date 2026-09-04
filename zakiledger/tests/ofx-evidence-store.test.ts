import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../lib/financial-identity";
import type { ParsedStatement } from "../lib/reconciliation-schema";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  download: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  resolveTenant: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({
  getSupabase: () => ({
    storage: { from: () => ({ upload: mocks.upload, download: mocks.download }) },
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.maybeSingle }),
      }),
    }),
  }),
}));

vi.mock("../lib/tenant-context", () => ({
  resolveTenantContextForUser: mocks.resolveTenant,
}));

import { MAX_OFX_UPLOAD_BYTES, retainOfxEvidence } from "../lib/ofx-evidence-store";

const userId = "11111111-1111-4111-8111-111111111111";
const clientEntityId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const rawBytes = new TextEncoder().encode("OFX raw bytes\r\n<BANKID>secret-bank\r\n<ACCTID>secret-account");
const hash = sha256Hex(rawBytes);
const parsed: ParsedStatement = {
  transactions: [],
  openingBalance: null,
  closingBalance: 100,
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  currency: "GBP",
  sourceProvider: "ofx",
  sourceOrganisationId: null,
  sourceAccountId: "a".repeat(64),
};

function successfulArtifact() {
  mocks.download.mockResolvedValue({ data: new Blob([rawBytes]), error: null });
  mocks.rpc.mockResolvedValue({ data: { artifact_id: artifactId, reused: false }, error: null });
  mocks.maybeSingle.mockResolvedValue({
    data: {
      id: artifactId,
      client_entity_id: clientEntityId,
      artifact_kind: "ofx_statement",
      content_sha256: `\\x${hash}`,
      content_length: rawBytes.byteLength,
      storage_state: "retained",
      archived_at: null,
    },
    error: null,
  });
}

describe("OFX immutable evidence retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenant.mockResolvedValue({
      userId,
      practiceId: "practice",
      practiceMembershipId: "membership",
      clientEntityId,
      internalLedgerBookId: "book",
    });
    mocks.upload.mockResolvedValue({ data: { path: "stored" }, error: null });
    successfulArtifact();
  });

  it("retains exact raw bytes without overwrite and registers verified OFX evidence", async () => {
    const result = await retainOfxEvidence({ userId, rawBytes, parsed });

    expect(result).toEqual({ artifactId, contentSha256: hash, contentLength: rawBytes.byteLength });
    const expectedKey = `${clientEntityId}/ofx/${hash}-${rawBytes.byteLength}`;
    expect(mocks.upload).toHaveBeenCalledWith(expectedKey, rawBytes, {
      contentType: "application/x-ofx",
      upsert: false,
    });
    expect(mocks.download).toHaveBeenCalledWith(expectedKey);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "ingest_import_artifact_v1",
      expect.objectContaining({
        p_client_entity_id: clientEntityId,
        p_artifact_kind: "ofx_statement",
        p_content_sha256_hex: hash,
        p_content_length: rawBytes.byteLength,
        p_actor_user_id: userId,
      }),
    );
    const rpcPayload = mocks.rpc.mock.calls[0][1];
    expect(JSON.stringify(rpcPayload)).not.toContain("secret-bank");
    expect(JSON.stringify(rpcPayload)).not.toContain("secret-account");
  });

  it("reuses a byte-identical existing object only after downloading and rehashing it", async () => {
    mocks.upload
      .mockResolvedValueOnce({ data: { path: "stored" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "The resource already exists" } });
    mocks.rpc.mockResolvedValue({ data: { artifact_id: artifactId, reused: true }, error: null });

    const first = await retainOfxEvidence({ userId, rawBytes, parsed });
    const second = await retainOfxEvidence({ userId, rawBytes, parsed });

    expect(first.artifactId).toBe(artifactId);
    expect(second.artifactId).toBe(artifactId);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.upload.mock.calls.every((call) => call[2]?.upsert === false)).toBe(true);
  });

  it("fails closed when bytes at an existing content-addressed key do not rehash", async () => {
    mocks.upload.mockResolvedValue({ data: null, error: { message: "The resource already exists" } });
    mocks.download.mockResolvedValue({ data: new Blob(["different bytes"]), error: null });

    await expect(retainOfxEvidence({ userId, rawBytes, parsed })).rejects.toThrow(/hash or length mismatch/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("uses only the tenant resolved from the authenticated user", async () => {
    await retainOfxEvidence({ userId, rawBytes, parsed });

    expect(mocks.resolveTenant).toHaveBeenCalledWith(userId);
    expect(mocks.rpc.mock.calls[0][1].p_client_entity_id).toBe(clientEntityId);
  });

  it("rejects an oversized OFX before tenant, storage, or database access", async () => {
    await expect(
      retainOfxEvidence({ userId, rawBytes: new Uint8Array(MAX_OFX_UPLOAD_BYTES + 1), parsed }),
    ).rejects.toThrow(/OFX upload must be between/);

    expect(mocks.resolveTenant).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
