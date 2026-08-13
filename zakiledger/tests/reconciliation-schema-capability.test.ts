/**
 * Reconciliation schema capability detection — narrow contract.
 *
 * Exactly one condition produces `{ version: "pre-012" }`:
 *   the 012 canonical tenant RPC `canonical_default_tenant_ids_v1` is absent
 *   from PostgREST's schema cache, reported as error code PGRST202 with the
 *   function name in the message.
 *
 * Every other outcome is either `{ version: "canonical-012" }` (the function
 * exists and executed — even when it raised a domain error for the probe id)
 * or propagates as an exception (transport failure / malformed response).
 * This guarantees a broken or unreachable 012 database fails closed and can
 * never be mistaken for a legacy 011 schema.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectReconciliationSchemaCapability } from "../lib/reconciliation-schema-capability";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function fakeDb(rpcImpl: () => Promise<{ data?: unknown; error?: { code?: string; message?: string } | null }>) {
  const rpc = vi.fn(rpcImpl);
  return { rpc } as unknown as { rpc: typeof rpc };
}

describe("detectReconciliationSchemaCapability", () => {
  it("reports canonical-012 when the probe RPC executes successfully", async () => {
    const db = fakeDb(async () => ({ data: [{ practice_id: "p" }], error: null }));
    const cap = await detectReconciliationSchemaCapability(db as unknown as SupabaseClient);
    expect(cap).toEqual({ version: "canonical-012" });
    expect(db.rpc).toHaveBeenCalledWith("canonical_default_tenant_ids_v1", {
      p_user_id: ZERO_UUID,
    });
  });

  it("reports pre-012 exactly when PostgREST says the function is absent", async () => {
    const db = fakeDb(async () => ({
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.canonical_default_tenant_ids_v1(uuid) in the schema cache",
      },
    }));
    const cap = await detectReconciliationSchemaCapability(db as unknown as SupabaseClient);
    expect(cap).toEqual({ version: "pre-012" });
  });

  it("throws when PGRST202 names a different function (narrow contract)", async () => {
    const db = fakeDb(async () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.other_fn()" },
    }));
    await expect(detectReconciliationSchemaCapability(db as unknown as SupabaseClient)).rejects.toThrow(/PGRST202/);
  });

  it("reports canonical-012 when the probe raises a registry error (function exists)", async () => {
    const db = fakeDb(async () => ({
      data: null,
      error: { code: "23503", message: "default tenant identity not found for user" },
    }));
    const cap = await detectReconciliationSchemaCapability(db as unknown as SupabaseClient);
    expect(cap).toEqual({ version: "canonical-012" });
  });

  it("reports canonical-012 when the probe raises a permission error (function exists)", async () => {
    const db = fakeDb(async () => ({
      data: null,
      error: { code: "42501", message: "permission denied for function" },
    }));
    const cap = await detectReconciliationSchemaCapability(db as unknown as SupabaseClient);
    expect(cap).toEqual({ version: "canonical-012" });
  });

  it("throws on a transport failure (error without a PostgREST code)", async () => {
    const db = fakeDb(async () => ({ data: null, error: { message: "fetch failed" } }));
    await expect(detectReconciliationSchemaCapability(db as unknown as SupabaseClient)).rejects.toThrow();
  });

  it("throws when the RPC call itself rejects (network exception)", async () => {
    const db = { rpc: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) } as never;
    await expect(detectReconciliationSchemaCapability(db as unknown as SupabaseClient)).rejects.toThrow("ECONNREFUSED");
  });

  it("reports pre-012 for the in-memory fallback (no database client)", async () => {
    const cap = await detectReconciliationSchemaCapability(null);
    expect(cap).toEqual({ version: "pre-012" });
  });
});
