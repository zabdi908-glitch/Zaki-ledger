-- ZAKI-REPAIR-013-PRE DEDUP OPERATION (design rehearsal target).
-- Idempotent, deterministic, fail-closed, one transaction, zero DELETEs.
-- Preconditions: write freeze ON; repair-prep columns exist; state unchanged since inventory.
BEGIN;

-- Serialize repair attempts (advisory lock; released at COMMIT/ROLLBACK).
SELECT pg_advisory_xact_lock(0x5A414B49);  -- 'ZAKI'

-- =========================================================================
-- P0. State dispatcher: pristine -> proceed | already-applied -> no-op | else -> abort
-- =========================================================================
DO $$
DECLARE
  v_total int; v_sup int; v_dup int;
BEGIN
  SELECT count(*) INTO v_total FROM public.reconciliation_matches;
  IF v_total <> 573 THEN RAISE EXCEPTION 'STOP: total matches expected 573, found %', v_total; END IF;

  SELECT count(*) INTO v_sup FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL;
  SELECT count(*) INTO v_dup FROM (
    SELECT qb_transaction_id FROM public.reconciliation_matches
    WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
    GROUP BY qb_transaction_id HAVING count(*) > 1) d;

  IF v_dup = 0 AND v_sup = 252 THEN
    RAISE NOTICE 'REPAIR ALREADY APPLIED (idempotent no-op)';
  ELSIF v_dup = 107 AND v_sup = 0 THEN
    IF (SELECT count(*) FROM public.reconciliation_matches WHERE matched_by='manual') <> 0 THEN
      RAISE EXCEPTION 'STOP: manual rows appeared (expected 0)';
    END IF;
    IF (SELECT count(*) FROM public.reconciliation_matches m
        JOIN (SELECT qb_transaction_id FROM public.reconciliation_matches
              WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
              GROUP BY qb_transaction_id HAVING count(*) > 1) d USING (qb_transaction_id)
        WHERE m.matched_by='auto' AND m.superseded_at IS NULL) <> 357 THEN
      RAISE EXCEPTION 'STOP: live dup rows expected 357';
    END IF;
    IF (SELECT count(*) FROM public.reconciliation_matches m
        JOIN (SELECT qb_transaction_id FROM public.reconciliation_matches
              WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
              GROUP BY qb_transaction_id HAVING count(*) > 1) d USING (qb_transaction_id)
        WHERE m.matched_by='auto' AND m.superseded_at IS NULL AND m.approved_at IS NULL) <> 154 THEN
      RAISE EXCEPTION 'STOP: unapproved dup rows expected 154';
    END IF;
    IF (SELECT count(*) FROM public.reconciliation_matches m
        JOIN (SELECT qb_transaction_id FROM public.reconciliation_matches
              WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
              GROUP BY qb_transaction_id HAVING count(*) > 1) d USING (qb_transaction_id)
        WHERE m.matched_by='auto' AND m.superseded_at IS NULL AND m.approved_at IS NOT NULL
          AND abs((SELECT b.amount FROM public.bank_transactions b WHERE b.id = m.bank_transaction_id)
                - (SELECT q.amount FROM public.qb_transactions q WHERE q.id = m.qb_transaction_id)) > 0.01) <> 93 THEN
      RAISE EXCEPTION 'STOP: R3 non-exact approved rows expected 93';
    END IF;
    IF (SELECT count(*) FROM public.reconciliation_matches m
        JOIN public.qb_transactions q ON q.id = m.qb_transaction_id
        WHERE m.matched_by='auto' AND m.superseded_at IS NULL AND m.approved_at IS NOT NULL
          AND q.description ILIKE '%4FB-CANONICAL-TEST%') <> 1 THEN
      RAISE EXCEPTION 'STOP: R5 approved test rows expected 1';
    END IF;
  ELSE
    RAISE EXCEPTION 'STOP: unexpected partial state (dup=%, superseded=%); manual review required', v_dup, v_sup;
  END IF;
END $$;

