-- Zaki Ledger - migration 004: live-schema compatibility repair
--
-- Based on the confirmed zero-row live preflight. This migration repairs
-- existing tables without deleting tables or rows and does not modify 003.
-- Existing RLS policies and legacy foreign keys are preserved unless noted.

-- -------------------------------------------------------------------------
-- confirmations
-- -------------------------------------------------------------------------
-- The live table has zero rows and already contains confirmed_value,
-- confirmed_at, created_at, and confidence. The application reads/writes
-- value, so add only that missing compatibility column.
DO $$
BEGIN
  IF to_regclass('public.confirmations') IS NOT NULL THEN
    ALTER TABLE public.confirmations
      ADD COLUMN IF NOT EXISTS value text;
  END IF;
END
$$;

-- The live confidence column is numeric without a declared precision/scale.
-- The application treats it as a number and does not require numeric(4,3).
-- It is intentionally left unchanged; no type conversion is needed for code
-- correctness and no confidence values should be altered by this migration.

-- -------------------------------------------------------------------------
-- user_merchant_preferences
-- -------------------------------------------------------------------------
-- The live table is empty. Add the current-code columns while retaining the
-- legacy merchant_key, timing, amount, confidence, and timestamp columns.
DO $$
BEGIN
  IF to_regclass('public.user_merchant_preferences') IS NOT NULL THEN
    ALTER TABLE public.user_merchant_preferences
      ADD COLUMN IF NOT EXISTS merchant_name text;
    ALTER TABLE public.user_merchant_preferences
      ADD COLUMN IF NOT EXISTS last_approved timestamptz;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_merchant_preferences'
        AND column_name = 'merchant_name'
        AND data_type = 'text'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: user_merchant_preferences.merchant_name is not text';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_merchant_preferences'
        AND column_name = 'last_approved'
        AND data_type = 'timestamp with time zone'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: user_merchant_preferences.last_approved is not timestamptz';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_merchant_preferences'
        AND column_name = 'approval_count'
        AND data_type = 'integer'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: user_merchant_preferences.approval_count is not integer';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.user_merchant_preferences
      WHERE merchant_name IS NULL
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: user_merchant_preferences.merchant_name contains NULLs';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_merchant_preferences'
        AND column_name = 'merchant_name'
        AND is_nullable = 'YES'
    ) THEN
      ALTER TABLE public.user_merchant_preferences
        ALTER COLUMN merchant_name SET NOT NULL;
    END IF;

    ALTER TABLE public.user_merchant_preferences
      ALTER COLUMN approval_count SET DEFAULT 0;

    IF EXISTS (
      SELECT 1
      FROM public.user_merchant_preferences
      WHERE approval_count IS NULL
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: user_merchant_preferences.approval_count contains NULLs';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_merchant_preferences'
        AND column_name = 'approval_count'
        AND is_nullable = 'YES'
    ) THEN
      ALTER TABLE public.user_merchant_preferences
        ALTER COLUMN approval_count SET NOT NULL;
    END IF;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.user_merchant_preferences') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'user_merchant_preferences'
         AND column_name = 'user_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'user_merchant_preferences'
         AND column_name = 'merchant_name'
     ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_merchant_preferences
      GROUP BY user_id, merchant_name
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: duplicate (user_id, merchant_name) values exist';
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS user_merchant_preferences_user_merchant_name_key
      ON public.user_merchant_preferences (user_id, merchant_name);
  END IF;
END
$$;

-- Replace only the confirmed legacy user identity FK. The live preflight
-- confirmed that this table has zero rows and that the existing FK is named
-- user_merchant_preferences_user_id_fkey and targets public.profiles(id).
DO $$
DECLARE
  user_id_attnum smallint;
  fk_count integer;
  fk record;
  invalid_user_count bigint;
