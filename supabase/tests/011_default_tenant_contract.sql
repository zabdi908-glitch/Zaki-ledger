\set ON_ERROR_STOP on
-- Local integration contract for Migration 011.  It runs in one rolled-back
-- transaction, so it is safe against a local development database.
BEGIN;

CREATE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_value IS DISTINCT FROM true THEN
    RAISE EXCEPTION '011 assertion failed: %', p_message;
  END IF;
END;
$$;

-- 1, 2, 3, 9, 24: confirmed first user, isolation, repeated call, retry.
INSERT INTO auth.users (id, email, role, aud, email_confirmed_at, created_at, updated_at) VALUES
  ('01100000-0000-0000-0000-000000000001', '011-owner-a@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000002', '011-owner-b@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000003', '011-invited@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000004', '011-multi@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000005', '011-revoked@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000006', '011-service@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000007', '011-partial-membership@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000008', '011-partial-client@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000009', '011-partial-ledger@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000010', '011-wrong-owner@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000011', '011-failure@example.test', 'authenticated', 'authenticated', now(), now(), now()),
  ('01100000-0000-0000-0000-000000000012', '011-unconfirmed@example.test', 'authenticated', 'authenticated', NULL, now(), now());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '01100000-0000-0000-0000-000000000001', true);
SELECT public.ensure_default_tenant_for_self_v1();
SELECT public.ensure_default_tenant_for_self_v1(); -- retry after a hypothetical HTTP response loss
RESET ROLE;

-- Bootstrap owner B through the same public self surface so the later RLS
-- isolation assertion compares two canonical tenants, not a missing fixture.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '01100000-0000-0000-0000-000000000002', true);
SELECT public.ensure_default_tenant_for_self_v1();
RESET ROLE;

SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.default_tenant_identities WHERE user_id = '01100000-0000-0000-0000-000000000001'), 'owner A has one identity');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.practices p JOIN public.default_tenant_identities d ON d.practice_id = p.id WHERE d.user_id = '01100000-0000-0000-0000-000000000001' AND p.created_by_user_id = d.user_id), 'owner A has one default practice');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.practice_memberships m JOIN public.default_tenant_identities d ON d.practice_membership_id = m.id WHERE d.user_id = '01100000-0000-0000-0000-000000000001' AND m.role = 'owner' AND m.status = 'active'), 'owner A has one active owner membership');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.ledger_books l JOIN public.default_tenant_identities d ON d.internal_ledger_book_id = l.id WHERE d.user_id = '01100000-0000-0000-0000-000000000001' AND l.book_kind = 'internal'), 'owner A has one internal ledger');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.provider_connections pc JOIN public.default_tenant_identities d ON d.client_entity_id = pc.client_entity_id WHERE d.user_id = '01100000-0000-0000-0000-000000000001'), 'bootstrap creates no provider connection');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.financial_accounts fa JOIN public.default_tenant_identities d ON d.client_entity_id = fa.client_entity_id WHERE d.user_id = '01100000-0000-0000-0000-000000000001'), 'bootstrap creates no financial account');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.client_access ca JOIN public.default_tenant_identities d ON d.client_entity_id = ca.client_entity_id WHERE d.user_id = '01100000-0000-0000-0000-000000000001'), 'bootstrap creates no owner client access');

-- 6, 7, 8: non-default memberships never gate default bootstrap.
INSERT INTO public.practices (id, name, created_by_user_id) VALUES
  ('01110000-0000-0000-0000-000000000001', 'External practice one', '01100000-0000-0000-0000-000000000001'),
  ('01110000-0000-0000-0000-000000000002', 'External practice two', '01100000-0000-0000-0000-000000000001');
INSERT INTO public.practice_memberships (id, practice_id, user_id, role, status, valid_to) VALUES
  ('01120000-0000-0000-0000-000000000001', '01110000-0000-0000-0000-000000000001', '01100000-0000-0000-0000-000000000003', 'viewer', 'active', NULL),
  ('01120000-0000-0000-0000-000000000002', '01110000-0000-0000-0000-000000000001', '01100000-0000-0000-0000-000000000004', 'viewer', 'active', NULL),
  ('01120000-0000-0000-0000-000000000003', '01110000-0000-0000-0000-000000000002', '01100000-0000-0000-0000-000000000004', 'bookkeeper', 'active', NULL),
  ('01120000-0000-0000-0000-000000000004', '01110000-0000-0000-0000-000000000002', '01100000-0000-0000-0000-000000000005', 'viewer', 'revoked', now());

-- 17 and 23: service backfill and first successful authenticated login paths.
SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000006');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '01100000-0000-0000-0000-000000000003', true);
SELECT public.ensure_default_tenant_for_self_v1();
SELECT set_config('request.jwt.claim.sub', '01100000-0000-0000-0000-000000000004', true);
SELECT public.ensure_default_tenant_for_self_v1();
SELECT set_config('request.jwt.claim.sub', '01100000-0000-0000-0000-000000000005', true);
SELECT public.ensure_default_tenant_for_self_v1();
RESET ROLE;
SELECT pg_temp.assert_true((SELECT count(*) = 3 FROM public.default_tenant_identities WHERE user_id IN ('01100000-0000-0000-0000-000000000003','01100000-0000-0000-0000-000000000004','01100000-0000-0000-0000-000000000005')), 'external or revoked memberships do not block bootstrap');

