import { pathToFileURL } from "node:url";
import { runNightlyMatch } from "../lib/nightly-match";
import { getSupabase } from "../lib/supabase";
import { isReconciliationWriteFrozen } from "../lib/reconciliation-freeze";

export async function main() {
  if (isReconciliationWriteFrozen()) {
    console.log("Reconciliation writes are frozen — nightly match aborted.");
    process.exit(0);
  }

  const db = getSupabase();
  if (!db) {
    console.error("Database not configured — aborting nightly match.");
    process.exit(1);
  }

  const { data, error } = await db.auth.admin.listUsers();
  if (error) {
    console.error(`Failed to list users: ${error.message}`);
    process.exit(1);
  }

  let totalStatements = 0;
  let totalMatches = 0;

  for (const user of data.users) {
    try {
      const result = await runNightlyMatch(user.id);
      totalStatements += result.statementsProcessed;
      totalMatches += result.matchesFound;
      if (result.errors.length > 0) {
        console.warn(`[${user.id}] errors:`, result.errors);
      }
    } catch (err) {
      console.error(`[${user.id}] failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log(`Nightly match complete: ${data.users.length} users, ${totalStatements} statements, ${totalMatches} matches`);
  process.exit(0);
}


// Auto-run only when executed directly (tsx scripts/nightly-match.ts). When the
// module is imported (tests), main() is exported so the freeze guard can be
// exercised in-process without spawning a child process.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main();
}