BEGIN
  IF to_regclass('public.user_merchant_preferences') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_merchant_preferences'
        AND column_name = 'user_id'
        AND data_type = 'uuid'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: user_merchant_preferences.user_id is missing or is not uuid';
    END IF;

    SELECT a.attnum
    INTO user_id_attnum
    FROM pg_attribute AS a
    WHERE a.attrelid = 'public.user_merchant_preferences'::regclass
      AND a.attname = 'user_id'
      AND a.attnum > 0
      AND NOT a.attisdropped;

    SELECT count(*)
    INTO fk_count
    FROM pg_constraint AS con
    WHERE con.conrelid = 'public.user_merchant_preferences'::regclass
      AND con.contype = 'f'
      AND con.conkey @> ARRAY[user_id_attnum]::smallint[];

    IF fk_count = 0 THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: no foreign key involving user_merchant_preferences.user_id was found';
    ELSIF fk_count > 1 THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: multiple foreign keys involve user_merchant_preferences.user_id';
    END IF;

    SELECT
      con.oid AS constraint_oid,
      con.conname AS constraint_name,
      ref_ns.nspname AS target_schema,
      ref_class.relname AS target_table,
      ref_att.attname AS target_column,
      array_length(con.conkey, 1) AS local_column_count,
      array_length(con.confkey, 1) AS target_column_count,
      con.confdeltype AS delete_action
    INTO fk
    FROM pg_constraint AS con
    JOIN pg_class AS ref_class
      ON ref_class.oid = con.confrelid
    JOIN pg_namespace AS ref_ns
      ON ref_ns.oid = ref_class.relnamespace
    JOIN pg_attribute AS ref_att
      ON ref_att.attrelid = con.confrelid
     AND ref_att.attnum = con.confkey[1]
    WHERE con.oid IN (
      SELECT candidate.oid
      FROM pg_constraint AS candidate
      WHERE candidate.conrelid = 'public.user_merchant_preferences'::regclass
        AND candidate.contype = 'f'
        AND candidate.conkey @> ARRAY[user_id_attnum]::smallint[]
    );

    IF fk.local_column_count <> 1 OR fk.target_column_count <> 1 THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: user_merchant_preferences.user_id is part of a composite foreign key';
    END IF;

    IF fk.target_schema = 'public'
       AND fk.target_table = 'profiles'
       AND fk.target_column = 'id' THEN
      IF fk.constraint_name <> 'user_merchant_preferences_user_id_fkey' THEN
        RAISE EXCEPTION
          'MANUAL REVIEW REQUIRED: expected legacy FK name user_merchant_preferences_user_id_fkey, found %',
          fk.constraint_name;
      END IF;

      IF to_regclass('auth.users') IS NULL THEN
        RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: auth.users does not exist';
      END IF;

      SELECT count(*)
      INTO invalid_user_count
      FROM public.user_merchant_preferences AS ump
      WHERE NOT EXISTS (
        SELECT 1
        FROM auth.users AS au
        WHERE au.id = ump.user_id
      );

      IF invalid_user_count > 0 THEN
        RAISE EXCEPTION
          'MANUAL REVIEW REQUIRED: % user_merchant_preferences.user_id values do not exist in auth.users',
          invalid_user_count;
      END IF;

      EXECUTE format(
        'ALTER TABLE public.user_merchant_preferences DROP CONSTRAINT %I',
        fk.constraint_name
      );

      ALTER TABLE public.user_merchant_preferences
        ADD CONSTRAINT user_merchant_preferences_user_id_fkey
        FOREIGN KEY (user_id)
        REFERENCES auth.users(id)
        ON DELETE CASCADE;
    ELSIF fk.target_schema = 'auth'
       AND fk.target_table = 'users'
       AND fk.target_column = 'id' THEN
      IF fk.delete_action <> 'c' THEN
        RAISE EXCEPTION
          'MANUAL REVIEW REQUIRED: user_merchant_preferences.user_id already references auth.users(id) without ON DELETE CASCADE';
      END IF;
      -- Already repaired with the required target and delete behavior.
    ELSE
      RAISE EXCEPTION
        'MANUAL REVIEW REQUIRED: unexpected user_merchant_preferences.user_id FK target %.%(%)',
        fk.target_schema,
        fk.target_table,
        fk.target_column;
    END IF;
  END IF;
END
$$;

