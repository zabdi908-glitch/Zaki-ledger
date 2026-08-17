# Snapshot Extraction Queries — Read-Only Production Capture Tooling

These are the READ-ONLY queries used to capture the accepted production
snapshot (2026-08-16) that the committed manifests were built from. They are
committed so the snapshot can be re-captured from an authorized production
read window and compared, hash-for-hash, against the provenance recorded in
`manifests/manifest-identities.json`.

**Nothing here mutates.** Every file is a pure `SELECT` (or read-only
catalog query); the production wrapper additionally enforces a read-only
session.

## Capture procedure (authorized read window only)

1. Run each numbered query through the guarded read-only wrapper, which
   fixes the target to production and prepends
   `SET default_transaction_read_only = on;`:

   ```bash
   supabase/prod-readonly-query.sh repair-013-pre/extract/00-identity.sql
   ```

   (The wrapper refuses any mutation keyword and refuses every project ref
   except production `fqvekbzwghjurkcawpgg`. The legacy project
   `gzwtxebgevgapchoslmp` is never a target.)

2. Store the JSON outputs as `04-endpoints.json`, `05-matches.json`,
   `06-audit.json`, `10-approvals.json` in the snapshot directory
   (historically `/tmp/zaki-repair-design/`; any path works via
   `--snapshot-dir`).

3. Verify the captured files against the recorded provenance:

   ```bash
   python3 bin/build_repair_package.py --snapshot-dir <dir> verify \
     --auth-manifest manifests/stage2-rehearsal-authorization-manifest.json
   ```

   `verify` recomputes the four snapshot-file SHA-256s, re-derives the
   classification, and proves the committed basis and manifests are
   byte-identical to a regeneration from the captured files.

## File map

| File | Captures |
|---|---|
| `00-identity.sql` | database/server identity at capture time |
| `01-baseline.sql`, `01a-counts.sql` | table counts / baseline invariants |
| `02-columns.sql`, `03-tables.sql`, `03b/03c/03d-cols.sql` | schema-object parity |
| `04-inventory-endpoints.sql` | duplicate-endpoint inventory (107) |
| `05-inventory-matches.sql` | match-row inventory (573) |
| `06-audit.sql` | audit events (match_approved ×409) |
| `07-canonical.sql` | canonical layer state |
| `08-evidence.sql` | per-endpoint evidence details |
| `09-qb-all.sql` | QB transaction universe |
| `10-approvals.sql` | approval events |
| `11-smoke.sql` | smoke rows (08-14 uploads) |
| `12-parity.sql` | capture-time parity assertions |

Production row contents are NEVER committed; only the read-only queries and
the derived hash-locked manifests are.
