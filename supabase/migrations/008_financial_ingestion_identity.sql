-- Zaki Ledger - migration 007: transitional financial ingestion identity
--
-- REVIEW BEFORE RUNNING. This migration is additive. It does not delete,
-- merge, rename, or infer identity for any historical financial row.

BEGIN;

ALTER TABLE public.bank_statements
  ADD COLUMN IF NOT EXISTS source_provider text,
  ADD COLUMN IF NOT EXISTS source_organisation_id text,
  ADD COLUMN IF NOT EXISTS source_account_id text,
  ADD COLUMN IF NOT EXISTS source_account_metadata jsonb,
  ADD COLUMN IF NOT EXISTS source_artifact_hash text;

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS external_transaction_id text,
  ADD COLUMN IF NOT EXISTS source_provider text,
  ADD COLUMN IF NOT EXISTS source_organisation_id text,
  ADD COLUMN IF NOT EXISTS source_account_id text,
  ADD COLUMN IF NOT EXISTS identity_fingerprint text,
  ADD COLUMN IF NOT EXISTS identity_fingerprint_version integer;

ALTER TABLE public.qb_transactions
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS organisation_id text,
  ADD COLUMN IF NOT EXISTS external_object_type text,
  ADD COLUMN IF NOT EXISTS identity_fingerprint text,
  ADD COLUMN IF NOT EXISTS identity_fingerprint_version integer,
  ADD COLUMN IF NOT EXISTS source_artifact_hash text,
  ADD COLUMN IF NOT EXISTS source_row_number integer;

-- Compatibility policy:
-- * bank_transactions.transaction_id remains the legacy/provider-ID alias.
--   New ingestion writes it together with external_transaction_id.
-- * qb_transactions.qb_transaction_id remains the accounting external ID.
-- * qb_transactions.qb_account_id remains the provider account ID.

CREATE UNIQUE INDEX IF NOT EXISTS bank_statements_id_user_key
  ON public.bank_statements (id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_id_user_key
  ON public.bank_transactions (id, user_id);

CREATE TABLE IF NOT EXISTS public.bank_statement_transaction_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  statement_id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  source_row_number integer,
  source_reference_hash text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_statement_observations_statement_user_fkey
    FOREIGN KEY (statement_id, user_id)
    REFERENCES public.bank_statements(id, user_id) ON DELETE CASCADE,
  CONSTRAINT bank_statement_observations_transaction_user_fkey
    FOREIGN KEY (bank_transaction_id, user_id)
    REFERENCES public.bank_transactions(id, user_id) ON DELETE CASCADE,
  CONSTRAINT bank_statement_observations_statement_transaction_key
    UNIQUE (statement_id, bank_transaction_id),
  CONSTRAINT bank_statement_observations_statement_row_key
    UNIQUE (statement_id, source_row_number)
);

CREATE INDEX IF NOT EXISTS bank_statement_observations_transaction_idx
  ON public.bank_statement_transaction_observations (bank_transaction_id);
CREATE INDEX IF NOT EXISTS bank_statement_observations_user_statement_idx
  ON public.bank_statement_transaction_observations (user_id, statement_id);

ALTER TABLE public.bank_statement_transaction_observations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'bank_statement_transaction_observations'
      AND policyname = 'Users can only access their own bank statement observations'
  ) THEN
    CREATE POLICY "Users can only access their own bank statement observations"
      ON public.bank_statement_transaction_observations
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;

-- Backfill only the relationship already proven by the existing foreign key.
-- This creates no transaction identity and changes no historical row.
INSERT INTO public.bank_statement_transaction_observations (
  user_id, statement_id, bank_transaction_id, observed_at, created_at
)
SELECT bt.user_id, bt.statement_id, bt.id, now(), now()
FROM public.bank_transactions AS bt
ON CONFLICT (statement_id, bank_transaction_id) DO NOTHING;

-- Exact source artifacts are idempotent inside their explicit source/account
-- namespace. COALESCE intentionally makes a missing organisation/account one
-- namespace; it never causes cross-account merging when an account is known.
CREATE UNIQUE INDEX IF NOT EXISTS bank_statements_source_artifact_key
  ON public.bank_statements (
    user_id,
    source_provider,
    COALESCE(source_organisation_id, ''),
    COALESCE(source_account_id, ''),
    source_artifact_hash
  )
  WHERE source_provider IS NOT NULL AND source_artifact_hash IS NOT NULL;

