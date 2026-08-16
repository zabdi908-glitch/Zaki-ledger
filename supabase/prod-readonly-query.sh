#!/usr/bin/env bash
# Guarded read-only production query wrapper (Zaki Ledger).
#
# The ONLY acceptable remote target is production fqvekbzwghjurkcawpgg.
# The legacy project gzwtxebgevgapchoslmp must never be queried again and is
# refused here. The local CLI is intentionally unlinked; every remote command
# must name its target explicitly, and this wrapper fixes it to production.
#
# Usage: supabase/prod-readonly-query.sh <sql-file>
#
# Guarantees:
#   - explicit --project-ref fqvekbzwghjurkcawpgg only (legacy refused);
#   - SET default_transaction_read_only = on; is prepended to the session;
#   - a keyword scan refuses files whose statements mutate data/objects
#     (heuristic; the DB-side read-only guard remains the authority).
set -euo pipefail

PROD_REF="fqvekbzwghjurkcawpgg"
LEGACY_REF="gzwtxebgevgapchoslmp"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <sql-file>" >&2
  exit 2
fi
FILE="$1"
[ -f "$FILE" ] || { echo "error: not a file: $FILE" >&2; exit 2; }

# Heuristic mutation scan on non-comment lines (DB guard is authoritative).
if grep -vE '^\s*--' "$FILE" | grep -qEi '^\s*(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|reindex|cluster|refresh|call|do|merge|begin|commit|rollback)\b'; then
  echo "refusing: file contains SQL statements that can mutate data or objects." >&2
  echo "repair/migration SQL is executed only through an explicitly authorized," >&2
  echo "separately reviewed operation — never through this wrapper." >&2
  exit 3
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
{
  echo "SET default_transaction_read_only = on;"
  cat "$FILE"
} > "$TMP"

supabase db query --linked --project-ref "$PROD_REF" -f "$TMP"
