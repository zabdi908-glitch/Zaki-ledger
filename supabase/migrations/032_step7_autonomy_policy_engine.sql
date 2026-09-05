-- Step 7 Day 4: additive autonomy policy foundation only.
-- This migration stores policy facts and decisions. It grants no execution or posting capability.

BEGIN;

CREATE OR REPLACE FUNCTION public.autonomy_decode_sha256_v1(p_value text, p_label text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '% must be a lowercase SHA-256 hex digest', p_label USING ERRCODE = '22023';
  END IF;
  RETURN decode(p_value, 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.autonomy_text_array_unique_v1(p_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
  SELECT cardinality(p_values) = (SELECT count(DISTINCT value) FROM unnest(p_values) AS value)
$$;

CREATE TABLE public.autonomy_policy_bundles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version           text NOT NULL UNIQUE CHECK (btrim(policy_version) <> ''),
  contract_version         text NOT NULL CHECK (btrim(contract_version) <> ''),
  canonicalization_version text NOT NULL CHECK (btrim(canonicalization_version) <> ''),
  evaluator_version        text NOT NULL CHECK (btrim(evaluator_version) <> ''),
  bundle_json              jsonb NOT NULL CHECK (jsonb_typeof(bundle_json) = 'object'),
  bundle_sha256            bytea NOT NULL UNIQUE CHECK (octet_length(bundle_sha256) = 32),
  published_at             timestamptz NOT NULL DEFAULT now(),
  published_by             text NOT NULL CHECK (btrim(published_by) <> ''),
  supersedes_bundle_id     uuid REFERENCES public.autonomy_policy_bundles(id) ON DELETE RESTRICT,
  UNIQUE (id, bundle_sha256),
  UNIQUE (id, bundle_sha256, evaluator_version),
  CHECK (supersedes_bundle_id IS NULL OR supersedes_bundle_id <> id),
  CHECK (bundle_json->>'policyVersion' = policy_version),
  CHECK (bundle_json->>'contractVersion' = contract_version),
  CHECK (bundle_json->>'canonicalizationVersion' = canonicalization_version),
  CHECK (bundle_json->>'evaluatorVersion' = evaluator_version)
);

CREATE TABLE public.client_policy_snapshots (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id                uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  policy_bundle_id                uuid NOT NULL,
  policy_bundle_sha256            bytea NOT NULL CHECK (octet_length(policy_bundle_sha256) = 32),
  snapshot_version                bigint NOT NULL CHECK (snapshot_version > 0),
  snapshot_json                   jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  snapshot_sha256                 bytea NOT NULL UNIQUE CHECK (octet_length(snapshot_sha256) = 32),
  max_single_action_amount_minor  bigint,
  max_daily_aggregate_amount_minor bigint,
  supersedes_snapshot_id          uuid,
  recorded_at                     timestamptz NOT NULL DEFAULT now(),
  recorded_by                     text NOT NULL CHECK (btrim(recorded_by) <> ''),
  UNIQUE (client_entity_id, snapshot_version),
  UNIQUE (id, client_entity_id),
  UNIQUE (id, client_entity_id, policy_bundle_id, snapshot_sha256),
  FOREIGN KEY (policy_bundle_id, policy_bundle_sha256)
    REFERENCES public.autonomy_policy_bundles(id, bundle_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_snapshot_id, client_entity_id)
    REFERENCES public.client_policy_snapshots(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (supersedes_snapshot_id IS NULL OR supersedes_snapshot_id <> id),
  CHECK ((snapshot_json->>'snapshotVersion')::bigint = snapshot_version),
  CHECK ((snapshot_json->>'clientEntityId')::uuid = client_entity_id),
  CHECK (snapshot_json->>'maxSingleActionAmountMinor' IS NOT DISTINCT FROM
    CASE WHEN max_single_action_amount_minor IS NULL THEN NULL ELSE max_single_action_amount_minor::text END),
  CHECK (snapshot_json->>'maxDailyAggregateAmountMinor' IS NOT DISTINCT FROM
    CASE WHEN max_daily_aggregate_amount_minor IS NULL THEN NULL ELSE max_daily_aggregate_amount_minor::text END),
  CHECK (NOT (snapshot_json ? 'amountDecimal') AND NOT (snapshot_json ? 'materialityDecimal'))
);

CREATE TABLE public.normalized_policy_inputs (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_bundle_id              uuid NOT NULL,
  policy_bundle_sha256          bytea NOT NULL CHECK (octet_length(policy_bundle_sha256) = 32),
  client_policy_snapshot_id     uuid NOT NULL,
  client_policy_snapshot_sha256 bytea NOT NULL CHECK (octet_length(client_policy_snapshot_sha256) = 32),
  client_entity_id              uuid NOT NULL,
  action_type                   text NOT NULL CHECK (btrim(action_type) <> ''),
  action_fingerprint_version    text NOT NULL CHECK (btrim(action_fingerprint_version) <> ''),
  claimed_action_fingerprint    text NOT NULL,
  computed_action_fingerprint   bytea NOT NULL CHECK (octet_length(computed_action_fingerprint) = 32),
  action_snapshot_json          jsonb NOT NULL CHECK (jsonb_typeof(action_snapshot_json) = 'object'),
  normalized_input_json         jsonb NOT NULL CHECK (jsonb_typeof(normalized_input_json) = 'object'),
  normalization_issues_json     jsonb NOT NULL CHECK (jsonb_typeof(normalization_issues_json) = 'array'),
  input_sha256                  bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
  submitted_payload_sha256      bytea NOT NULL CHECK (octet_length(submitted_payload_sha256) = 32),
  amount_minor                  bigint,
  daily_aggregate_before_minor  bigint,
  currency_code                 text,
  recorded_at                   timestamptz NOT NULL DEFAULT now(),
  recorded_by                   text NOT NULL CHECK (btrim(recorded_by) <> ''),
  UNIQUE (id, input_sha256),
  UNIQUE (policy_bundle_id, client_policy_snapshot_id, input_sha256),
  FOREIGN KEY (policy_bundle_id, policy_bundle_sha256)
    REFERENCES public.autonomy_policy_bundles(id, bundle_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (client_policy_snapshot_id, client_entity_id, policy_bundle_id, client_policy_snapshot_sha256)
    REFERENCES public.client_policy_snapshots(id, client_entity_id, policy_bundle_id, snapshot_sha256) ON DELETE RESTRICT,
  CHECK (normalized_input_json->'client'->>'clientEntityId' = client_entity_id::text),
  CHECK (normalized_input_json->'action'->>'actionType' = action_type),
  CHECK (normalized_input_json->'action'->>'fingerprintVersion' = action_fingerprint_version),
  CHECK (normalized_input_json->'action'->>'claimedActionFingerprint' = claimed_action_fingerprint),
  CHECK (normalized_input_json->'action'->>'computedActionFingerprint' = encode(computed_action_fingerprint, 'hex')),
  CHECK (normalized_input_json->'amount'->>'amountMinor' IS NOT DISTINCT FROM
    CASE WHEN amount_minor IS NULL THEN NULL ELSE amount_minor::text END),
  CHECK (normalized_input_json->'amount'->>'dailyAggregateBeforeMinor' IS NOT DISTINCT FROM
    CASE WHEN daily_aggregate_before_minor IS NULL THEN NULL ELSE daily_aggregate_before_minor::text END)
);

CREATE TABLE public.autonomy_policy_decisions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_key                  bytea NOT NULL CHECK (octet_length(decision_key) = 32),
  policy_bundle_id              uuid NOT NULL,
  policy_bundle_sha256          bytea NOT NULL CHECK (octet_length(policy_bundle_sha256) = 32),
  client_policy_snapshot_id     uuid NOT NULL,
  client_policy_snapshot_sha256 bytea NOT NULL CHECK (octet_length(client_policy_snapshot_sha256) = 32),
  normalized_policy_input_id    uuid NOT NULL,
  input_sha256                  bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
  client_entity_id              uuid NOT NULL,
  action_fingerprint            bytea NOT NULL CHECK (octet_length(action_fingerprint) = 32),
  decision                      text NOT NULL CHECK (decision IN ('ALLOW', 'REVIEW', 'DENY')),
  reason_codes                  text[] NOT NULL CHECK (
    cardinality(reason_codes) > 0 AND public.autonomy_text_array_unique_v1(reason_codes)
  ),
  rule_trace_json               jsonb NOT NULL CHECK (jsonb_typeof(rule_trace_json) = 'array'),
  result_sha256                 bytea NOT NULL CHECK (octet_length(result_sha256) = 32),
  evaluator_version             text NOT NULL CHECK (btrim(evaluator_version) <> ''),
  recorded_at                   timestamptz NOT NULL DEFAULT now(),
  requested_by                  text NOT NULL CHECK (btrim(requested_by) <> ''),
  correlation_id                text,
  UNIQUE (decision_key),
  FOREIGN KEY (policy_bundle_id, policy_bundle_sha256, evaluator_version)
    REFERENCES public.autonomy_policy_bundles(id, bundle_sha256, evaluator_version) ON DELETE RESTRICT,
  FOREIGN KEY (client_policy_snapshot_id, client_entity_id, policy_bundle_id, client_policy_snapshot_sha256)
    REFERENCES public.client_policy_snapshots(id, client_entity_id, policy_bundle_id, snapshot_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (normalized_policy_input_id, input_sha256)
    REFERENCES public.normalized_policy_inputs(id, input_sha256) ON DELETE RESTRICT
);

CREATE INDEX autonomy_policy_decisions_client_recorded_idx
  ON public.autonomy_policy_decisions (client_entity_id, recorded_at DESC);

CREATE TRIGGER autonomy_policy_bundles_immutable
BEFORE UPDATE OR DELETE ON public.autonomy_policy_bundles
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER client_policy_snapshots_immutable
BEFORE UPDATE OR DELETE ON public.client_policy_snapshots
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER normalized_policy_inputs_immutable
BEFORE UPDATE OR DELETE ON public.normalized_policy_inputs
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER autonomy_policy_decisions_immutable
BEFORE UPDATE OR DELETE ON public.autonomy_policy_decisions
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

CREATE OR REPLACE FUNCTION public.publish_autonomy_policy_bundle_v1(
  p_policy_version text,
  p_contract_version text,
  p_canonicalization_version text,
  p_evaluator_version text,
  p_bundle_canonical_json text,
  p_bundle_sha256_hex text,
  p_published_by text,
  p_supersedes_bundle_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_id uuid; v_bundle jsonb;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN RAISE EXCEPTION 'service role required' USING ERRCODE = '42501'; END IF;
  IF extensions.digest(convert_to(p_bundle_canonical_json, 'UTF8'), 'sha256') <>
     public.autonomy_decode_sha256_v1(p_bundle_sha256_hex, 'bundle hash') THEN
    RAISE EXCEPTION 'policy bundle hash mismatch' USING ERRCODE = '23514';
  END IF;
  v_bundle := p_bundle_canonical_json::jsonb;
  INSERT INTO public.autonomy_policy_bundles (
    policy_version, contract_version, canonicalization_version, evaluator_version,
    bundle_json, bundle_sha256, published_by, supersedes_bundle_id
  ) VALUES (
    p_policy_version, p_contract_version, p_canonicalization_version, p_evaluator_version,
    v_bundle, public.autonomy_decode_sha256_v1(p_bundle_sha256_hex, 'bundle hash'),
    p_published_by, p_supersedes_bundle_id
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_client_policy_snapshot_v1(
  p_client_entity_id uuid,
  p_policy_bundle_id uuid,
  p_policy_bundle_sha256_hex text,
  p_snapshot_version bigint,
  p_snapshot_canonical_json text,
  p_snapshot_hash_material_canonical_json text,
  p_snapshot_sha256_hex text,
  p_max_single_action_amount_minor bigint,
  p_max_daily_aggregate_amount_minor bigint,
  p_recorded_by text,
  p_supersedes_snapshot_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_id uuid; v_snapshot jsonb; v_hash_material jsonb;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN RAISE EXCEPTION 'service role required' USING ERRCODE = '42501'; END IF;
  IF extensions.digest(convert_to(p_snapshot_hash_material_canonical_json, 'UTF8'), 'sha256') <>
     public.autonomy_decode_sha256_v1(p_snapshot_sha256_hex, 'snapshot hash') THEN
    RAISE EXCEPTION 'client policy snapshot hash mismatch' USING ERRCODE = '23514';
  END IF;
  v_snapshot := p_snapshot_canonical_json::jsonb;
  v_hash_material := p_snapshot_hash_material_canonical_json::jsonb;
  IF v_hash_material->>'namespace' <> 'step7-client-policy-snapshot-v1'
     OR v_hash_material->>'bundleSha256' <> p_policy_bundle_sha256_hex
     OR v_hash_material->'snapshot' IS DISTINCT FROM v_snapshot THEN
    RAISE EXCEPTION 'client policy snapshot hash material mismatch' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.client_policy_snapshots (
    client_entity_id, policy_bundle_id, policy_bundle_sha256, snapshot_version, snapshot_json,
    snapshot_sha256, max_single_action_amount_minor, max_daily_aggregate_amount_minor,
    supersedes_snapshot_id, recorded_by
  ) VALUES (
    p_client_entity_id, p_policy_bundle_id,
    public.autonomy_decode_sha256_v1(p_policy_bundle_sha256_hex, 'bundle hash'),
    p_snapshot_version, v_snapshot, public.autonomy_decode_sha256_v1(p_snapshot_sha256_hex, 'snapshot hash'),
    p_max_single_action_amount_minor, p_max_daily_aggregate_amount_minor,
    p_supersedes_snapshot_id, p_recorded_by
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_autonomy_policy_decision_v1(
  p_policy_bundle_id uuid,
  p_policy_bundle_sha256_hex text,
  p_client_policy_snapshot_id uuid,
  p_client_policy_snapshot_sha256_hex text,
  p_client_entity_id uuid,
  p_action_type text,
  p_action_fingerprint_version text,
  p_claimed_action_fingerprint_hex text,
  p_computed_action_fingerprint_hex text,
  p_action_snapshot_canonical_json text,
  p_normalized_input_canonical_json text,
  p_normalization_issues_canonical_json text,
  p_input_sha256_hex text,
  p_submitted_payload_sha256_hex text,
  p_amount_minor bigint,
  p_daily_aggregate_before_minor bigint,
  p_currency_code text,
  p_decision_key_hex text,
  p_decision_key_material_canonical_json text,
  p_decision text,
  p_reason_codes text[],
  p_rule_trace_canonical_json text,
  p_result_canonical_json text,
  p_result_sha256_hex text,
  p_evaluator_version text,
  p_requested_by text,
  p_correlation_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_input_id uuid;
  v_decision public.autonomy_policy_decisions%ROWTYPE;
  v_input public.normalized_policy_inputs%ROWTYPE;
  v_bundle public.autonomy_policy_bundles%ROWTYPE;
  v_key_material jsonb;
  v_result jsonb;
  v_reused boolean := false;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN RAISE EXCEPTION 'service role required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO STRICT v_bundle FROM public.autonomy_policy_bundles
  WHERE id = p_policy_bundle_id
    AND bundle_sha256 = public.autonomy_decode_sha256_v1(p_policy_bundle_sha256_hex, 'bundle hash');
  IF extensions.digest(convert_to(p_action_snapshot_canonical_json, 'UTF8'), 'sha256') <>
        public.autonomy_decode_sha256_v1(p_computed_action_fingerprint_hex, 'computed action fingerprint') THEN
    RAISE EXCEPTION 'ACTION_FINGERPRINT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF extensions.digest(convert_to(p_normalized_input_canonical_json, 'UTF8'), 'sha256') <>
     public.autonomy_decode_sha256_v1(p_input_sha256_hex, 'normalized input hash') THEN
    RAISE EXCEPTION 'normalized policy input hash mismatch' USING ERRCODE = '23514';
  END IF;
  v_key_material := p_decision_key_material_canonical_json::jsonb;
  IF extensions.digest(convert_to(p_decision_key_material_canonical_json, 'UTF8'), 'sha256') <>
       public.autonomy_decode_sha256_v1(p_decision_key_hex, 'decision key')
     OR v_key_material->>'namespace' <> 'step7-policy-decision-v1'
     OR v_key_material->>'policyBundleSha256' <> p_policy_bundle_sha256_hex
     OR v_key_material->>'clientPolicySnapshotSha256' <> p_client_policy_snapshot_sha256_hex
     OR v_key_material->>'normalizedInputSha256' <> p_input_sha256_hex
     OR v_key_material->>'computedActionFingerprint' <> p_computed_action_fingerprint_hex THEN
    RAISE EXCEPTION 'decision key material mismatch' USING ERRCODE = '23514';
  END IF;
  v_result := p_result_canonical_json::jsonb;
  IF extensions.digest(convert_to(p_result_canonical_json, 'UTF8'), 'sha256') <>
       public.autonomy_decode_sha256_v1(p_result_sha256_hex, 'result hash')
     OR v_result->>'decision' <> p_decision
     OR v_result->>'actionFingerprint' <> p_computed_action_fingerprint_hex
     OR v_result->>'evaluatorVersion' <> p_evaluator_version
     OR v_result->>'policyVersion' <> v_bundle.policy_version
     OR p_evaluator_version <> v_bundle.evaluator_version
     OR v_result->'reasonCodes' IS DISTINCT FROM to_jsonb(p_reason_codes)
     OR v_result->'ruleTrace' IS DISTINCT FROM p_rule_trace_canonical_json::jsonb THEN
    RAISE EXCEPTION 'policy result hash material mismatch' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.normalized_policy_inputs (
    policy_bundle_id, policy_bundle_sha256, client_policy_snapshot_id,
    client_policy_snapshot_sha256, client_entity_id, action_type,
    action_fingerprint_version, claimed_action_fingerprint, computed_action_fingerprint,
    action_snapshot_json, normalized_input_json, normalization_issues_json,
    input_sha256, submitted_payload_sha256, amount_minor,
    daily_aggregate_before_minor, currency_code, recorded_by
  ) VALUES (
    p_policy_bundle_id, public.autonomy_decode_sha256_v1(p_policy_bundle_sha256_hex, 'bundle hash'),
    p_client_policy_snapshot_id, public.autonomy_decode_sha256_v1(p_client_policy_snapshot_sha256_hex, 'snapshot hash'),
    p_client_entity_id, p_action_type, p_action_fingerprint_version,
    p_claimed_action_fingerprint_hex,
    public.autonomy_decode_sha256_v1(p_computed_action_fingerprint_hex, 'computed action fingerprint'),
    p_action_snapshot_canonical_json::jsonb, p_normalized_input_canonical_json::jsonb,
    p_normalization_issues_canonical_json::jsonb, public.autonomy_decode_sha256_v1(p_input_sha256_hex, 'input hash'),
    public.autonomy_decode_sha256_v1(p_submitted_payload_sha256_hex, 'submitted payload hash'),
    p_amount_minor, p_daily_aggregate_before_minor, p_currency_code, p_requested_by
  ) ON CONFLICT (policy_bundle_id, client_policy_snapshot_id, input_sha256)
    DO NOTHING RETURNING id INTO v_input_id;

  IF v_input_id IS NULL THEN
    SELECT * INTO STRICT v_input FROM public.normalized_policy_inputs
    WHERE policy_bundle_id = p_policy_bundle_id
      AND client_policy_snapshot_id = p_client_policy_snapshot_id
      AND input_sha256 = public.autonomy_decode_sha256_v1(p_input_sha256_hex, 'input hash');
    IF v_input.policy_bundle_id <> p_policy_bundle_id
       OR v_input.client_policy_snapshot_id <> p_client_policy_snapshot_id
       OR v_input.computed_action_fingerprint <> public.autonomy_decode_sha256_v1(p_computed_action_fingerprint_hex, 'action fingerprint')
       OR v_input.normalized_input_json IS DISTINCT FROM p_normalized_input_canonical_json::jsonb THEN
      RAISE EXCEPTION 'DECISION_KEY_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    v_input_id := v_input.id;
  END IF;

  INSERT INTO public.autonomy_policy_decisions (
    decision_key, policy_bundle_id, policy_bundle_sha256, client_policy_snapshot_id,
    client_policy_snapshot_sha256, normalized_policy_input_id, input_sha256,
    client_entity_id, action_fingerprint, decision, reason_codes, rule_trace_json,
    result_sha256, evaluator_version, requested_by, correlation_id
  ) VALUES (
    public.autonomy_decode_sha256_v1(p_decision_key_hex, 'decision key'), p_policy_bundle_id,
    public.autonomy_decode_sha256_v1(p_policy_bundle_sha256_hex, 'bundle hash'), p_client_policy_snapshot_id,
    public.autonomy_decode_sha256_v1(p_client_policy_snapshot_sha256_hex, 'snapshot hash'), v_input_id,
    public.autonomy_decode_sha256_v1(p_input_sha256_hex, 'input hash'), p_client_entity_id,
    public.autonomy_decode_sha256_v1(p_computed_action_fingerprint_hex, 'action fingerprint'),
    p_decision, p_reason_codes, p_rule_trace_canonical_json::jsonb,
    public.autonomy_decode_sha256_v1(p_result_sha256_hex, 'result hash'), p_evaluator_version,
    p_requested_by, p_correlation_id
  ) ON CONFLICT (decision_key) DO NOTHING RETURNING * INTO v_decision;

  IF v_decision.id IS NULL THEN
    v_reused := true;
    SELECT * INTO STRICT v_decision FROM public.autonomy_policy_decisions
    WHERE decision_key = public.autonomy_decode_sha256_v1(p_decision_key_hex, 'decision key');
    IF v_decision.policy_bundle_id <> p_policy_bundle_id
       OR v_decision.client_policy_snapshot_id <> p_client_policy_snapshot_id
       OR v_decision.normalized_policy_input_id <> v_input_id
       OR v_decision.action_fingerprint <> public.autonomy_decode_sha256_v1(p_computed_action_fingerprint_hex, 'action fingerprint')
       OR v_decision.decision <> p_decision
       OR v_decision.reason_codes IS DISTINCT FROM p_reason_codes
       OR v_decision.rule_trace_json IS DISTINCT FROM p_rule_trace_canonical_json::jsonb
       OR v_decision.result_sha256 <> public.autonomy_decode_sha256_v1(p_result_sha256_hex, 'result hash') THEN
      RAISE EXCEPTION 'DECISION_KEY_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'decision_id', v_decision.id,
    'normalized_policy_input_id', v_input_id,
    'decision_key', encode(v_decision.decision_key, 'hex'),
    'decision', v_decision.decision,
    'result_sha256', encode(v_decision.result_sha256, 'hex'),
    'reused', v_reused
  );
END;
$$;

ALTER TABLE public.autonomy_policy_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_policy_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.normalized_policy_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autonomy_policy_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY autonomy_policy_bundles_read ON public.autonomy_policy_bundles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY client_policy_snapshots_read ON public.client_policy_snapshots
  FOR SELECT TO authenticated USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY normalized_policy_inputs_read ON public.normalized_policy_inputs
  FOR SELECT TO authenticated USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY autonomy_policy_decisions_read ON public.autonomy_policy_decisions
  FOR SELECT TO authenticated USING (public.canonical_can_access_client_v1(client_entity_id));

REVOKE ALL PRIVILEGES ON TABLE public.autonomy_policy_bundles, public.client_policy_snapshots,
  public.normalized_policy_inputs, public.autonomy_policy_decisions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.autonomy_policy_bundles, public.client_policy_snapshots,
  public.normalized_policy_inputs, public.autonomy_policy_decisions TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.publish_autonomy_policy_bundle_v1(text,text,text,text,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_client_policy_snapshot_v1(uuid,uuid,text,bigint,text,text,text,bigint,bigint,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_autonomy_policy_decision_v1(uuid,text,uuid,text,uuid,text,text,text,text,text,text,text,text,text,bigint,bigint,text,text,text,text,text[],text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_autonomy_policy_bundle_v1(text,text,text,text,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_client_policy_snapshot_v1(uuid,uuid,text,bigint,text,text,text,bigint,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_autonomy_policy_decision_v1(uuid,text,uuid,text,uuid,text,text,text,text,text,text,text,text,text,bigint,bigint,text,text,text,text,text[],text,text,text,text,text,text) TO service_role;

COMMIT;