-- A bank provider ID is strong only with a provider and source account.
-- Organisation is included when known and occupies an explicit empty
-- namespace when unavailable (normal for OFX). Historical rows are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_provider_identity_key
  ON public.bank_transactions (
    user_id,
    source_provider,
    COALESCE(source_organisation_id, ''),
    source_account_id,
    external_transaction_id
  )
  WHERE source_provider IS NOT NULL
    AND source_account_id IS NOT NULL
    AND external_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bank_transactions_fingerprint_candidate_idx
  ON public.bank_transactions (
    user_id, source_provider, source_account_id,
    identity_fingerprint_version, identity_fingerprint
  )
  WHERE identity_fingerprint IS NOT NULL;

-- Accounting IDs are unique only in a complete provider/org/object namespace.
CREATE UNIQUE INDEX IF NOT EXISTS qb_transactions_provider_identity_key
  ON public.qb_transactions (
    user_id, provider, organisation_id, external_object_type, qb_transaction_id
  )
  WHERE provider IS NOT NULL
    AND organisation_id IS NOT NULL
    AND external_object_type IS NOT NULL
    AND qb_transaction_id IS NOT NULL;

-- Exact CSV retries are safe by artifact and row. This does not merge rows
-- across different artifacts and therefore preserves legitimate repeats.
CREATE UNIQUE INDEX IF NOT EXISTS qb_transactions_source_artifact_row_key
  ON public.qb_transactions (
    user_id, provider, COALESCE(organisation_id, ''),
    source_artifact_hash, source_row_number
  )
  WHERE provider IS NOT NULL
    AND source_artifact_hash IS NOT NULL
    AND source_row_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS qb_transactions_fingerprint_candidate_idx
  ON public.qb_transactions (
    user_id, provider, organisation_id, qb_account_id,
    identity_fingerprint_version, identity_fingerprint
  )
  WHERE identity_fingerprint IS NOT NULL;