-- -------------------------------------------------------------------------
-- invoice_matches
-- -------------------------------------------------------------------------
-- The live table is empty. Retain legacy columns and FKs, then add the
-- current-code columns and make the old source reference nullable.
DO $$
BEGIN
  IF to_regclass('public.invoice_matches') IS NOT NULL THEN
    ALTER TABLE public.invoice_matches
      ADD COLUMN IF NOT EXISTS invoice_id uuid;
    ALTER TABLE public.invoice_matches
      ADD COLUMN IF NOT EXISTS confidence_pct integer;
    ALTER TABLE public.invoice_matches
      ADD COLUMN IF NOT EXISTS matched_by text;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'invoice_matches'
        AND column_name = 'extracted_item_id'
        AND is_nullable = 'NO'
    ) THEN
      ALTER TABLE public.invoice_matches
        ALTER COLUMN extracted_item_id DROP NOT NULL;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'invoice_matches'
        AND column_name = 'invoice_id'
        AND data_type <> 'uuid'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.invoice_id is not uuid';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'invoice_matches'
        AND column_name = 'confidence_pct'
        AND data_type <> 'integer'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.confidence_pct is not integer';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'invoice_matches'
        AND column_name = 'matched_by'
        AND data_type <> 'text'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.matched_by is not text';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.invoice_matches WHERE invoice_id IS NULL
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.invoice_id contains NULLs';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.invoice_matches WHERE confidence_pct IS NULL
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.confidence_pct contains NULLs';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.invoice_matches WHERE matched_by IS NULL
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.matched_by contains NULLs';
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'invoice_matches'
        AND column_name = 'invoice_id' AND is_nullable = 'YES'
    ) THEN
      ALTER TABLE public.invoice_matches
        ALTER COLUMN invoice_id SET NOT NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'invoice_matches'
        AND column_name = 'confidence_pct' AND is_nullable = 'YES'
    ) THEN
      ALTER TABLE public.invoice_matches
        ALTER COLUMN confidence_pct SET NOT NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'invoice_matches'
        AND column_name = 'matched_by' AND is_nullable = 'YES'
    ) THEN
      ALTER TABLE public.invoice_matches
        ALTER COLUMN matched_by SET NOT NULL;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'invoice_matches'
        AND column_name = 'status' AND data_type <> 'text'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.status is not text';
    END IF;
    ALTER TABLE public.invoice_matches
      ALTER COLUMN status SET DEFAULT 'matched';
    IF EXISTS (
      SELECT 1 FROM public.invoice_matches WHERE status IS NULL
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.status contains NULLs';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'invoice_matches'
        AND column_name = 'status' AND is_nullable = 'YES'
    ) THEN
      ALTER TABLE public.invoice_matches
        ALTER COLUMN status SET NOT NULL;
    END IF;
  END IF;
END
$$;

-- Replace only a verified legacy status check. Any unexpected status check
-- stops the migration for manual review instead of being removed blindly.
DO $$
DECLARE
  constraint_row record;
  normalized_definition text;
  has_compatible_check boolean := false;
BEGIN
  IF to_regclass('public.invoice_matches') IS NOT NULL THEN
    FOR constraint_row IN
      SELECT con.conname,
             pg_get_constraintdef(con.oid, true) AS definition
      FROM pg_constraint AS con
      WHERE con.conrelid = 'public.invoice_matches'::regclass
        AND con.contype = 'c'
        AND lower(pg_get_constraintdef(con.oid, true)) LIKE '%status%'
    LOOP
      normalized_definition := regexp_replace(
        lower(constraint_row.definition), '\s+', '', 'g'
      );

      IF normalized_definition LIKE '%pending%'
         AND normalized_definition LIKE '%approved%'
         AND normalized_definition LIKE '%rejected%'
         AND normalized_definition LIKE '%matched%' THEN
        has_compatible_check := true;
      ELSIF normalized_definition LIKE '%pending%'
         AND normalized_definition LIKE '%approved%'
         AND normalized_definition LIKE '%rejected%'
         AND normalized_definition NOT LIKE '%matched%' THEN
        EXECUTE format(
          'ALTER TABLE public.invoice_matches DROP CONSTRAINT %I',
          constraint_row.conname
        );
      ELSE
        RAISE EXCEPTION
          'MANUAL REVIEW REQUIRED: unexpected invoice_matches status check %: %',
          constraint_row.conname, constraint_row.definition;
      END IF;
    END LOOP;

    IF NOT has_compatible_check THEN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint AS existing_constraint
        WHERE existing_constraint.conrelid = 'public.invoice_matches'::regclass
          AND existing_constraint.conname = 'invoice_matches_status_compat_check'
      ) THEN
        RAISE EXCEPTION
          'MANUAL REVIEW REQUIRED: invoice_matches_status_compat_check has an unexpected definition';
      ELSE
        ALTER TABLE public.invoice_matches
          ADD CONSTRAINT invoice_matches_status_compat_check
          CHECK (status IN ('matched', 'rejected', 'pending', 'approved'));
      END IF;
    END IF;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.invoice_matches') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'invoice_matches'
         AND column_name = 'user_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'invoice_matches'
         AND column_name = 'bank_transaction_id'
     ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.invoice_matches
      GROUP BY user_id, bank_transaction_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: duplicate (user_id, bank_transaction_id) values exist';
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS invoice_matches_user_bank_transaction_key
      ON public.invoice_matches (user_id, bank_transaction_id);
  END IF;
END
$$;

-- invoice_id intentionally receives no new FK here. The reviewed current
-- application schema does not declare one, and the application provides the
-- invoice identifier directly. Adding referential enforcement is a separate
-- design decision and must not invent a mapping from extracted_item_id.
-- The legacy bank_transaction_id and extracted_item_id FKs remain untouched.
-- The existing FOR ALL RLS policy remains in place; its user_id predicate is
-- still valid and the application uses the server-side service-role client.

-- Reconciliation tables are already compatible and are intentionally untouched.
-- In particular, approved_by/action_by remain text and audit_memo remains jsonb.

NOTIFY pgrst, 'reload schema';
