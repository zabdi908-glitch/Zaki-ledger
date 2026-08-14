-- Step 4F-B: inspect canonical_audit_ledger rows (read-only).
SELECT id::text, action, entity_kind, actor_kind,
       COALESCE(actor_user_id::text,'') AS actor_user_id,
       COALESCE(actor_service,'') AS actor_service,
       COALESCE(request_id,'') AS request_id,
       COALESCE((metadata_redacted->>'bootstrap_version'), '') AS bootstrap_version,
       COALESCE((metadata_redacted->>'migration_version'), '') AS migration_version,
       occurred_at::text
FROM public.canonical_audit_ledger
ORDER BY occurred_at DESC
LIMIT 12;
