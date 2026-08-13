/**
 * TenantContext — canonical tenant identity for reconciliation-spine operations.
 *
 * Resolved through the read-only self-context RPC
 * `canonical_default_tenant_context_for_self_v1()`.
 * No bootstrap.  No client-supplied IDs trusted.  Fail-closed.
 */
import { getSupabase } from "./supabase";
import { detectReconciliationSchemaCapability } from "./reconciliation-schema-capability";

export interface TenantContext {
  userId: string;
  practiceId: string;
  practiceMembershipId: string;
  clientEntityId: string;
  internalLedgerBookId: string;
}

/**
 * Resolve the authenticated user's canonical tenant context.
 *
 * Calls only the read-only SECURITY DEFINER RPC.  No ensure_* path.
 * Returns controlled errors — never creates tenant state.
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const db = getSupabase();
  if (!db) {
    throw new Error("Tenant context unavailable — database not configured");
  }

  const { data, error } = await db.rpc(
    "canonical_default_tenant_context_for_self_v1",
  );

  if (error) {
    throw new Error(
      `Canonical tenant context resolution failed: ${error.message}`,
    );
  }

  if (!data || (Array.isArray(data) && data.length === 0)) {
    throw new Error(
      "Canonical tenant context not found — user may not have completed onboarding",
    );
  }

  // The RPC returns a single row with four UUIDs
  const row = Array.isArray(data) ? data[0] : data;

  if (
    !row.practice_id ||
    !row.practice_membership_id ||
    !row.client_entity_id ||
    !row.internal_ledger_book_id
  ) {
    throw new Error("Canonical tenant context is incomplete");
  }

  return {
    userId: "", // caller must supply from auth (RPC resolves from JWT, not passed back)
    practiceId: row.practice_id,
    practiceMembershipId: row.practice_membership_id,
    clientEntityId: row.client_entity_id,
    internalLedgerBookId: row.internal_ledger_book_id,
  };
}

/**
 * Resolve canonical tenant context for a known userId using the service_role
 * helper RPC.  Used by store functions that already operate under service_role
 * and have the userId from the calling route.
 */
export async function resolveTenantContextForUser(
  userId: string,
): Promise<TenantContext> {
  const db = getSupabase();
  if (!db) {
    throw new Error("Tenant context unavailable — database not configured");
  }

  const { data, error } = await db.rpc("canonical_default_tenant_ids_v1", {
    p_user_id: userId,
  });

  if (error) {
    throw new Error(
      `Canonical tenant context resolution failed: ${error.message}`,
    );
  }

  if (!data || (Array.isArray(data) && data.length === 0)) {
    throw new Error(
      "Canonical tenant context not found for user",
    );
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (
    !row.practice_id ||
    !row.practice_membership_id ||
    !row.client_entity_id ||
    !row.internal_ledger_book_id
  ) {
    throw new Error("Canonical tenant context is incomplete");
  }

  return {
    userId,
    practiceId: row.practice_id,
    practiceMembershipId: row.practice_membership_id,
    clientEntityId: row.client_entity_id,
    internalLedgerBookId: row.internal_ledger_book_id,
  };
}

/**
 * Canonical client stamp for a write, or null on a pre-012 schema.
 *
 * The narrow boundary where pre-012 write paths decide to skip canonical
 * tenant resolution: null is returned ONLY when the dedicated capability
 * probe verified that the 012 tenant RPC is absent. On a canonical-012
 * schema every resolution failure propagates — no silent downgrade.
 */
export async function resolveTenantClientEntityIdForWrite(
  userId: string,
): Promise<string | null> {
  const capability = await detectReconciliationSchemaCapability(getSupabase());
  if (capability.version === "pre-012") {
    return null;
  }
  const tenantCtx = await resolveTenantContextForUser(userId);
  return tenantCtx.clientEntityId;
}