-- =========================================================================
-- S1. Supersede all unapproved duplicate live-auto rows (deterministic)
-- =========================================================================
WITH ctx AS (
  SELECT m.id, m.qb_transaction_id, m.user_id, m.client_entity_id, m.confidence,
         (SELECT count(*) FROM public.reconciliation_matches x
          JOIN public.bank_transactions b ON b.id = x.bank_transaction_id
          JOIN public.qb_transactions q ON q.id = x.qb_transaction_id
          WHERE x.qb_transaction_id = m.qb_transaction_id AND x.matched_by='auto'
            AND x.superseded_at IS NULL AND x.approved_at IS NOT NULL
            AND abs(b.amount - q.amount) <= 0.01) AS n_app_exact,
         (SELECT count(*) FROM public.reconciliation_matches x
          WHERE x.qb_transaction_id = m.qb_transaction_id AND x.matched_by='auto'
            AND x.superseded_at IS NULL AND x.approved_at IS NOT NULL) AS n_app,
         EXISTS (SELECT 1 FROM public.qb_transactions q
                 WHERE q.id = m.qb_transaction_id AND q.description ILIKE '%4FB-CANONICAL-TEST%') AS is_test
  FROM public.reconciliation_matches m
  WHERE m.matched_by='auto' AND m.qb_transaction_id IS NOT NULL
    AND m.superseded_at IS NULL AND m.approved_at IS NULL
    AND m.qb_transaction_id IN (
      SELECT qb_transaction_id FROM public.reconciliation_matches
      WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
      GROUP BY qb_transaction_id HAVING count(*) > 1)
), targets AS (
  SELECT c.*,
         CASE
           WHEN c.is_test THEN 'synthetic_test_contamination_unapproved'
           WHEN c.n_app_exact >= 2 THEN 'conflicting_approved_claim_stray_unapproved'
           WHEN c.n_app = 1 THEN 'accidental_auto_duplicate_unapproved'
           ELSE 'unsupported_stray_claim_unapproved'
         END AS reason,
         CASE WHEN c.is_test OR c.n_app_exact <> 1 THEN NULL
              ELSE (SELECT x.id FROM public.reconciliation_matches x
                    JOIN public.bank_transactions b ON b.id = x.bank_transaction_id
                    JOIN public.qb_transactions q ON q.id = x.qb_transaction_id
                    WHERE x.qb_transaction_id = c.qb_transaction_id AND x.matched_by='auto'
                      AND x.superseded_at IS NULL AND x.approved_at IS NOT NULL AND x.id <> c.id
                      AND abs(b.amount - q.amount) <= 0.01
                    ORDER BY x.id LIMIT 1)
         END AS survivor_id
  FROM ctx c
  FOR UPDATE
), upd AS (
  UPDATE public.reconciliation_matches mm SET
    superseded_at = now(),
    superseded_by_match_id = t.survivor_id,
    supersede_reason = t.reason,
    supersede_operation_id = '11111111-2222-3333-4444-555555555555'::uuid
  FROM targets t WHERE mm.id = t.id
  RETURNING mm.id
)
INSERT INTO public.reconciliation_audit_log
  (id, reconciliation_match_id, action, action_by, action_at,
   old_confidence, new_confidence, client_entity_id, user_id,
   operation_id, previous_state, resulting_state, evidence)
SELECT gen_random_uuid(), t.id, 'match_repair_superseded', 'zaki-repair-013-pre', now(),
       t.confidence, t.confidence, t.client_entity_id, t.user_id,
       '11111111-2222-3333-4444-555555555555'::uuid,
       jsonb_build_object('approved_at', NULL),
       jsonb_build_object('superseded_at', now(),
                          'superseded_by_match_id', t.survivor_id,
                          'supersede_reason', t.reason),
       jsonb_build_object('stage', 'S1', 'reason', t.reason, 'survivor_match_id', t.survivor_id)
FROM targets t JOIN upd u ON u.id = t.id;

