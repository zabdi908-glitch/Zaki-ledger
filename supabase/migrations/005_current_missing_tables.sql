-- Zaki Ledger - migration 005: current-code tables missing from migrations
--
-- Live inspection confirmed both tables are absent. This migration creates only
-- current-code tables and does not recreate legacy or unused tables.

-- -------------------------------------------------------------------------
-- reconciliation_decisions: user-owned decision history
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reconciliation_decisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id),
  statement_id         uuid NOT NULL,
  match_id             uuid,
  bank_transaction_id  uuid NOT NULL,
  decision_type        text NOT NULL,
  merchant_name        text,
  suggested_category   text,
  user_choice_category text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF to_regclass('public.reconciliation_decisions') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'reconciliation_decisions'
         AND column_name = 'user_id' AND data_type = 'uuid'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'reconciliation_decisions'
         AND column_name = 'statement_id'
     ) THEN
    CREATE INDEX IF NOT EXISTS reconciliation_decisions_user_idx
      ON public.reconciliation_decisions (user_id, statement_id);

    ALTER TABLE public.reconciliation_decisions ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'reconciliation_decisions'
        AND policyname = 'Users can only access their own reconciliation_decisions'
    ) THEN
      CREATE POLICY "Users can only access their own reconciliation_decisions"
        ON public.reconciliation_decisions
        FOR ALL
        USING (auth.uid() = user_id)
        WITH CHECK (auth.uid() = user_id);
    END IF;
  END IF;
END
$$;

-- -------------------------------------------------------------------------
-- merchant_ai_categories: global shared AI cache
-- -------------------------------------------------------------------------
-- lib/merchant-ai-cache.ts uses getSupabase(), which is the server-side
-- service-role client. This table intentionally has no user_id and no
-- user-scoped policy; RLS is enabled to prevent direct client access.
CREATE TABLE IF NOT EXISTS public.merchant_ai_categories (
  merchant_name   text PRIMARY KEY,
  category        text NOT NULL,
  confidence_pct integer NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.merchant_ai_categories
  ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policy is added to the global cache. The service-role
-- server client bypasses RLS and remains able to read and write this table.

NOTIFY pgrst, 'reload schema';
