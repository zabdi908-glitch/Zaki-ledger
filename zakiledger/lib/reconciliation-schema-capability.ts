import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reconciliation-schema capability detection.
 *
 * The reconciliation write paths must behave differently depending on which
 * schema they run against:
 *
 *  - pre-012 (Migration 011 and earlier): the pre-4C write behavior — no
 *    canonical tenant resolution, no canonical stamps. The 012-only tenant
 *    RPCs do not exist yet.
 *  - canonical-012 (Migration 012 applied): canonical tenant resolution and
 *    canonical stamping are MANDATORY. There is no legacy fallback; every
 *    registry/RPC failure fails closed.
 *
 * Exactly one condition may produce `{ version: "pre-012" }`:
 *
 *   The dedicated capability probe — an RPC call to the 012-only function
 *   `canonical_default_tenant_ids_v1` — returns PostgREST error PGRST202
 *   ("Could not find the function ...") naming that function. That error is
 *   PostgREST's deterministic "function absent from the schema cache"
 *   signal; it cannot arise from registry state, permissions, timeouts, or
 *   tenant validation.
 *
 * Every other outcome is either `{ version: "canonical-012" }` — the probe
 * executed, even when it raised a domain error (unknown probe id, role
 * check), which proves the function exists — or an exception, for transport
 * failures and malformed responses (an error object with no PostgREST code).
 * Nothing else may ever downgrade to the legacy path.
 *
 * Caching: deliberately NONE. Capability is re-evaluated at every write.
 * Pilot volume is small, so one cheap probe RPC per write is the correct
 * tradeoff during the 011→012 maintenance transition: a process that
 * cached PRE_012 across the moment Migration 012 commits could otherwise
 * take the legacy path against a 012 schema. With no cache, the very next
 * write after the migration sees the 012 function and takes the canonical
 * path. (Legacy writes against a freshly-migrated 012 schema would in any
 * case fail closed at the database layer — the 012 write-guard triggers
 * reject rows without canonical stamps — but the app must not rely on that
 * backstop when a per-write probe removes the race entirely.)
 *
 * The in-memory fallback (no database configured) is classified pre-012:
 * its write behavior is exactly the pre-4C in-memory store.
 */

export type ReconciliationSchemaCapability =
  | { version: "pre-012" }
  | { version: "canonical-012" };

/** The 012-only canonical tenant RPC used as the capability probe. */
export const CAPABILITY_PROBE_FUNCTION = "canonical_default_tenant_ids_v1";

/** The 013-only claim-hardening RPC used as the claim-guard capability probe. */
export const CLAIM_GUARD_PROBE_FUNCTION = "persist_auto_matches_v1";

/**
 * A UUID that is guaranteed not to exist in auth.users, so on a 012 schema
 * the probe exercises only function resolution (raising the RPC's own
 * registry error, which still proves the function exists).
 */
export const CAPABILITY_PROBE_USER_ID = "00000000-0000-0000-0000-000000000000";

interface ProbeError {
  code?: string;
  message?: string;
}

/**
 * Detect which reconciliation schema the current database runs.
 *
 * Throws on transport failures / malformed responses (an error with no
 * PostgREST code, or a rejected RPC promise) — a broken or unreachable
 * database must fail closed, never downgrade to legacy writes.
 */
export async function detectReconciliationSchemaCapability(
  db: SupabaseClient | null,
): Promise<ReconciliationSchemaCapability> {
  if (!db) {
    // In-memory fallback: pre-4C behavior, no canonical stamping.
    return { version: "pre-012" };
  }

  let data: unknown;
  let error: ProbeError | null;
  try {
    ({ data, error } = await db.rpc(CAPABILITY_PROBE_FUNCTION, {
      p_user_id: CAPABILITY_PROBE_USER_ID,
    }));
  } catch (err) {
    throw new Error(
      `Reconciliation schema capability probe failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (error) {
    const isKnownAbsence =
      error.code === "PGRST202" &&
      typeof error.message === "string" &&
      error.message.includes(CAPABILITY_PROBE_FUNCTION);

    if (isKnownAbsence) {
      return { version: "pre-012" };
    }

    if (error.code === "PGRST202") {
      // PGRST202 that does NOT name the probe function: malformed response.
      // Only the exact verified absence condition may downgrade to legacy.
      throw new Error(
        `Reconciliation schema capability probe returned an unexpected PGRST202: ${error.message ?? "no message"}`,
      );
    }

    if (error.code) {
      // PostgREST delivered a defined error for a function that therefore
      // exists and executed (unknown probe id, role check, registry state...).
      // The schema is 012; later canonical resolution enforces the rest.
      return { version: "canonical-012" };
    }

    // No PostgREST code: transport failure or malformed response.
    throw new Error(
      `Reconciliation schema capability probe failed: ${error.message ?? "unknown error"}`,
    );
  }

  // The probe executed successfully — the function exists.
  void data;
  return { version: "canonical-012" };
}

export type ReconciliationClaimGuardCapability =
  | { version: "pre-013" }
  | { version: "canonical-013" };

/**
 * Detect whether migration 013's claim-hardening surface (exclusive-claim
 * index + atomic persist RPC + controlled correction RPC) is present.
 *
 * Same deterministic contract as the 012 probe: exactly one condition may
 * produce pre-013 — the dedicated probe RPC returning PGRST202 naming
 * `persist_auto_matches_v1` (PostgREST's deterministic "function absent"
 * signal). Every other defined error proves the function exists (canonical-
 * 013), and transport/malformed failures throw. No cache, no silent
 * downgrade.
 */
export async function detectReconciliationClaimGuardCapability(
  db: SupabaseClient | null,
): Promise<ReconciliationClaimGuardCapability> {
  if (!db) {
    return { version: "pre-013" };
  }

  let error: ProbeError | null;
  try {
    ({ error } = await db.rpc(CLAIM_GUARD_PROBE_FUNCTION, {
      p_user_id: CAPABILITY_PROBE_USER_ID,
      p_statement_id: CAPABILITY_PROBE_USER_ID,
      p_client_entity_id: CAPABILITY_PROBE_USER_ID,
      p_matches: [],
    }));
  } catch (err) {
    throw new Error(
      `Reconciliation claim-guard capability probe failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (error) {
    const isKnownAbsence =
      error.code === "PGRST202" &&
      typeof error.message === "string" &&
      error.message.includes(CLAIM_GUARD_PROBE_FUNCTION);

    if (isKnownAbsence) {
      return { version: "pre-013" };
    }

    if (error.code) {
      // A defined error for a function that exists and executed (unknown
      // probe ids, role checks...) — the 013 surface is present.
      return { version: "canonical-013" };
    }

    throw new Error(
      `Reconciliation claim-guard capability probe failed: ${error.message ?? "unknown error"}`,
    );
  }

  return { version: "canonical-013" };
}
