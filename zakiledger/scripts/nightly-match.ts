import { runNightlyMatch } from "../lib/nightly-match";
import { getSupabase } from "../lib/supabase";

async function main() {
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

main();