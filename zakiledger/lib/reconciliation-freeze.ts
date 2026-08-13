/**
 * Write-freeze guard for reconciliation mutation endpoints.
 *
 * When ZAKI_RECONCILIATION_WRITE_FREEZE=1, all reconciliation-spine
 * mutation endpoints return 503 BEFORE any DB/store mutation.
 * Read-only routes are unaffected.
 */
export function isReconciliationWriteFrozen(): boolean {
  return process.env.ZAKI_RECONCILIATION_WRITE_FREEZE === "1";
}

export function reconciliationFreezeResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Reconciliation writes are temporarily frozen for maintenance",
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * Store-level freeze guard. Routes check the flag first and return the 503
 * response above; this assertion is the second line of defense for every
 * write function in the reconciliation stores, so that background writers,
 * scripts, and future callers can never mutate while the freeze is on —
 * regardless of schema version. It must run BEFORE capability detection,
 * tenant resolution, or any database call.
 */
export class ReconciliationWriteFrozenError extends Error {
  constructor() {
    super("Reconciliation writes are temporarily frozen for maintenance");
    this.name = "ReconciliationWriteFrozenError";
  }
}

export function assertReconciliationWritesNotFrozen(): void {
  if (isReconciliationWriteFrozen()) {
    throw new ReconciliationWriteFrozenError();
  }
}
