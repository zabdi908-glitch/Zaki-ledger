#!/usr/bin/env bash
# Restore a faithful scratch copy of the production snapshot into the local
# Supabase Postgres (scratch database `repair_drill`) for rehearsal.
#
# Reads the production dumps from $DUMP_DIR (default /tmp/zaki-repair-design/dumps).
# NEVER runs against production — it only talks to the local container
# ($CONTAINER, default supabase_db_Zaki-ledger).
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
# execution-window.md §2 — fresh dumps at window time may differ).
docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 \
  < "$DUMP_DIR/local-auth-schema.sql"

docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 \
  < "$DUMP_DIR/prod-schema-2026-08-16.sql"

docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 \
  < "$DUMP_DIR/prod-data-2026-08-16.sql"

echo "restore complete: database ${DB}"
