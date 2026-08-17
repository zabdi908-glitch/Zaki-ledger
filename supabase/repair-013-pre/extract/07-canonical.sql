SET default_transaction_read_only = on;
WITH dup AS (
  SELECT qb_transaction_id FROM public.reconciliation_matches
  WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL
  GROUP BY qb_transaction_id HAVING count(*) > 1
), involved AS (
  SELECT qb_transaction_id AS id FROM dup
  UNION
  SELECT m.bank_transaction_id FROM public.reconciliation_matches m
  JOIN dup d ON d.qb_transaction_id = m.qb_transaction_id
  WHERE m.matched_by = 'auto'
)
SELECT jsonb_build_object(
  'mappings', (SELECT jsonb_agg(jsonb_build_object(
      'id', lrm.id::text, 'legacy_record_type', lrm.legacy_record_type, 'legacy_id', lrm.legacy_id::text,
      'mapping_kind', lrm.mapping_kind, 'event_id', lrm.event_id::text, 'observation_id', lrm.observation_id::text,
      'document_id', lrm.document_id::text, 'relationship_id', lrm.relationship_id::text,
      'mapping_version', lrm.mapping_version, 'status', lrm.status, 'valid_from', lrm.valid_from, 'valid_to', lrm.valid_to,
      'created_operation_id', lrm.created_operation_id::text, 'created_at', lrm.created_at,
      'client_entity_id', lrm.client_entity_id::text
    )) FROM public.legacy_record_mappings lrm WHERE lrm.legacy_id IN (SELECT id FROM involved)),
  'relationships', (SELECT jsonb_agg(jsonb_build_object(
      'id', fr.id::text, 'client_entity_id', fr.client_entity_id::text, 'relationship_type', fr.relationship_type,
      'status', fr.status, 'evidence_strength', fr.evidence_strength,
      'confidence_basis_points', fr.confidence_basis_points, 'source_kind', fr.source_kind, 'reason', fr.reason,
      'created_by_kind', fr.created_by_kind, 'created_by_user_id', fr.created_by_user_id::text,
      'created_by_service', fr.created_by_service, 'reviewed_by_user_id', fr.reviewed_by_user_id::text,
      'supersedes_relationship_id', fr.supersedes_relationship_id::text,
      'created_at', fr.created_at, 'reviewed_at', fr.reviewed_at, 'closed_at', fr.closed_at
    )) FROM public.financial_relationships fr),
  'relationship_endpoints', (SELECT jsonb_agg(jsonb_build_object(
      'id', fre.id::text, 'relationship_id', fre.relationship_id::text, 'endpoint_role', fre.endpoint_role,
      'ordinal', fre.ordinal, 'event_id', fre.event_id::text, 'observation_id', fre.observation_id::text,
      'document_id', fre.document_id::text, 'created_at', fre.created_at, 'client_entity_id', fre.client_entity_id::text
    )) FROM public.financial_relationship_endpoints fre),
  'allocations', (SELECT jsonb_agg(jsonb_build_object(
      'id', fa.id::text, 'relationship_id', fa.relationship_id::text,
      'from_endpoint_id', fa.from_endpoint_id::text, 'to_endpoint_id', fa.to_endpoint_id::text,
      'source_amount_minor', fa.source_amount_minor, 'source_currency_code', fa.source_currency_code,
      'target_amount_minor', fa.target_amount_minor, 'target_currency_code', fa.target_currency_code,
      'status', fa.status, 'created_by_kind', fa.created_by_kind, 'created_by_user_id', fa.created_by_user_id::text,
      'created_by_service', fa.created_by_service, 'created_at', fa.created_at, 'closed_at', fa.closed_at,
      'client_entity_id', fa.client_entity_id::text
    )) FROM public.financial_allocations fa),
  'legacy_record_types', (SELECT jsonb_agg(row_to_json(t)) FROM (SELECT * FROM public.legacy_record_types) t)
) AS result;
