#!/usr/bin/env bash
# Restore a faithful scratch copy of the production snapshot into the local
# Supabase Postgres (scratch database `repair_drill`) for rehearsal.
#
# NEVER runs against production — it only talks to the local container
# ($CONTAINER, default supabase_db_Zaki-ledger).
#
# Dump inputs are explicit parameters (no hardcoded dated filenames):
#   --schema-dump <file>    schema dump (default $DUMP_DIR/prod-schema-2026-08-16.sql)
#   --data-dump <file>      data dump (default $DUMP_DIR/prod-data-2026-08-16.sql)
#   --schema-sha256 <sha>   optional: verify the schema dump hash before restore
#   --data-sha256 <sha>     optional: verify the data dump hash before restore
#
# Restore prerequisites discovered and documented in
# docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md §14:
#   - pre-create schemas extensions + vault;
#   - create publication supabase_realtime;
#   - restore a Supabase auth schema (locally exported bootstrap);
#   - seed the two production user identity anchors referenced by the
#     snapshot into auth.users (scratch-only; production's auth.users
#     already contains them — the scratch copy must mirror that for
#     fk_audit_log_user ON DELETE RESTRICT to behave identically);
#   - run restores as supabase_admin.
set -euo pipefail

DUMP_DIR="${DUMP_DIR:-/tmp/zaki-repair-design/dumps}"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
SCHEMA_DUMP="$DUMP_DIR/prod-schema-2026-08-16.sql"
DATA_DUMP="$DUMP_DIR/prod-data-2026-08-16.sql"
SCHEMA_SHA256=""
DATA_SHA256=""

while [ $# -gt 0 ]; do
  case "$1" in
    --schema-dump) SCHEMA_DUMP="$2"; shift 2;;
    --data-dump) DATA_DUMP="$2"; shift 2;;
    --schema-sha256) SCHEMA_SHA256="$2"; shift 2;;
    --data-sha256) DATA_SHA256="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2
       echo "usage: $0 [--schema-dump F] [--data-dump F] [--schema-sha256 S] [--data-sha256 S]" >&2
       exit 2;;
  esac
done

[ -f "$SCHEMA_DUMP" ] || { echo "error: schema dump not found: $SCHEMA_DUMP" >&2; exit 2; }
[ -f "$DATA_DUMP" ] || { echo "error: data dump not found: $DATA_DUMP" >&2; exit 2; }

if [ -n "$SCHEMA_SHA256" ]; then
  GOT="$(sha256sum "$SCHEMA_DUMP" | awk '{print $1}')"
  [ "$GOT" = "$SCHEMA_SHA256" ] \
    || { echo "error: schema dump sha256 $GOT != expected $SCHEMA_SHA256" >&2; exit 2; }
  echo "schema dump hash verified: $GOT"
fi
if [ -n "$DATA_SHA256" ]; then
  GOT="$(sha256sum "$DATA_DUMP" | awk '{print $1}')"
  [ "$GOT" = "$DATA_SHA256" ] \
    || { echo "error: data dump sha256 $GOT != expected $DATA_SHA256" >&2; exit 2; }
  echo "data dump hash verified: $GOT"
fi

# supabase_admin is the container's superuser; postgres lacks superuser, so
# database create/drop runs as supabase_admin (the container's `postgres`
# role is NOT superuser in the current Supabase image).
docker exec "$CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS ${DB};" -c "CREATE DATABASE ${DB};"

docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS vault;
SQL

# The publication is cluster-wide; CREATE PUBLICATION has no IF NOT EXISTS.
if [ "$(docker exec "$CONTAINER" psql -U supabase_admin -d "$DB" -tAc \
  "SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'")" != "1" ]; then
  docker exec "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 \
    -c "CREATE PUBLICATION supabase_realtime;"
fi

# Supabase auth schema (local bootstrap export). It already contains the two
# production user identity anchors referenced by the snapshot
# (38832e8e-…, 0042d6e0-…), which satisfies fk_audit_log_user exactly as
# production's own auth.users does. A scratch restore whose auth schema
# lacked them would need them seeded before the repair (documented in
# execution-window.md §4 — fresh dumps at window time may differ).
AUTH_SCHEMA="$DUMP_DIR/local-auth-schema.sql"
[ -f "$AUTH_SCHEMA" ] || { echo "error: auth bootstrap not found: $AUTH_SCHEMA" >&2; exit 2; }
docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 \
  < "$AUTH_SCHEMA"

docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 \
  < "$SCHEMA_DUMP"

docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 \
  < "$DATA_DUMP"

echo "restore complete: database ${DB}"
