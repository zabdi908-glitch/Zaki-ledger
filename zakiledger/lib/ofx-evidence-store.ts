import type { ParsedStatement } from "./reconciliation-schema";
import { sha256Hex } from "./financial-identity";
import { getSupabase } from "./supabase";
import { resolveTenantContextForUser } from "./tenant-context";

const OFX_EVIDENCE_BUCKET = "document-evidence";
const OFX_EVIDENCE_VERSION = "ofx-immutable-evidence-v1";

export const MAX_OFX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface RetainedOfxEvidence {
  artifactId: string;
  contentSha256: string;
  contentLength: number;
}

function normalizeStoredSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.startsWith("\\x") ? value.slice(2) : value;
  return /^[0-9a-f]{64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function artifactIdFromRpc(data: unknown): string | null {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object") return null;
  const artifactId = (value as Record<string, unknown>).artifact_id;
  return typeof artifactId === "string" && artifactId.length > 0 ? artifactId : null;
}

/**
 * Retain and register the exact bytes of an OFX/QFX upload before the legacy
 * statement ingestion is allowed to run. Tenant identity is resolved solely
 * from the authenticated user id; callers cannot supply a client id.
 */
export async function retainOfxEvidence(input: {
  userId: string;
  rawBytes: Uint8Array;
  parsed: ParsedStatement;
}): Promise<RetainedOfxEvidence> {
  if (input.rawBytes.byteLength === 0 || input.rawBytes.byteLength > MAX_OFX_UPLOAD_BYTES) {
    throw new Error(`OFX upload must be between 1 and ${MAX_OFX_UPLOAD_BYTES} bytes`);
  }

  const db = getSupabase();
  if (!db) throw new Error("OFX evidence retention unavailable — database not configured");

  const tenant = await resolveTenantContextForUser(input.userId);
  const contentSha256 = sha256Hex(input.rawBytes);
  const contentLength = input.rawBytes.byteLength;
  const objectKey = `${tenant.clientEntityId}/ofx/${contentSha256}-${contentLength}`;
  const storage = db.storage.from(OFX_EVIDENCE_BUCKET);

  // Never overwrite. Whether this creates the object or finds one already at
  // the content-addressed key, the subsequent download is the proof of bytes.
  await storage.upload(objectKey, input.rawBytes, {
    contentType: "application/x-ofx",
    upsert: false,
  });

  const { data: retainedObject, error: downloadError } = await storage.download(objectKey);
  if (downloadError || !retainedObject) {
    throw new Error(`OFX evidence retention verification failed: ${downloadError?.message ?? "object unavailable"}`);
  }
  const retainedBytes = new Uint8Array(await retainedObject.arrayBuffer());
  if (retainedBytes.byteLength !== contentLength || sha256Hex(retainedBytes) !== contentSha256) {
    throw new Error("OFX evidence retention verification failed: stored object hash or length mismatch");
  }

  const metadata = {
    evidenceVersion: OFX_EVIDENCE_VERSION,
    storageBucket: OFX_EVIDENCE_BUCKET,
    storageObjectKey: objectKey,
    // These values are already canonicalized/hashes from the parser. Raw OFX
    // BANKID and ACCTID values are deliberately never persisted here.
    sourceProvider: input.parsed.sourceProvider ?? "ofx",
    sourceAccountIdentityHash: input.parsed.sourceAccountId ?? null,
    currency: input.parsed.currency,
    statementStart: input.parsed.periodStart,
    statementEnd: input.parsed.periodEnd,
  };
  const { data: registration, error: registrationError } = await db.rpc("ingest_import_artifact_v1", {
    p_client_entity_id: tenant.clientEntityId,
    p_artifact_kind: "ofx_statement",
    p_content_sha256_hex: contentSha256,
    p_content_length: contentLength,
    p_metadata: metadata,
    p_actor_kind: "user",
    p_actor_user_id: input.userId,
    p_actor_service: null,
    p_request_id: null,
  });
  if (registrationError) {
    throw new Error(`OFX artifact registration failed: ${registrationError.message}`);
  }
  const artifactId = artifactIdFromRpc(registration);
  if (!artifactId) throw new Error("OFX artifact registration failed: artifact id missing");

  const { data: artifact, error: artifactError } = await db
    .from("import_artifacts")
    .select("id,client_entity_id,artifact_kind,content_sha256,content_length,storage_state,archived_at")
    .eq("id", artifactId)
    .maybeSingle();
  if (artifactError || !artifact) {
    throw new Error(`OFX artifact verification failed: ${artifactError?.message ?? "artifact unavailable"}`);
  }
  if (
    artifact.id !== artifactId ||
    artifact.client_entity_id !== tenant.clientEntityId ||
    artifact.artifact_kind !== "ofx_statement" ||
    normalizeStoredSha256(artifact.content_sha256) !== contentSha256 ||
    Number(artifact.content_length) !== contentLength ||
    artifact.storage_state !== "retained" ||
    artifact.archived_at !== null
  ) {
    throw new Error("OFX artifact verification failed: artifact does not match retained evidence");
  }

  return { artifactId, contentSha256, contentLength };
}
