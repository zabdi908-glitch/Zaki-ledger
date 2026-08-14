-- Step 4F-B Phase 0 evidence: auth user -> registry mapping (read-only).
SELECT u.id AS user_id, u.email,
       r.practice_id, r.practice_membership_id, r.client_entity_id, r.internal_ledger_book_id
FROM auth.users u
LEFT JOIN public.default_tenant_identities r ON r.user_id = u.id
ORDER BY u.email;
