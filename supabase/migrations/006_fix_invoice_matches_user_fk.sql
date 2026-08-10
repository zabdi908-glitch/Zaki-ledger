-- Zaki Ledger - migration 006: repair invoice_matches owner FK
--
-- Replace only the verified legacy user_id FK from public.profiles(id) with
-- auth.users(id). This migration does not touch rows, RLS, other FKs, or
-- status/invoice compatibility columns.

DO $$
DECLARE
  user_id_attnum smallint;
  fk_count integer;
  fk record;
  invalid_user_count bigint;
BEGIN
  IF to_regclass('public.invoice_matches') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'invoice_matches'
        AND column_name = 'user_id'
        AND data_type = 'uuid'
    ) THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.user_id is missing or is not uuid';
    END IF;

    SELECT a.attnum
    INTO user_id_attnum
    FROM pg_attribute AS a
    WHERE a.attrelid = 'public.invoice_matches'::regclass
      AND a.attname = 'user_id'
      AND a.attnum > 0
      AND NOT a.attisdropped;

    SELECT count(*)
    INTO fk_count
    FROM pg_constraint AS con
    WHERE con.conrelid = 'public.invoice_matches'::regclass
      AND con.contype = 'f'
      AND con.conkey @> ARRAY[user_id_attnum]::smallint[];

    IF fk_count = 0 THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: no foreign key involving invoice_matches.user_id was found';
    ELSIF fk_count > 1 THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: multiple foreign keys involve invoice_matches.user_id';
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
      WHERE candidate.conrelid = 'public.invoice_matches'::regclass
        AND candidate.contype = 'f'
        AND candidate.conkey @> ARRAY[user_id_attnum]::smallint[]
    );

    IF fk.local_column_count <> 1 OR fk.target_column_count <> 1 THEN
      RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: invoice_matches.user_id is part of a composite foreign key';
    END IF;

    IF fk.target_schema = 'auth'
       AND fk.target_table = 'users'
       AND fk.target_column = 'id' THEN
      IF fk.delete_action <> 'c' THEN
        RAISE EXCEPTION
          'MANUAL REVIEW REQUIRED: invoice_matches.user_id already references auth.users(id) without ON DELETE CASCADE';
      END IF;
      -- Already repaired with the required target and delete behavior.
    ELSIF fk.target_schema = 'public'
       AND fk.target_table = 'profiles'
       AND fk.target_column = 'id' THEN
      IF to_regclass('auth.users') IS NULL THEN
        RAISE EXCEPTION 'MANUAL REVIEW REQUIRED: auth.users does not exist';
      END IF;

      SELECT count(*)
      INTO invalid_user_count
      FROM public.invoice_matches AS im
      WHERE NOT EXISTS (
        SELECT 1
        FROM auth.users AS au
        WHERE au.id = im.user_id
      );

      IF invalid_user_count > 0 THEN
        RAISE EXCEPTION
          'MANUAL REVIEW REQUIRED: % invoice_matches.user_id values do not exist in auth.users',
          invalid_user_count;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_constraint AS existing_constraint
        WHERE existing_constraint.conrelid = 'public.invoice_matches'::regclass
          AND existing_constraint.conname = 'invoice_matches_user_id_fkey'
          AND existing_constraint.oid <> fk.constraint_oid
      ) THEN
        RAISE EXCEPTION
          'MANUAL REVIEW REQUIRED: invoice_matches_user_id_fkey is already used by another constraint';
      END IF;

      EXECUTE format(
        'ALTER TABLE public.invoice_matches DROP CONSTRAINT %I',
        fk.constraint_name
      );

      ALTER TABLE public.invoice_matches
        ADD CONSTRAINT invoice_matches_user_id_fkey
        FOREIGN KEY (user_id)
        REFERENCES auth.users(id)
        ON DELETE CASCADE;
    ELSE
      RAISE EXCEPTION
        'MANUAL REVIEW REQUIRED: unexpected invoice_matches.user_id FK target %.%(%)',
        fk.target_schema,
        fk.target_table,
        fk.target_column;
    END IF;
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