-- 10, 11, 12: registry-null repair paths create only the missing canonical part.
SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000007');
UPDATE public.default_tenant_identities SET practice_membership_id = NULL WHERE user_id = '01100000-0000-0000-0000-000000000007';
SELECT public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000007');
SELECT pg_temp.assert_true((SELECT practice_membership_id IS NOT NULL FROM public.default_tenant_identities WHERE user_id = '01100000-0000-0000-0000-000000000007'), 'missing membership repaired');

SELECT public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000008');
UPDATE public.default_tenant_identities SET client_entity_id = NULL, internal_ledger_book_id = NULL WHERE user_id = '01100000-0000-0000-0000-000000000008';
SELECT public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000008');
SELECT pg_temp.assert_true((SELECT client_entity_id IS NOT NULL AND internal_ledger_book_id IS NOT NULL FROM public.default_tenant_identities WHERE user_id = '01100000-0000-0000-0000-000000000008'), 'missing client repaired with ledger');

SELECT public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000009');
UPDATE public.default_tenant_identities SET internal_ledger_book_id = NULL WHERE user_id = '01100000-0000-0000-0000-000000000009';
SELECT public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000009');
SELECT pg_temp.assert_true((SELECT internal_ledger_book_id IS NOT NULL FROM public.default_tenant_identities WHERE user_id = '01100000-0000-0000-0000-000000000009'), 'missing ledger repaired');

-- 13 and 20: a foreign practice cannot be reused, and its failure rolls back.
INSERT INTO public.practices (id, name, created_by_user_id)
VALUES ('01110000-0000-0000-0000-000000000003', 'Collision practice', '01100000-0000-0000-0000-000000000001');
SELECT public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000010');
UPDATE public.default_tenant_identities SET practice_id = '01110000-0000-0000-0000-000000000003' WHERE user_id = '01100000-0000-0000-0000-000000000010';
DO $$
BEGIN
  BEGIN
    PERFORM public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000010');
    RAISE EXCEPTION 'wrong-owner reuse unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.client_entities WHERE practice_id = '01110000-0000-0000-0000-000000000003'), 'collision did not create a client in the foreign practice');
UPDATE public.default_tenant_identities d
SET practice_id = m.practice_id
FROM public.practice_memberships m
WHERE d.user_id = '01100000-0000-0000-0000-000000000010'
  AND m.id = d.practice_membership_id;

-- 14, 15, 16, 18: ACL boundary checks use the real database roles.
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM public.ensure_default_tenant_for_self_v1(); RAISE EXCEPTION 'anon self RPC unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'anon backfill RPC unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '01100000-0000-0000-0000-000000000001', true);
DO $$ BEGIN
  BEGIN PERFORM public.ensure_default_tenant_for_user_v1('01100000-0000-0000-0000-000000000002'); RAISE EXCEPTION 'authenticated cross-user RPC unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$ BEGIN
  BEGIN INSERT INTO public.practices (name, created_by_user_id) VALUES ('forbidden service write', '01100000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'service direct DML unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

-- 19: each successful invocation has one operation with four sequential rows.
SELECT pg_temp.assert_true((SELECT count(*) = 4 FROM public.canonical_audit_ledger a WHERE a.operation_id = (SELECT operation_id FROM public.canonical_audit_ledger WHERE entity_id = (SELECT practice_id FROM public.default_tenant_identities WHERE user_id = '01100000-0000-0000-0000-000000000006') AND metadata_redacted->>'bootstrap_version' = '011' ORDER BY occurred_at DESC LIMIT 1) AND a.metadata_redacted->>'bootstrap_version' = '011'), 'four sequential bootstrap audit rows are present');
SELECT pg_temp.assert_true((SELECT count(DISTINCT operation_sequence) = 4 FROM public.canonical_audit_ledger WHERE metadata_redacted->>'bootstrap_target_user_id' = '01100000-0000-0000-0000-000000000006'), 'audit sequences are unique');

-- 21 and 22: the migration's confirmed-user selection can run repeatedly and
-- excludes an unconfirmed account.
DO $$
DECLARE v_user_id uuid;
BEGIN
  FOR v_user_id IN SELECT id FROM auth.users WHERE id::text LIKE '01100000-%' AND confirmed_at IS NOT NULL AND deleted_at IS NULL AND COALESCE(is_anonymous, false) = false LOOP
    PERFORM public.ensure_default_tenant_for_user_v1(v_user_id);
  END LOOP;
  FOR v_user_id IN SELECT id FROM auth.users WHERE id::text LIKE '01100000-%' AND confirmed_at IS NOT NULL AND deleted_at IS NULL AND COALESCE(is_anonymous, false) = false LOOP
    PERFORM public.ensure_default_tenant_for_user_v1(v_user_id);
  END LOOP;
END;
$$;
SELECT pg_temp.assert_true((SELECT NOT EXISTS (SELECT 1 FROM public.default_tenant_identities WHERE user_id = '01100000-0000-0000-0000-000000000012')), 'unconfirmed user excluded from migration backfill');

-- 25: RLS exposes owner A's client, never owner B's.
SELECT client_entity_id AS owner_a_client_id
FROM public.default_tenant_identities
WHERE user_id = '01100000-0000-0000-0000-000000000001' \gset
SELECT client_entity_id AS owner_b_client_id
FROM public.default_tenant_identities
WHERE user_id = '01100000-0000-0000-0000-000000000002' \gset
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '01100000-0000-0000-0000-000000000001', true);
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.client_entities WHERE id = :'owner_a_client_id'::uuid), 'owner reads own client through RLS');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.client_entities WHERE id = :'owner_b_client_id'::uuid), 'owner cannot read another tenant through RLS');
RESET ROLE;

ROLLBACK;
\echo 011_DEFAULT_TENANT_CONTRACT_OK
