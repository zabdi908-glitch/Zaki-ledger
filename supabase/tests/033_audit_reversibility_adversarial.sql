-- Targeted transactional adversarial checks for migration 033.
BEGIN;

INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-000000000001');
INSERT INTO public.practices (id, name, created_by_user_id) VALUES
  ('00000000-0000-0000-0000-000000000101', 'Step 8 Practice A', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000102', 'Step 8 Practice B', '00000000-0000-0000-0000-000000000001');
INSERT INTO public.client_entities (id, practice_id, legal_name, display_name) VALUES
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 'Client A', 'Client A'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000102', 'Client B', 'Client B');
INSERT INTO public.ledger_books (id, client_entity_id, book_kind, display_name) VALUES
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', 'quickbooks', 'Book A'),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000202', 'xero', 'Book B'),
  ('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000201', 'quickbooks', 'Book A Other');

DO $$
DECLARE
  v_stream uuid;
  v_first jsonb;
  v_replay jsonb;
  v_event uuid;
  v_previous bytea;
  v_content bytea;
  v_failed boolean;
BEGIN
  v_stream := public.create_audit_stream_v1(
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000301',
    'step8-adversarial-stream', 'CLIENT', 'step8-test');

  v_first := public.record_audit_event_v1(
    v_stream, '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301',
    'event-key-1', 'TEST_EVENT', 'SYSTEM', 'step8-test', '2026-09-06T12:00:00Z',
    NULL, '[]', NULL, '[]', '{"amount":1}',
    encode(extensions.digest(convert_to('{"amount":1}', 'UTF8'), 'sha256'), 'hex'));
  v_replay := public.record_audit_event_v1(
    v_stream, '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301',
    'event-key-1', 'TEST_EVENT', 'SYSTEM', 'step8-test', '2026-09-06T12:00:00Z',
    NULL, '[]', NULL, '[]', '{"amount":1}',
    encode(extensions.digest(convert_to('{"amount":1}', 'UTF8'), 'sha256'), 'hex'));
  IF v_first->>'audit_event_id' <> v_replay->>'audit_event_id' OR (v_replay->>'reused')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'identical event-key replay did not reuse the event';
  END IF;
  v_event := (v_first->>'audit_event_id')::uuid;

  v_failed := false;
  BEGIN
    PERFORM public.record_audit_event_v1(
      v_stream, '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301',
      'event-key-1', 'TEST_EVENT', 'SYSTEM', 'step8-test', '2026-09-06T12:00:00Z',
      NULL, '[]', NULL, '[]', '{"amount":2}',
      encode(extensions.digest(convert_to('{"amount":2}', 'UTF8'), 'sha256'), 'hex'));
  EXCEPTION WHEN unique_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'changed event-key content was accepted'; END IF;

  SELECT last_event_hash INTO v_previous FROM public.audit_streams WHERE id = v_stream;
  v_content := extensions.digest(convert_to('{"amount":3}', 'UTF8'), 'sha256');

  v_failed := false;
  BEGIN
    INSERT INTO public.audit_events (
      stream_id, practice_id, client_entity_id, ledger_book_id, stream_sequence,
      event_key, event_type, actor_type, actor_id, occurred_at,
      event_payload, event_payload_canonical_json, content_sha256, previous_event_hash, event_hash
    ) VALUES (
      v_stream, '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', 2,
      'event-key-broken-previous', 'TEST_EVENT', 'SYSTEM', 'step8-test', '2026-09-06T12:01:00Z',
      '{"amount":3}', '{"amount":3}', v_content, decode(repeat('1', 64), 'hex'), decode(repeat('2', 64), 'hex'));
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'broken previous-event hash was accepted'; END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.audit_events (
      stream_id, practice_id, client_entity_id, ledger_book_id, stream_sequence,
      event_key, event_type, actor_type, actor_id, occurred_at,
      event_payload, event_payload_canonical_json, content_sha256, previous_event_hash, event_hash
    ) VALUES (
      v_stream, '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', 2,
      'event-key-broken-hash', 'TEST_EVENT', 'SYSTEM', 'step8-test', '2026-09-06T12:01:00Z',
      '{"amount":3}', '{"amount":3}', v_content, v_previous, decode(repeat('2', 64), 'hex'));
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'broken event hash was accepted'; END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.audit_state_snapshots (
      audit_event_id, practice_id, client_entity_id, ledger_book_id, snapshot_role,
      object_namespace, object_id, canonical_state, canonical_state_json, state_sha256, captured_at
    ) VALUES (
      v_event, '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301',
      'BEFORE', 'test', 'object-1', '{"state":"before"}', '{"state":"before"}',
      decode(repeat('3', 64), 'hex'), '2026-09-06T12:00:00Z');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'snapshot hash mismatch was accepted'; END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.audit_state_snapshots (
      audit_event_id, practice_id, client_entity_id, ledger_book_id, snapshot_role,
      object_namespace, object_id, canonical_state, canonical_state_json, state_sha256, captured_at
    ) VALUES (
      v_event, '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301',
      'AFTER', 'test', 'object-1', '{"state":"after"}', '{"state":"after"}',
      decode(repeat('4', 64), 'hex'), '2026-09-06T12:02:00Z');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'after-snapshot hash mismatch was accepted'; END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.audit_event_links (
      audit_event_id, practice_id, client_entity_id, ledger_book_id, link_role,
      target_namespace, target_id, target_practice_id, target_client_entity_id, target_ledger_book_id
    ) VALUES (
      v_event, '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000303',
      'SOURCE_EVIDENCE', 'test', 'cross-book', '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000303');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'cross-book link was accepted'; END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.audit_event_links (
      audit_event_id, practice_id, client_entity_id, ledger_book_id, link_role,
      target_namespace, target_id, target_practice_id, target_client_entity_id, target_ledger_book_id
    ) VALUES (
      v_event, '00000000-0000-0000-0000-000000000102',
      '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000302',
      'SOURCE_EVIDENCE', 'test', 'cross-tenant', '00000000-0000-0000-0000-000000000102',
      '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000302');
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'cross-tenant/client link was accepted'; END IF;

  v_failed := false;
  BEGIN UPDATE public.audit_events SET event_type = 'MUTATED' WHERE id = v_event;
  EXCEPTION WHEN SQLSTATE '55000' THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'audit event update was accepted'; END IF;

  v_failed := false;
  BEGIN DELETE FROM public.audit_events WHERE id = v_event;
  EXCEPTION WHEN SQLSTATE '55000' THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'audit event delete was accepted'; END IF;
END;
$$;

ROLLBACK;
