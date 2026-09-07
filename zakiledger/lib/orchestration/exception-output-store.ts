import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImmutableReference, ShadowScope, ShadowStage } from "./shadow-contract";
import { canonicalShadowJson, shadowSha256 } from "./shadow-canonicalization";

export interface ShadowExceptionInput extends ShadowScope {
  runId: string;
  stage: ShadowStage;
  subjectNamespace: string;
  subjectId: string;
  reasonCode: string;
  evidence: readonly ImmutableReference[];
  diagnostics: Record<string, unknown>;
  correlationId: string;
}

export interface ShadowExceptionRecord {
  id: string;
  exceptionKey: string;
  payloadFingerprint: string;
  reused: boolean;
}

export interface ShadowExceptionOutputStore {
  record(input: ShadowExceptionInput): Promise<ShadowExceptionRecord>;
}

const SENSITIVE_KEY = /(secret|token|password|authorization|cookie|private.?key|access.?key|raw|payload|document|transaction|account.?number|routing|iban)/i;

function assertSanitized(value: unknown, path = "diagnostics"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((item, index) => assertSanitized(item, `${path}/${index}`));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`SENSITIVE_EXCEPTION_FIELD:${path}/${key}`);
    assertSanitized(child, `${path}/${key}`);
  }
}

export function prepareShadowException(input: ShadowExceptionInput) {
  assertSanitized(input.diagnostics);
  const evidenceFingerprint = shadowSha256({ namespace: "step9-exception-evidence-v1", evidence: input.evidence });
  const exceptionKey = shadowSha256({
    namespace: "step9-shadow-exception-key-v1", runId: input.runId, stage: input.stage,
    subjectNamespace: input.subjectNamespace, subjectId: input.subjectId,
    reasonCode: input.reasonCode, evidenceFingerprint,
  });
  const payload = {
    schemaVersion: "step9-shadow-exception-v1", reasonCode: input.reasonCode,
    subjectNamespace: input.subjectNamespace, subjectId: input.subjectId,
    evidence: input.evidence, diagnostics: input.diagnostics,
  };
  return {
    exceptionKey, evidenceFingerprint, payload,
    payloadCanonicalJson: canonicalShadowJson(payload),
    payloadFingerprint: shadowSha256(payload),
  };
}

export class SupabaseShadowExceptionOutputStore implements ShadowExceptionOutputStore {
  constructor(private readonly db: SupabaseClient) {}

  async record(input: ShadowExceptionInput): Promise<ShadowExceptionRecord> {
    const prepared = prepareShadowException(input);
    const { data, error } = await this.db.rpc("record_shadow_exception_v1", {
      p_run_id: input.runId, p_practice_id: input.practiceId,
      p_client_entity_id: input.clientEntityId, p_ledger_book_id: input.ledgerBookId,
      p_stage: input.stage, p_exception_key_hex: prepared.exceptionKey,
      p_subject_namespace: input.subjectNamespace, p_subject_id: input.subjectId,
      p_reason_code: input.reasonCode, p_evidence_fingerprint_hex: prepared.evidenceFingerprint,
      p_payload_canonical_json: prepared.payloadCanonicalJson,
      p_payload_fingerprint_hex: prepared.payloadFingerprint, p_correlation_id: input.correlationId,
    });
    if (error) throw new Error(`SHADOW_EXCEPTION_RECORD_FAILED:${error.message}`);
    const value = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!value) throw new Error("SHADOW_EXCEPTION_RETURNED_NO_ROW");
    return {
      id: String(value.exception_id), exceptionKey: prepared.exceptionKey,
      payloadFingerprint: prepared.payloadFingerprint, reused: value.reused === true,
    };
  }
}
