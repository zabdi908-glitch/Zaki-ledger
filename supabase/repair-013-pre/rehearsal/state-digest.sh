#!/usr/bin/env bash
# Deterministic full-state digest of every table the repair can touch or
# depend on (blocker 6: full state-preservation tests). Emits JSON:
#   {"<schema>.<table>": "<sha256>", ...}
# Each table digest = sha256 over the canonical rendering of
# jsonb_agg(to_jsonb(row) ORDER BY id) — deterministic row order, canonical
# value encoding, no string-concatenation ambiguity. Session settings are
# pinned (UTC, ISO datestyle) so timestamptz rendering is identical across
# runs, restores, and sessions.
#
# On any expected repair failure, before-digest == after-digest proves ZERO
# partial changes (not just "no repair rows").
#
# Usage: state-digest.sh [db]   (default db: repair_drill, local container)
set -euo pipefail

CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${1:-repair_drill}"

TABLES="
public.reconciliation_matches
public.reconciliation_audit_log
public.bank_transactions
public.qb_transactions
public.bank_statements
public.client_entities
public.practices
public.ledger_books
public.financial_relationship_endpoints
public.financial_allocations
public.canonical_audit_ledger
"

PSQL="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"
SETTINGS="SET TIME ZONE 'UTC'; SET datestyle = 'ISO, YMD';"

printf '{'
first=1
for t in $TABLES; do
  if [ "$first" != "1" ]; then printf ','; fi
  first=0
  digest=$($PSQL -tAc "$SETTINGS SELECT encode(extensions.digest(convert_to(coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM $t t), '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex');")
  printf '"%s":"%s"' "$t" "$digest"
done
printf '}\n'
