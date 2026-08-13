-- Zaki Ledger - deterministic default canonical tenancy bootstrap
--
-- This migration is deliberately additive.  The registry below is the business
-- identity of a user's default tenant; canonical primary keys remain random.
-- It is also the only source from which an existing bootstrap entity is reused.

BEGIN;

CREATE TABLE IF NOT EXISTS public.default_tenant_identities (
  user_id                         uuid PRIMARY KEY
                                  REFERENCES auth.users(id) ON DELETE RESTRICT,
  practice_id                     uuid REFERENCES public.practices(id) ON DELETE RESTRICT,
  practice_membership_id          uuid REFERENCES public.practice_memberships(id) ON DELETE RESTRICT,
  client_entity_id                uuid REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  internal_ledger_book_id         uuid REFERENCES public.ledger_books(id) ON DELETE RESTRICT,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id),
  UNIQUE (practice_membership_id),
  UNIQUE (client_entity_id),
  UNIQUE (internal_ledger_book_id)
);

-- Migration 010's audit ledger intentionally accepts a small, reviewed
-- metadata vocabulary.  Bootstrap evidence needs the target and version in
-- addition to the actor/entity facts recorded by its four sequential rows.
CREATE OR REPLACE FUNCTION public.canonical_audit_metadata_allowed_v1(p_metadata jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) = 'object'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_object_keys(COALESCE(p_metadata, '{}'::jsonb)) AS key_name
       WHERE key_name NOT IN
         ('request_source', 'reason_code', 'parser_version', 'relationship_type',
          'claim_kind', 'outcome', 'detail_code',
          'bootstrap_version', 'bootstrap_target_user_id')
     );
$$;

