import type { ImmutableReference, ShadowScope } from "./shadow-contract";
import { canonicalShadowJson, shadowSha256 } from "./shadow-canonicalization";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ShadowExtractionRequest extends ShadowScope {
  runId: string;
  stageId: string;
  attemptId: string;
  workerId: string;
  artifact: ImmutableReference & { namespace: "import_artifact" };
  artifactLength: number;
  extractorName: string;
  extractorVersion: string;
  modelConfigurationFingerprint: string;
  promptFingerprint: string;
  hintsFingerprint: string | null;
}

export class SupabaseShadowExtractionPersistence implements ShadowExtractionPersistence {
  constructor(private readonly db: SupabaseClient) {}

  async find(extractionKey: string): Promise<ShadowExtractionResult | null> {
    const { data, error } = await this.db.from("shadow_extraction_runs")
      .select("id,extraction_key,output_fingerprint,output_canonical_json")
      .eq("extraction_key", extractionKey).maybeSingle();
    if (error) throw new Error(`SHADOW_EXTRACTION_LOOKUP_FAILED:${error.message}`);
    if (!data) return null;
    return {
      extractionRunId: String(data.id), extractionKey,
      outputFingerprint: String(data.output_fingerprint),
      outputCanonicalJson: String(data.output_canonical_json), reused: true,
    };
  }

  async record(input: ShadowExtractionResult & {
    request: ShadowExtractionRequest; inputFingerprint: string; fencingToken: bigint;
  }): Promise<ShadowExtractionResult> {
    const { request } = input;
    const { data, error } = await this.db.rpc("record_shadow_extraction_result_v1", {
      p_run_id: request.runId, p_stage_id: request.stageId, p_attempt_id: request.attemptId,
      p_import_artifact_id: request.artifact.id, p_extraction_key_hex: input.extractionKey,
      p_input_fingerprint_hex: input.inputFingerprint, p_extractor_name: request.extractorName,
      p_extractor_version: request.extractorVersion, p_output_canonical_json: input.outputCanonicalJson,
      p_output_fingerprint_hex: input.outputFingerprint, p_worker_id: request.workerId,
      p_fencing_token: input.fencingToken.toString(10),
    });
    if (error) throw new Error(`SHADOW_EXTRACTION_RECORD_FAILED:${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row) throw new Error("SHADOW_EXTRACTION_RETURNED_NO_ROW");
    return { ...input, extractionRunId: String(row.extraction_run_id), reused: row.reused === true };
  }
}

export interface ShadowExtractionResult {
  extractionRunId: string;
  extractionKey: string;
  outputFingerprint: string;
  outputCanonicalJson: string;
  reused: boolean;
}

export interface ShadowExtractionPersistence {
  find(extractionKey: string): Promise<ShadowExtractionResult | null>;
  record(input: ShadowExtractionResult & {
    request: ShadowExtractionRequest;
    inputFingerprint: string;
    fencingToken: bigint;
  }): Promise<ShadowExtractionResult>;
}

export interface ShadowArtifactIntegrityPort {
  verify(input: Pick<ShadowExtractionRequest,
    "practiceId" | "clientEntityId" | "ledgerBookId" | "artifact" | "artifactLength"
  >): Promise<boolean>;
}

export type ShadowExtractor<T> = (request: ShadowExtractionRequest) => Promise<T>;

/** Model-backed work is invoked only when an exact committed extraction is absent. */
export class ShadowExtractionRunService {
  constructor(
    private readonly persistence: ShadowExtractionPersistence,
    private readonly artifactIntegrity: ShadowArtifactIntegrityPort,
  ) {}

  async execute<T>(
    request: ShadowExtractionRequest,
    fencingToken: bigint,
    extractor: ShadowExtractor<T>,
  ): Promise<ShadowExtractionResult> {
    if (!Number.isSafeInteger(request.artifactLength) || request.artifactLength < 0) {
      throw new Error("INVALID_ARTIFACT_LENGTH");
    }
    if (!await this.artifactIntegrity.verify(request)) {
      throw new Error("EXTRACTION_ARTIFACT_SCOPE_OR_HASH_INTEGRITY_BLOCKED");
    }
    const inputFingerprint = shadowSha256({
      namespace: "step9-shadow-extraction-input-v1",
      practiceId: request.practiceId, clientEntityId: request.clientEntityId,
      ledgerBookId: request.ledgerBookId, artifact: request.artifact,
      artifactLength: request.artifactLength, extractorName: request.extractorName,
      extractorVersion: request.extractorVersion,
      modelConfigurationFingerprint: request.modelConfigurationFingerprint,
      promptFingerprint: request.promptFingerprint, hintsFingerprint: request.hintsFingerprint,
    });
    const extractionKey = shadowSha256({
      namespace: "step9-shadow-extraction-key-v1",
      clientEntityId: request.clientEntityId,
      ledgerBookId: request.ledgerBookId,
      artifactId: request.artifact.id,
      artifactFingerprint: request.artifact.fingerprint,
      artifactLength: request.artifactLength,
      extractorName: request.extractorName,
      extractorVersion: request.extractorVersion,
      modelConfigurationFingerprint: request.modelConfigurationFingerprint,
      promptFingerprint: request.promptFingerprint,
      hintsFingerprint: request.hintsFingerprint,
    });
    const existing = await this.persistence.find(extractionKey);
    if (existing) return { ...existing, reused: true };

    const output = await extractor(request);
    const outputCanonicalJson = canonicalShadowJson(output);
    const outputFingerprint = shadowSha256({
      namespace: "step9-shadow-extraction-output-v1", extractionKey, output,
    });
    return this.persistence.record({
      request, inputFingerprint, extractionKey, outputFingerprint, outputCanonicalJson,
      extractionRunId: "", reused: false, fencingToken,
    });
  }
}