-- One function call is one PostgreSQL transaction. Any exception rolls back
-- statement metadata, canonical rows, and observations together.
CREATE OR REPLACE FUNCTION public.ingest_bank_statement_v1(
  p_user_id uuid,
  p_statement jsonb,
  p_transactions jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_statement_id uuid := COALESCE(NULLIF(p_statement->>'id', '')::uuid, gen_random_uuid());
  v_inserted_statement_id uuid;
  v_transaction_id uuid;
  v_item jsonb;
  v_provider text := NULLIF(btrim(p_statement->>'source_provider'), '');
  v_organisation_id text := NULLIF(btrim(p_statement->>'source_organisation_id'), '');
  v_account_id text := NULLIF(btrim(p_statement->>'source_account_id'), '');
  v_artifact_hash text := NULLIF(btrim(p_statement->>'source_artifact_hash'), '');
  v_external_id text;
  v_inserted_count integer := 0;
  v_reused_count integer := 0;
BEGIN
  -- Supabase/PostgREST executes a service-key request as the service_role
  -- PostgreSQL role. Session-backed callers have auth.uid() populated and
  -- may only act for that same user. No other role may use a null auth.uid()
  -- to supply an arbitrary user id.
  IF auth.uid() IS NOT NULL THEN
    IF auth.uid() IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'RPC user does not match authenticated user'
        USING ERRCODE = '42501';
    END IF;
  ELSIF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires an authenticated user or service_role'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_transactions) <> 'array' THEN
    RAISE EXCEPTION 'p_transactions must be a JSON array';
  END IF;

  INSERT INTO public.bank_statements (
    id, user_id, file_name, file_format,
    statement_period_start, statement_period_end, currency,
    opening_balance, closing_balance, transaction_count,
    source_provider, source_organisation_id, source_account_id,
    source_account_metadata, source_artifact_hash
  ) VALUES (
    v_statement_id, p_user_id, p_statement->>'file_name', p_statement->>'file_format',
    NULLIF(p_statement->>'statement_period_start', '')::date,
    NULLIF(p_statement->>'statement_period_end', '')::date,
    NULLIF(p_statement->>'currency', ''),
    NULLIF(p_statement->>'opening_balance', '')::numeric,
    NULLIF(p_statement->>'closing_balance', '')::numeric,
    COALESCE(NULLIF(p_statement->>'transaction_count', '')::integer, jsonb_array_length(p_transactions)),
    v_provider, v_organisation_id, v_account_id,
    p_statement->'source_account_metadata', v_artifact_hash
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inserted_statement_id;

  IF v_inserted_statement_id IS NULL THEN
    IF v_artifact_hash IS NULL OR v_provider IS NULL THEN
      RAISE EXCEPTION 'Statement insert conflicted without a reusable artifact identity';
    END IF;
    SELECT bs.id INTO v_statement_id
    FROM public.bank_statements AS bs
    WHERE bs.user_id = p_user_id
      AND bs.source_provider = v_provider
      AND bs.source_organisation_id IS NOT DISTINCT FROM v_organisation_id
      AND bs.source_account_id IS NOT DISTINCT FROM v_account_id
      AND bs.source_artifact_hash = v_artifact_hash;
    IF v_statement_id IS NULL THEN
      RAISE EXCEPTION 'Statement artifact conflict could not be resolved';
    END IF;
    RETURN jsonb_build_object(
      'statement_id', v_statement_id,
      'inserted_count', 0,
      'reused_count', jsonb_array_length(p_transactions),
      'reused_artifact', true
    );
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_transactions)
  LOOP
    v_transaction_id := NULL;
    v_external_id := NULLIF(btrim(v_item->>'external_transaction_id'), '');

    IF v_provider IS NOT NULL AND v_account_id IS NOT NULL AND v_external_id IS NOT NULL THEN
      INSERT INTO public.bank_transactions (
        id, statement_id, user_id, transaction_date, posted_date,
        merchant, description, amount, currency, transaction_id, memo,
        external_transaction_id, source_provider, source_organisation_id,
        source_account_id, identity_fingerprint, identity_fingerprint_version
      ) VALUES (
        gen_random_uuid(), v_statement_id, p_user_id,
        (v_item->>'transaction_date')::date,
        NULLIF(v_item->>'posted_date', '')::date,
        v_item->>'merchant', v_item->>'description', (v_item->>'amount')::numeric,
        NULLIF(v_item->>'currency', ''),
        COALESCE(NULLIF(v_item->>'transaction_id', ''), v_external_id),
        v_item->>'memo', v_external_id, v_provider, v_organisation_id,
        v_account_id, NULLIF(v_item->>'identity_fingerprint', ''),
        NULLIF(v_item->>'identity_fingerprint_version', '')::integer
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_transaction_id;

      IF v_transaction_id IS NULL THEN
        SELECT bt.id INTO v_transaction_id
        FROM public.bank_transactions AS bt
        WHERE bt.user_id = p_user_id
          AND bt.source_provider = v_provider
          AND bt.source_organisation_id IS NOT DISTINCT FROM v_organisation_id
          AND bt.source_account_id = v_account_id
          AND bt.external_transaction_id = v_external_id;
        v_reused_count := v_reused_count + 1;
      ELSE
        v_inserted_count := v_inserted_count + 1;
      END IF;
    ELSE
      -- A fallback fingerprint is deliberately not a conflict target. Without
      -- trustworthy account/provider identity, similar rows remain separate.
      INSERT INTO public.bank_transactions (
        id, statement_id, user_id, transaction_date, posted_date,
        merchant, description, amount, currency, transaction_id, memo,
        external_transaction_id, source_provider, source_organisation_id,
        source_account_id, identity_fingerprint, identity_fingerprint_version
      ) VALUES (
        gen_random_uuid(), v_statement_id, p_user_id,
        (v_item->>'transaction_date')::date,
        NULLIF(v_item->>'posted_date', '')::date,
        v_item->>'merchant', v_item->>'description', (v_item->>'amount')::numeric,
        NULLIF(v_item->>'currency', ''), NULLIF(v_item->>'transaction_id', ''),
        v_item->>'memo', v_external_id, v_provider, v_organisation_id,
        v_account_id, NULLIF(v_item->>'identity_fingerprint', ''),
        NULLIF(v_item->>'identity_fingerprint_version', '')::integer
      ) RETURNING id INTO v_transaction_id;
      v_inserted_count := v_inserted_count + 1;
    END IF;

    IF v_transaction_id IS NULL THEN
      RAISE EXCEPTION 'Canonical bank transaction identity could not be resolved';
    END IF;

    INSERT INTO public.bank_statement_transaction_observations (
      user_id, statement_id, bank_transaction_id, source_row_number,
      source_reference_hash, observed_at, created_at
    ) VALUES (
      p_user_id, v_statement_id, v_transaction_id,
      NULLIF(v_item->>'source_row_number', '')::integer,
      NULLIF(v_item->>'source_reference_hash', ''), now(), now()
    )
    -- Only replaying the same canonical transaction observation is benign.
    -- A duplicate source row pointing at a different transaction is an
    -- integrity error and must abort the entire ingestion transaction.
    ON CONFLICT (statement_id, bank_transaction_id) DO NOTHING;
  END LOOP;

  RETURN jsonb_build_object(
    'statement_id', v_statement_id,
    'inserted_count', v_inserted_count,
    'reused_count', v_reused_count,
    'reused_artifact', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ingest_accounting_transactions_v1(
  p_user_id uuid,
  p_transactions jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item jsonb;
  v_transaction_id uuid;
  v_provider text;
  v_organisation_id text;
  v_object_type text;
  v_external_id text;
  v_artifact_hash text;
  v_source_row_number integer;
  v_provider_identity_id uuid;
  v_artifact_identity_id uuid;
  v_inserted_count integer := 0;
  v_reused_count integer := 0;
BEGIN
  -- See ingest_bank_statement_v1 for the ownership contract. current_user is
  -- the active PostgreSQL role selected by PostgREST from the signed JWT; it
  -- does not trust a caller-supplied JSON claim.
  IF auth.uid() IS NOT NULL THEN
    IF auth.uid() IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'RPC user does not match authenticated user'
        USING ERRCODE = '42501';
    END IF;
  ELSIF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires an authenticated user or service_role'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_transactions) <> 'array' THEN
    RAISE EXCEPTION 'p_transactions must be a JSON array';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_transactions)
  LOOP
    v_transaction_id := NULL;
    v_provider_identity_id := NULL;
    v_artifact_identity_id := NULL;
    v_provider := NULLIF(btrim(v_item->>'provider'), '');
    v_organisation_id := NULLIF(btrim(v_item->>'organisation_id'), '');
    v_object_type := NULLIF(btrim(v_item->>'external_object_type'), '');
    v_external_id := NULLIF(btrim(v_item->>'qb_transaction_id'), '');
    v_artifact_hash := NULLIF(btrim(v_item->>'source_artifact_hash'), '');
    v_source_row_number := NULLIF(v_item->>'source_row_number', '')::integer;

    INSERT INTO public.qb_transactions (
      id, user_id, qb_transaction_id, qb_account_id, posted_date, amount,
      description, account_name, account_type, currency, synced_from_qb_at,
      provider, organisation_id, external_object_type,
      identity_fingerprint, identity_fingerprint_version,
      source_artifact_hash, source_row_number
    ) VALUES (
      COALESCE(NULLIF(v_item->>'id', '')::uuid, gen_random_uuid()),
      p_user_id, v_external_id, NULLIF(v_item->>'qb_account_id', ''),
      (v_item->>'posted_date')::date, (v_item->>'amount')::numeric,
      v_item->>'description', v_item->>'account_name', v_item->>'account_type',
      NULLIF(v_item->>'currency', ''), now(), v_provider, v_organisation_id,
      v_object_type, NULLIF(v_item->>'identity_fingerprint', ''),
      NULLIF(v_item->>'identity_fingerprint_version', '')::integer,
      v_artifact_hash, v_source_row_number
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_transaction_id;

    IF v_transaction_id IS NULL THEN
      IF v_provider IS NOT NULL AND v_organisation_id IS NOT NULL
         AND v_object_type IS NOT NULL AND v_external_id IS NOT NULL THEN
        SELECT qt.id INTO v_provider_identity_id
        FROM public.qb_transactions AS qt
        WHERE qt.user_id = p_user_id
          AND qt.provider = v_provider
          AND qt.organisation_id = v_organisation_id
          AND qt.external_object_type = v_object_type
          AND qt.qb_transaction_id = v_external_id;
      END IF;

      IF v_provider IS NOT NULL AND v_artifact_hash IS NOT NULL
         AND v_source_row_number IS NOT NULL THEN
        SELECT qt.id INTO v_artifact_identity_id
        FROM public.qb_transactions AS qt
        WHERE qt.user_id = p_user_id
          AND qt.provider = v_provider
          AND qt.organisation_id IS NOT DISTINCT FROM v_organisation_id
          AND qt.source_artifact_hash = v_artifact_hash
          AND qt.source_row_number = v_source_row_number;
      END IF;

      -- Provider identity and exact-artifact identity are independent valid
      -- retry keys. If they resolve to different canonical rows, choosing
      -- either would silently join two financial identities, so fail and let
      -- the surrounding function transaction roll back the complete batch.
      IF v_provider_identity_id IS NOT NULL
         AND v_artifact_identity_id IS NOT NULL
         AND v_provider_identity_id IS DISTINCT FROM v_artifact_identity_id THEN
        RAISE EXCEPTION 'Provider identity conflicts with artifact identity'
          USING ERRCODE = '23505';
      END IF;

      v_transaction_id := COALESCE(v_provider_identity_id, v_artifact_identity_id);
      IF v_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Accounting transaction conflict could not be resolved';
      END IF;
      v_reused_count := v_reused_count + 1;
    ELSE
      v_inserted_count := v_inserted_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted_count', v_inserted_count,
    'reused_count', v_reused_count
  );
END;
$$;

-- Observation-aware statement read with a direct statement_id fallback for
-- historical/partially deployed data. The compatibility statement_id remains.
CREATE OR REPLACE FUNCTION public.list_statement_bank_transactions_v1(
  p_user_id uuid,
  p_statement_id uuid
) RETURNS SETOF public.bank_transactions
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF auth.uid() IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'RPC user does not match authenticated user'
        USING ERRCODE = '42501';
    END IF;
  ELSIF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires an authenticated user or service_role'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT bt.*
  FROM public.bank_transactions AS bt
  WHERE bt.user_id = p_user_id
    AND (
      EXISTS (
        SELECT 1
        FROM public.bank_statement_transaction_observations AS observation
        WHERE observation.user_id = p_user_id
          AND observation.statement_id = p_statement_id
          AND observation.bank_transaction_id = bt.id
      )
      OR (
        bt.statement_id = p_statement_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.bank_statement_transaction_observations AS any_observation
          WHERE any_observation.bank_transaction_id = bt.id
        )
      )
    )
  ORDER BY bt.transaction_date, bt.id;
END;
$$;

-- The application performs data access through lib/supabase.ts, whose
-- server-only client uses service_role after requireUser() establishes the
-- request user. Session clients are currently auth-only, so authenticated
-- does not need direct RPC execution. Revoke named roles explicitly rather
-- than relying on Supabase's default function privileges.
REVOKE EXECUTE ON FUNCTION public.ingest_bank_statement_v1(uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ingest_bank_statement_v1(uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.ingest_bank_statement_v1(uuid, jsonb, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.ingest_accounting_transactions_v1(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ingest_accounting_transactions_v1(uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.ingest_accounting_transactions_v1(uuid, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.list_statement_bank_transactions_v1(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_statement_bank_transactions_v1(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.list_statement_bank_transactions_v1(uuid, uuid) FROM authenticated;

-- These functions run with caller privileges, so the only role allowed to execute
-- them also needs the least table privileges required by their SQL bodies and
-- by the existing server-side statement/accounting reads.
GRANT SELECT, INSERT ON TABLE public.bank_statements TO service_role;
GRANT SELECT, INSERT ON TABLE public.bank_transactions TO service_role;
GRANT SELECT, INSERT ON TABLE public.qb_transactions TO service_role;
GRANT SELECT, INSERT ON TABLE public.bank_statement_transaction_observations TO service_role;

GRANT EXECUTE ON FUNCTION public.ingest_bank_statement_v1(uuid, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_accounting_transactions_v1(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_statement_bank_transactions_v1(uuid, uuid) TO service_role;

COMMIT;