CREATE OR REPLACE FUNCTION public.ensure_default_tenant_impl_v1(
  p_user_id uuid,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_identity public.default_tenant_identities%ROWTYPE;
  v_practice_id uuid;
  v_membership_id uuid;
  v_client_entity_id uuid;
  v_ledger_book_id uuid;
  v_operation_id uuid := gen_random_uuid();
  v_practice_created boolean := false;
  v_membership_created boolean := false;
  v_client_created boolean := false;
  v_ledger_created boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'default tenant target user is required' USING ERRCODE = '22023';
  END IF;
  IF NOT (
    (p_actor_kind = 'user' AND p_actor_user_id = p_user_id AND p_actor_service IS NULL)
    OR
    (p_actor_kind = 'migration' AND p_actor_user_id IS NULL
      AND p_actor_service = 'canonical-backfill')
  ) THEN
    RAISE EXCEPTION 'invalid default tenant bootstrap actor' USING ERRCODE = '42501';
  END IF;

  -- A per-user transaction lock serializes every repair/create decision for
  -- this tenant without serializing independent users.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 11));

  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default tenant target user does not exist' USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.default_tenant_identities (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_identity
  FROM public.default_tenant_identities
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_identity.practice_id IS NULL THEN
    v_practice_id := gen_random_uuid();
    INSERT INTO public.practices (id, name, created_by_user_id)
    VALUES (v_practice_id, 'Default practice', p_user_id);
    UPDATE public.default_tenant_identities
    SET practice_id = v_practice_id, updated_at = now()
    WHERE user_id = p_user_id;
    v_practice_created := true;
  ELSE
    v_practice_id := v_identity.practice_id;
    PERFORM 1
    FROM public.practices
    WHERE id = v_practice_id
      AND created_by_user_id = p_user_id
      AND status = 'active'
      AND archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'default practice identity ownership mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_identity.practice_membership_id IS NULL THEN
    SELECT id INTO v_membership_id
    FROM public.practice_memberships
    WHERE practice_id = v_practice_id
      AND user_id = p_user_id
      AND role = 'owner'
      AND status = 'active'
      AND valid_to IS NULL;

    IF v_membership_id IS NULL THEN
      v_membership_id := gen_random_uuid();
      INSERT INTO public.practice_memberships (id, practice_id, user_id, role)
      VALUES (v_membership_id, v_practice_id, p_user_id, 'owner');
      v_membership_created := true;
    END IF;

    UPDATE public.default_tenant_identities
    SET practice_membership_id = v_membership_id, updated_at = now()
    WHERE user_id = p_user_id;
  ELSE
    v_membership_id := v_identity.practice_membership_id;
    PERFORM 1
    FROM public.practice_memberships
    WHERE id = v_membership_id
      AND practice_id = v_practice_id
      AND user_id = p_user_id
      AND role = 'owner'
      AND status = 'active'
      AND valid_to IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'default practice membership identity ownership mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_identity.client_entity_id IS NULL THEN
    v_client_entity_id := gen_random_uuid();
    INSERT INTO public.client_entities (id, practice_id, legal_name, display_name)
    VALUES (v_client_entity_id, v_practice_id, 'Default client entity', 'Default client entity');
    UPDATE public.default_tenant_identities
    SET client_entity_id = v_client_entity_id, updated_at = now()
    WHERE user_id = p_user_id;
    v_client_created := true;
  ELSE
    v_client_entity_id := v_identity.client_entity_id;
    PERFORM 1
    FROM public.client_entities
    WHERE id = v_client_entity_id
      AND practice_id = v_practice_id
      AND status = 'active'
      AND archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'default client entity identity ownership mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_identity.internal_ledger_book_id IS NULL THEN
    v_ledger_book_id := gen_random_uuid();
    INSERT INTO public.ledger_books (id, client_entity_id, book_kind, display_name)
    VALUES (v_ledger_book_id, v_client_entity_id, 'internal', 'Internal ledger');
    UPDATE public.default_tenant_identities
    SET internal_ledger_book_id = v_ledger_book_id, updated_at = now()
    WHERE user_id = p_user_id;
    v_ledger_created := true;
  ELSE
    v_ledger_book_id := v_identity.internal_ledger_book_id;
    PERFORM 1
    FROM public.ledger_books
    WHERE id = v_ledger_book_id
      AND client_entity_id = v_client_entity_id
      AND book_kind = 'internal'
      AND status = 'active'
      AND archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'default internal ledger identity ownership mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Audit only after the entire graph exists.  A failure writing any record
  -- rolls back the graph and every earlier audit row with this transaction.
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, NULL, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, NULL,
    CASE WHEN v_practice_created THEN 'bootstrap_create' ELSE 'bootstrap_reuse' END,
    'practice', v_practice_id, NULL,
    jsonb_build_object('id', v_practice_id, 'target_user_id', p_user_id),
    jsonb_build_object('bootstrap_version', '011',
                       'bootstrap_target_user_id', p_user_id::text,
                       'outcome', CASE WHEN v_practice_created THEN 'created' ELSE 'reused' END)
  );
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, NULL, v_operation_id, 2,
    p_actor_kind, p_actor_user_id, p_actor_service, NULL,
    CASE WHEN v_membership_created THEN 'bootstrap_create' ELSE 'bootstrap_reuse' END,
    'practice_membership', v_membership_id, NULL,
    jsonb_build_object('id', v_membership_id, 'practice_id', v_practice_id, 'target_user_id', p_user_id),
    jsonb_build_object('bootstrap_version', '011',
                       'bootstrap_target_user_id', p_user_id::text,
                       'outcome', CASE WHEN v_membership_created THEN 'created' ELSE 'reused' END)
  );
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, v_client_entity_id, v_operation_id, 3,
    p_actor_kind, p_actor_user_id, p_actor_service, NULL,
    CASE WHEN v_client_created THEN 'bootstrap_create' ELSE 'bootstrap_reuse' END,
    'client_entity', v_client_entity_id, NULL,
    jsonb_build_object('id', v_client_entity_id, 'practice_id', v_practice_id),
    jsonb_build_object('bootstrap_version', '011',
                       'bootstrap_target_user_id', p_user_id::text,
                       'outcome', CASE WHEN v_client_created THEN 'created' ELSE 'reused' END)
  );
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, v_client_entity_id, v_operation_id, 4,
    p_actor_kind, p_actor_user_id, p_actor_service, NULL,
    CASE WHEN v_ledger_created THEN 'bootstrap_create' ELSE 'bootstrap_reuse' END,
    'ledger_book', v_ledger_book_id, NULL,
    jsonb_build_object('id', v_ledger_book_id, 'client_entity_id', v_client_entity_id),
    jsonb_build_object('bootstrap_version', '011',
                       'bootstrap_target_user_id', p_user_id::text,
                       'outcome', CASE WHEN v_ledger_created THEN 'created' ELSE 'reused' END)
  );

  RETURN jsonb_build_object(
    'bootstrap_version', '011',
    'operation_id', v_operation_id,
    'practice_id', v_practice_id,
    'practice_membership_id', v_membership_id,
    'client_entity_id', v_client_entity_id,
    'internal_ledger_book_id', v_ledger_book_id,
    'practice_created', v_practice_created,
    'membership_created', v_membership_created,
    'client_created', v_client_created,
    'ledger_created', v_ledger_created
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_default_tenant_for_self_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_request_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    session_user
  );
BEGIN
  IF v_request_role <> 'authenticated' OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'authenticated self bootstrap requires an authenticated JWT' USING ERRCODE = '42501';
  END IF;
  RETURN public.ensure_default_tenant_impl_v1(v_user_id, 'user', v_user_id, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_default_tenant_for_user_v1(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_request_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    session_user
  );
BEGIN
  IF v_request_role NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'default tenant backfill requires service_role or postgres' USING ERRCODE = '42501';
  END IF;
  RETURN public.ensure_default_tenant_impl_v1(p_user_id, 'migration', NULL, 'canonical-backfill');
END;
$$;

-- Backfill confirmed, usable accounts only.  This is safe on a rerun because
-- the registry and each repair path are idempotent; no unconfirmed account is
-- considered just because it exists in auth.users.
DO $backfill$
DECLARE
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT id
    FROM auth.users
    WHERE confirmed_at IS NOT NULL
      AND deleted_at IS NULL
      AND COALESCE(is_anonymous, false) = false
  LOOP
    PERFORM public.ensure_default_tenant_for_user_v1(v_user_id);
  END LOOP;
END;
$backfill$;

ALTER TABLE public.default_tenant_identities ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.default_tenant_identities
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.ensure_default_tenant_impl_v1(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ensure_default_tenant_for_self_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ensure_default_tenant_for_user_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.ensure_default_tenant_for_self_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_default_tenant_for_user_v1(uuid) TO service_role, postgres;

COMMIT;
