-- Parity checks: scratch restore vs the accepted production snapshot
-- (docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md §2).
-- Expected snapshot values are asserted directly; any mismatch aborts.

DO $$
DECLARE
  v int;
  v_dup int;
  v_app int;
BEGIN
  SELECT count(*) INTO v FROM public.bank_statements;
  IF v <> 12 THEN RAISE EXCEPTION 'PARITY FAIL: bank_statements expected 12, found %', v; END IF;
  SELECT count(*) INTO v FROM public.bank_transactions;
  IF v <> 646 THEN RAISE EXCEPTION 'PARITY FAIL: bank_transactions expected 646, found %', v; END IF;
  SELECT count(*) INTO v FROM public.qb_transactions;
  IF v <> 437 THEN RAISE EXCEPTION 'PARITY FAIL: qb_transactions expected 437, found %', v; END IF;
  SELECT count(*) INTO v FROM public.reconciliation_matches;
  IF v <> 573 THEN RAISE EXCEPTION 'PARITY FAIL: reconciliation_matches expected 573, found %', v; END IF;
  SELECT count(*) INTO v FROM public.reconciliation_audit_log;
  IF v <> 409 THEN RAISE EXCEPTION 'PARITY FAIL: reconciliation_audit_log expected 409, found %', v; END IF;
  SELECT count(*) INTO v FROM public.reconciliation_reports;
  IF v <> 6 THEN RAISE EXCEPTION 'PARITY FAIL: reconciliation_reports expected 6, found %', v; END IF;
  SELECT count(*) INTO v FROM public.reconciliation_decisions;
  IF v <> 217 THEN RAISE EXCEPTION 'PARITY FAIL: reconciliation_decisions expected 217, found %', v; END IF;
  SELECT count(*) INTO v FROM public.canonical_audit_ledger;
  IF v <> 52 THEN RAISE EXCEPTION 'PARITY FAIL: canonical_audit_ledger expected 52, found %', v; END IF;
  SELECT count(*) INTO v FROM public.default_tenant_identities;
  IF v <> 2 THEN RAISE EXCEPTION 'PARITY FAIL: default_tenant_identities expected 2, found %', v; END IF;

  SELECT count(*) INTO v FROM public.reconciliation_matches WHERE matched_by = 'manual';
  IF v <> 0 THEN RAISE EXCEPTION 'PARITY FAIL: manual rows expected 0, found %', v; END IF;

  SELECT count(*) INTO v FROM public.reconciliation_matches WHERE approved_at IS NOT NULL;
  IF v <> 409 THEN RAISE EXCEPTION 'PARITY FAIL: approved rows expected 409, found %', v; END IF;

  -- Pre-013/pristine snapshot: no superseded rows exist, so "live" is the
  -- whole table (the superseded_at column does not exist yet at this point).
  SELECT count(*) INTO v_dup FROM (
    SELECT qb_transaction_id FROM public.reconciliation_matches
    WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL
    GROUP BY qb_transaction_id HAVING count(*) > 1) d;
  IF v_dup <> 107 THEN RAISE EXCEPTION 'PARITY FAIL: duplicate live-auto endpoints expected 107, found %', v_dup; END IF;

  SELECT count(*) INTO v FROM public.financial_relationship_endpoints;
  IF v <> 0 THEN RAISE EXCEPTION 'PARITY FAIL: canonical layer expected empty (endpoints=% )', v; END IF;
  SELECT count(*) INTO v FROM public.financial_allocations;
  IF v <> 0 THEN RAISE EXCEPTION 'PARITY FAIL: canonical layer expected empty (allocations=% )', v; END IF;

  RAISE NOTICE 'PARITY OK: 9/9 table counts, 107 duplicate endpoints, 409 approved, 0 manual, canonical empty';
END;
$$;
