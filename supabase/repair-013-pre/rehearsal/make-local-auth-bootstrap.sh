#!/usr/bin/env bash
# Generate the rehearsal auth-schema bootstrap from the LOCAL Supabase stack
# (NEVER from production).
#
# The scratch restore needs a Supabase `auth` schema whose auth.users
# contains the two production user identity anchors referenced by the
# snapshot (38832e8e-…, 0042d6e0-…): production's own auth.users contains
# them, and the scratch copy must mirror that for
# fk_audit_log_user ON DELETE RESTRICT to behave identically
# (docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md §14).
#
# Usage:  rehearsal/make-local-auth-bootstrap.sh [output.sql]
#         (default: $DUMP_DIR/local-auth-schema.sql, DUMP_DIR defaults to
#          /tmp/zaki-repair-design/dumps)
#
# The export is schema+local-test-data of the LOCAL stack only; production
# dumps are never consumed here.
set -euo pipefail

DUMP_DIR="${DUMP_DIR:-/tmp/zaki-repair-design/dumps}"
OUT="${1:-$DUMP_DIR/local-auth-schema.sql}"

mkdir -p "$(dirname "$OUT")"

echo "exporting local auth schema (local stack only)…"
supabase db dump --local --schema auth -f "$OUT"

# Seed the two production user identity anchors if the export lacks them
# (a freshly reset local stack does). Identities mirror production's
# auth.users rows for the snapshot's FK anchors — no production data.
ANCHORS="$(
  grep -c "38832e8e-fa0f-45a3-96ce-3cb6da270cbe\|0042d6e0-" "$OUT" || true
)"
if [ "$ANCHORS" -lt 2 ]; then
  echo "seeding the two production user identity anchors…"
  cat >> "$OUT" <<'SQL'

-- Scratch-only identity anchors for the snapshot's FK references
-- (production's auth.users already contains these two rows).
INSERT INTO auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000',
   '38832e8e-fa0f-45a3-96ce-3cb6da270cbe', 'authenticated', 'authenticated',
   'scratch-anchor-1@zaki-repair.local', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000',
   '0042d6e0-86f5-4c2e-970e-a0c7ac04106a', 'authenticated', 'authenticated',
   'scratch-anchor-2@zaki-repair.local', '', now(), '{}', '{}', now(), now())
ON CONFLICT (id) DO NOTHING;
SQL
fi

echo "auth bootstrap written to $OUT"