-- =========================================================================
-- S2a. R5: supersede approved synthetic-test rows (zero live claims on test QB rows)
-- =========================================================================
WITH targets AS (
  SELECT m.id, m.qb_transaction_id, m.user_id, m.client_entity_id, m.confidence
  FROM public.reconciliation_matches m
  JOIN public.qb_transactions q ON q.id = m.qb_transaction_id
  WHERE m.matched_by='auto' AND m.superseded_at IS NULL
    AND m.approved_at IS NOT NULL
    AND q.description ILIKE '%4FB-CANONICAL-TEST%'
  FOR UPDATE
), upd AS (
  UPDATE public.reconciliation_matches mm SET
    superseded_at = now(),
    superseded_by_match_id = NULL,
    supersede_reason = 'synthetic_test_contamination_approved',
    supersede_operation_id = '11111111-2222-3333-4444-555555555555'::uuid
  FROM targets t WHERE mm.id = t.id
  RETURNING mm.id
)
INSERT INTO public.reconciliation_audit_log
  (id, reconciliation_match_id, action, action_by, action_at,
   old_confidence, new_confidence, client_entity_id, user_id,
   operation_id, previous_state, resulting_state, evidence)
SELECT gen_random_uuid(), t.id, 'match_repair_superseded', 'zaki-repair-013-pre', now(),
       t.confidence, t.confidence, t.client_entity_id, t.user_id,
       '11111111-2222-3333-4444-555555555555'::uuid,
       jsonb_build_object('approved_at', 'approved'),
       jsonb_build_object('superseded_at', now(), 'supersede_reason', 'synthetic_test_contamination_approved'),
       jsonb_build_object('stage', 'S2a', 'reason', 'synthetic_test_contamination_approved')
FROM targets t JOIN upd u ON u.id = t.id;

-- =========================================================================
-- S2b. R3: supersede approved rows whose bank amount contradicts the QB amount
-- =========================================================================
WITH targets AS (
  SELECT m.id, m.qb_transaction_id, m.user_id, m.client_entity_id, m.confidence,
         (SELECT x.id FROM public.reconciliation_matches x
          JOIN public.bank_transactions b ON b.id = x.bank_transaction_id
          JOIN public.qb_transactions q ON q.id = x.qb_transaction_id
          WHERE x.qb_transaction_id = m.qb_transaction_id AND x.matched_by='auto'
            AND x.superseded_at IS NULL AND x.approved_at IS NOT NULL AND x.id <> m.id
            AND abs(b.amount - q.amount) <= 0.01
          ORDER BY x.id LIMIT 1) AS survivor_id
  FROM public.reconciliation_matches m
  WHERE m.matched_by='auto' AND m.qb_transaction_id IS NOT NULL
    AND m.superseded_at IS NULL AND m.approved_at IS NOT NULL
    AND m.qb_transaction_id IN (
      SELECT qb_transaction_id FROM public.reconciliation_matches
      WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
      GROUP BY qb_transaction_id HAVING count(*) > 1)
    AND abs((SELECT b.amount FROM public.bank_transactions b WHERE b.id = m.bank_transaction_id)
          - (SELECT q.amount FROM public.qb_transactions q WHERE q.id = m.qb_transaction_id)) > 0.01
    AND NOT EXISTS (SELECT 1 FROM public.qb_transactions q2
                    WHERE q2.id = m.qb_transaction_id AND q2.description ILIKE '%4FB-CANONICAL-TEST%')
  FOR UPDATE
), upd AS (
  UPDATE public.reconciliation_matches mm SET
    superseded_at = now(),
    superseded_by_match_id = t.survivor_id,
    supersede_reason = 'unsupported_approved_claim',
    supersede_operation_id = '11111111-2222-3333-4444-555555555555'::uuid
  FROM targets t WHERE mm.id = t.id
  RETURNING mm.id
)
INSERT INTO public.reconciliation_audit_log
  (id, reconciliation_match_id, action, action_by, action_at,
   old_confidence, new_confidence, client_entity_id, user_id,
   operation_id, previous_state, resulting_state, evidence)
SELECT gen_random_uuid(), t.id, 'match_repair_superseded', 'zaki-repair-013-pre', now(),
       t.confidence, t.confidence, t.client_entity_id, t.user_id,
       '11111111-2222-3333-4444-555555555555'::uuid,
       jsonb_build_object('approved_at', 'approved'),
       jsonb_build_object('superseded_at', now(),
                          'superseded_by_match_id', t.survivor_id,
                          'supersede_reason', 'unsupported_approved_claim'),
       jsonb_build_object('stage', 'S2b', 'reason', 'unsupported_approved_claim', 'survivor_match_id', t.survivor_id)
