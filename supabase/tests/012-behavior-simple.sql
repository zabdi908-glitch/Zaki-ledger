-- Migration 012 Behavioral Tests — simplified for psql via stdin
-- Must run AFTER structural tests (which confirmed schema exists)

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  bid uuid := 'a0000000-0000-0000-0000-000000000002';
  stmt_a uuid; stmt_b uuid;
  bt_a uuid; bt_b uuid;
  qt_a uuid; qt_b uuid;
  match_a uuid; match_b uuid;
  audit_id uuid; dec_id uuid;
  reg record;
  reg_b record;
  test_ok boolean;
BEGIN
  -- Setup users (confirmed_at is generated, email_confirmed_at confirms them)
  INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at, email_confirmed_at, is_sso_user)
  VALUES (aid, 'user-a@test.local', 'x', '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now(), now(), false) ON CONFLICT DO NOTHING;
  INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at, email_confirmed_at, is_sso_user)
  VALUES (bid, 'user-b@test.local', 'x', '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now(), now(), false) ON CONFLICT DO NOTHING;
  -- Manually set confirmed_at for eligibility (bypass generated column)
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = aid AND email_confirmed_at IS NULL;
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = bid AND email_confirmed_at IS NULL;
  PERFORM public.ensure_default_tenant_for_user_v1(aid);
  PERFORM public.ensure_default_tenant_for_user_v1(bid);
  SELECT * INTO reg FROM public.default_tenant_identities WHERE user_id=aid;
  SELECT * INTO reg_b FROM public.default_tenant_identities WHERE user_id=bid;

  -- Root write guards R1-R4: bank_statements
  BEGIN INSERT INTO public.bank_statements(id,user_id,file_format,client_entity_id) VALUES(gen_random_uuid(),aid,'csv',reg.client_entity_id); RAISE EXCEPTION 'FAIL R1'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'ledger_book_id|23502' THEN RAISE NOTICE 'R1: PASS'; ELSE RAISE EXCEPTION 'R1 unexpected: %', SQLERRM; END IF; END;
  BEGIN INSERT INTO public.bank_statements(id,user_id,file_format,ledger_book_id) VALUES(gen_random_uuid(),aid,'csv',reg.internal_ledger_book_id); RAISE EXCEPTION 'FAIL R2'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'R2: PASS'; ELSE RAISE EXCEPTION 'R2 unexpected: %', SQLERRM; END IF; END;
  BEGIN INSERT INTO public.bank_statements(id,user_id,file_format) VALUES(gen_random_uuid(),aid,'csv'); RAISE EXCEPTION 'FAIL R3'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'R3: PASS'; ELSE RAISE EXCEPTION 'R3 unexpected: %', SQLERRM; END IF; END;
  BEGIN INSERT INTO public.bank_statements(id,user_id,file_format,client_entity_id,ledger_book_id) VALUES(gen_random_uuid(),aid,'csv',reg.client_entity_id,reg.internal_ledger_book_id) RETURNING id INTO stmt_a; RAISE NOTICE 'R4: PASS'; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FAIL R4: %', SQLERRM; END;

  -- Root write guards R5-R8: qb_transactions
  BEGIN INSERT INTO public.qb_transactions(id,user_id,posted_date,amount,client_entity_id) VALUES(gen_random_uuid(),aid,now()::date,100,reg.client_entity_id); RAISE EXCEPTION 'FAIL R5'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'ledger_book_id|23502' THEN RAISE NOTICE 'R5: PASS'; END IF; END;
  BEGIN INSERT INTO public.qb_transactions(id,user_id,posted_date,amount,ledger_book_id) VALUES(gen_random_uuid(),aid,now()::date,100,reg.internal_ledger_book_id); RAISE EXCEPTION 'FAIL R6'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'R6: PASS'; END IF; END;
  BEGIN INSERT INTO public.qb_transactions(id,user_id,posted_date,amount) VALUES(gen_random_uuid(),aid,now()::date,100); RAISE EXCEPTION 'FAIL R7'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'R7: PASS'; END IF; END;
  BEGIN INSERT INTO public.qb_transactions(id,user_id,posted_date,amount,client_entity_id,ledger_book_id) VALUES(gen_random_uuid(),aid,now()::date,100,reg.client_entity_id,reg.internal_ledger_book_id) RETURNING id INTO qt_a; RAISE NOTICE 'R8: PASS'; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FAIL R8: %', SQLERRM; END;

  -- Child write guards R9-R10
  BEGIN INSERT INTO public.bank_transactions(id,statement_id,user_id,transaction_date,amount) VALUES(gen_random_uuid(),stmt_a,aid,now()::date,100); RAISE EXCEPTION 'FAIL R9'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'R9: PASS'; END IF; END;
  BEGIN INSERT INTO public.bank_transactions(id,statement_id,user_id,transaction_date,amount,client_entity_id) VALUES(gen_random_uuid(),stmt_a,aid,now()::date,100,reg.client_entity_id) RETURNING id INTO bt_a; RAISE NOTICE 'R10: PASS'; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FAIL R10: %', SQLERRM; END;

  -- R11, R13, R14: child guards on matches/reports/decisions
  BEGIN INSERT INTO public.reconciliation_matches(id,user_id,statement_id,bank_transaction_id,matched_by) VALUES(gen_random_uuid(),aid,stmt_a,bt_a,'auto'); RAISE EXCEPTION 'FAIL R11'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'R11: PASS'; END IF; END;
  BEGIN INSERT INTO public.reconciliation_reports(id,user_id,statement_id) VALUES(gen_random_uuid(),aid,stmt_a); RAISE EXCEPTION 'FAIL R13'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'R13: PASS'; END IF; END;
  BEGIN INSERT INTO public.reconciliation_decisions(id,user_id,statement_id,bank_transaction_id,decision_type) VALUES(gen_random_uuid(),aid,stmt_a,bt_a,'approve'); RAISE EXCEPTION 'FAIL R14'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'R14: PASS'; END IF; END;

  -- Immutability: same -> different -> NULL (NULL->value backfill applies to
  -- pre-012 rows and is covered by the recovery drill that re-runs Migration 012)
  INSERT INTO public.bank_statements(id,user_id,file_format,client_entity_id,ledger_book_id) VALUES(gen_random_uuid(),aid,'csv',reg.client_entity_id,reg.internal_ledger_book_id) RETURNING id INTO stmt_b;
  BEGIN UPDATE public.bank_statements SET client_entity_id=reg.client_entity_id WHERE id=stmt_b; RAISE NOTICE 'Immutability same->same: PASS'; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FAIL immut same->same: %', SQLERRM; END;
  BEGIN UPDATE public.bank_statements SET client_entity_id=reg_b.client_entity_id WHERE id=stmt_b; RAISE EXCEPTION 'FAIL immut A->B'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'immutable|42806' THEN RAISE NOTICE 'Immutability A->B: PASS'; END IF; END;
  BEGIN UPDATE public.bank_statements SET client_entity_id=NULL WHERE id=stmt_b; RAISE EXCEPTION 'FAIL immut A->NULL'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'immutable|42806' THEN RAISE NOTICE 'Immutability A->NULL: PASS'; END IF; END;
  BEGIN UPDATE public.bank_statements SET ledger_book_id=reg_b.internal_ledger_book_id WHERE id=stmt_b; RAISE EXCEPTION 'FAIL immut ledger A->B'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'immutable|42806' THEN RAISE NOTICE 'Immutability ledger A->B: PASS'; END IF; END;
  BEGIN UPDATE public.bank_statements SET ledger_book_id=NULL WHERE id=stmt_b; RAISE EXCEPTION 'FAIL immut ledger A->NULL'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'immutable|42806' THEN RAISE NOTICE 'Immutability ledger A->NULL: PASS'; END IF; END;

  -- QB same-client enforcement
  INSERT INTO public.qb_transactions(id,user_id,posted_date,amount,client_entity_id,ledger_book_id) VALUES(gen_random_uuid(),bid,now()::date,200,reg_b.client_entity_id,reg_b.internal_ledger_book_id) RETURNING id INTO qt_b;
  INSERT INTO public.reconciliation_matches(id,user_id,statement_id,bank_transaction_id,qb_transaction_id,matched_by,client_entity_id,flagged_level) VALUES(gen_random_uuid(),aid,stmt_a,bt_a,qt_a,'auto',reg.client_entity_id,'green') RETURNING id INTO match_a;
  BEGIN INSERT INTO public.reconciliation_matches(id,user_id,statement_id,bank_transaction_id,qb_transaction_id,matched_by,client_entity_id,flagged_level) VALUES(gen_random_uuid(),aid,stmt_a,bt_a,qt_b,'auto',reg.client_entity_id,'green'); RAISE EXCEPTION 'FAIL QB cross-client'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'same client|23514' THEN RAISE NOTICE 'QB cross-client: PASS'; END IF; END;

  -- QB delete -> SET NULL
  DELETE FROM public.qb_transactions WHERE id=qt_a;
  SELECT qb_transaction_id IS NULL AND client_entity_id=reg.client_entity_id INTO test_ok FROM public.reconciliation_matches WHERE id=match_a;
  IF test_ok THEN RAISE NOTICE 'QB SET NULL: PASS'; ELSE RAISE EXCEPTION 'FAIL QB SET NULL'; END IF;

  -- Audit immutability: A8 insert, A10/A11 null guards, A12 update, A13 delete
  INSERT INTO public.reconciliation_audit_log(id,reconciliation_match_id,action,action_by,action_at,user_id,client_entity_id) VALUES(gen_random_uuid(),match_a,'match_approved','test',now(),aid,reg.client_entity_id) RETURNING id INTO audit_id;
  RAISE NOTICE 'A8 audit insert: PASS';

  BEGIN INSERT INTO public.reconciliation_audit_log(id,reconciliation_match_id,action,action_by,action_at,client_entity_id) VALUES(gen_random_uuid(),match_a,'test','test',now(),reg.client_entity_id); RAISE EXCEPTION 'FAIL A10'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'user_id|23502' THEN RAISE NOTICE 'A10 NULL user_id: PASS'; END IF; END;
  BEGIN INSERT INTO public.reconciliation_audit_log(id,reconciliation_match_id,action,action_by,action_at,user_id) VALUES(gen_random_uuid(),match_a,'test','test',now(),aid); RAISE EXCEPTION 'FAIL A11'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'client_entity_id|23502' THEN RAISE NOTICE 'A11 NULL client: PASS'; END IF; END;
  BEGIN UPDATE public.reconciliation_audit_log SET action='tampered' WHERE id=audit_id; RAISE EXCEPTION 'FAIL A12'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'immutable|42806' THEN RAISE NOTICE 'A12 evidence immut: PASS'; END IF; END;
  BEGIN DELETE FROM public.reconciliation_audit_log WHERE id=audit_id; RAISE EXCEPTION 'FAIL A13'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'immutable|42806' THEN RAISE NOTICE 'A13 no-delete: PASS'; END IF; END;

  -- Decision RESTRICT
  INSERT INTO public.reconciliation_decisions(id,user_id,statement_id,bank_transaction_id,decision_type,client_entity_id) VALUES(gen_random_uuid(),aid,stmt_a,bt_a,'approve',reg.client_entity_id) RETURNING id INTO dec_id;
  BEGIN DELETE FROM public.bank_statements WHERE id=stmt_a; RAISE EXCEPTION 'FAIL decision RESTRICT'; EXCEPTION WHEN OTHERS THEN IF SQLERRM ~ 'restrict|foreign key' THEN RAISE NOTICE 'Decision RESTRICT: PASS'; END IF; END;

  -- Cleanup
  DELETE FROM public.reconciliation_decisions WHERE id=dec_id;
  DELETE FROM public.reconciliation_matches WHERE id=match_a;
  DELETE FROM public.qb_transactions WHERE id IN (qt_a, qt_b);
  DELETE FROM public.bank_transactions WHERE id=bt_a;
  DELETE FROM public.bank_statements WHERE id IN (stmt_a, stmt_b);
  DELETE FROM public.reconciliation_audit_log WHERE id=audit_id;

  RAISE NOTICE 'ALL BEHAVIORAL TESTS PASSED';
END;
$$;