FROM targets t JOIN upd u ON u.id = t.id;

-- =========================================================================
-- S2c. R6: conflicting approved exact-amount pairs — keep the row whose
--      statement was uploaded earliest; supersede the duplicate-evidence rows.
-- =========================================================================
WITH ranked AS (
  SELECT m.id, m.user_id, m.client_entity_id, m.confidence,
         row_number() OVER (
           PARTITION BY m.qb_transaction_id
           ORDER BY s.upload_date, m.id) AS rn
  FROM public.reconciliation_matches m
  JOIN public.bank_transactions b ON b.id = m.bank_transaction_id
  JOIN public.qb_transactions q ON q.id = m.qb_transaction_id
  JOIN public.bank_statements s ON s.id = m.statement_id
  WHERE m.matched_by='auto' AND m.qb_transaction_id IS NOT NULL
    AND m.superseded_at IS NULL AND m.approved_at IS NOT NULL
    AND abs(b.amount - q.amount) <= 0.01
    AND (SELECT count(*) FROM public.reconciliation_matches x
         JOIN public.bank_transactions bx ON bx.id = x.bank_transaction_id
         WHERE x.qb_transaction_id = m.qb_transaction_id AND x.matched_by='auto'
           AND x.superseded_at IS NULL AND x.approved_at IS NOT NULL
           AND abs(bx.amount - q.amount) <= 0.01) >= 2
), targets AS (
  SELECT r.id, r.user_id, r.client_entity_id, r.confidence
  FROM ranked r WHERE r.rn > 1
  FOR UPDATE
), upd AS (
  UPDATE public.reconciliation_matches mm SET
    superseded_at = now(),
    superseded_by_match_id = NULL,
    supersede_reason = 'conflicting_approved_duplicate_evidence',
    supersede_operation_id = '11111111-2222-3333-4444-555555555555'::uuid
  FROM targets t WHERE mm.id = t.id
  RETURNING mm.id
)
INSERT INTO public.reconciliation_audit_log
  (id, reconciliation_match_id, action, action_by, action_at,
   old_confidence, new_confidence, client_entity_id, user_id,
   operation_id, previous_state, resulting_state, evidence)
SELECT gen_random_uuid(), t.id, 'match_repair_superseded', 'zaki-repair-013-pre', now(),
       t.confidence, t.confidence, t.client_entity_id, t.user_id,
       '11111111-2222-3333-4444-555555555555'::uuid,
       jsonb_build_object('approved_at', 'approved'),
       jsonb_build_object('superseded_at', now(), 'supersede_reason', 'conflicting_approved_duplicate_evidence'),
       jsonb_build_object('stage', 'S2c', 'reason', 'conflicting_approved_duplicate_evidence')
FROM targets t JOIN upd u ON u.id = t.id;

-- =========================================================================
-- P1. Post-state assertions (deterministic expected counts)
-- =========================================================================
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.reconciliation_matches;
  IF v <> 573 THEN RAISE EXCEPTION 'FAIL: total matches changed to % (must stay 573, no deletes)', v; END IF;
  SELECT count(*) INTO v FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL;
  IF v <> 252 THEN RAISE EXCEPTION 'FAIL: superseded rows expected 252, found %', v; END IF;
  SELECT count(*) INTO v FROM public.reconciliation_matches WHERE superseded_at IS NULL;
  IF v <> 321 THEN RAISE EXCEPTION 'FAIL: live rows expected 321, found %', v; END IF;
  SELECT count(*) INTO v FROM (
    SELECT qb_transaction_id FROM public.reconciliation_matches
    WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
    GROUP BY qb_transaction_id HAVING count(*) > 1) d;
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL: duplicate live-auto endpoints remain: %', v; END IF;
  SELECT count(*) INTO v FROM public.reconciliation_audit_log WHERE action='match_repair_superseded';
  IF v <> 252 THEN RAISE EXCEPTION 'FAIL: repair audit rows expected 252, found %', v; END IF;
  SELECT count(*) INTO v FROM public.reconciliation_matches
  WHERE superseded_at IS NOT NULL AND supersede_reason IS NULL;
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL: % superseded rows lack a reason', v; END IF;
END $$;

COMMIT;
