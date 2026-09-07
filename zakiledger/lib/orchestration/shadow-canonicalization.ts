import { createHash } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("NON_FINITE_NUMBER_NOT_CANONICAL");
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error(`UNDEFINED_NOT_CANONICAL:${key}`);
      result[key] = normalize(item);
    }
    return result;
  }
  throw new Error(`UNSUPPORTED_CANONICAL_TYPE:${typeof value}`);
}

export function canonicalShadowJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function shadowSha256(value: unknown): string {
  return createHash("sha256").update(canonicalShadowJson(value), "utf8").digest("hex");
}

export function assertSha256(value: string, label = "fingerprint"): void {
  if (!SHA256.test(value)) throw new Error(`INVALID_SHA256:${label}`);
}

export function fingerprintShadowRun(value: {
  contractVersion: string;
  practiceId: string;
  clientEntityId: string;
  ledgerBookId: string;
  scheduleKey: string;
  requestedFor: string;
  mode: "SHADOW";
  executionPermitted: false;
}): string {
  const { contractVersion, practiceId, clientEntityId, ledgerBookId, scheduleKey,
    requestedFor, mode, executionPermitted } = value;
  return shadowSha256({ namespace: "step9-shadow-run-v1", contractVersion, practiceId,
    clientEntityId, ledgerBookId, scheduleKey, requestedFor, mode, executionPermitted });
}

export function fingerprintStageInput(stage: string, dependencyFingerprint: string | null, input: unknown): string {
  if (dependencyFingerprint !== null) assertSha256(dependencyFingerprint, "dependencyFingerprint");
  return shadowSha256({ namespace: "step9-shadow-stage-input-v1", stage, dependencyFingerprint, input });
}

export function fingerprintStageOutput(stage: string, output: unknown, provenance: unknown): string {
  return shadowSha256({ namespace: "step9-shadow-stage-output-v1", stage, output, provenance });
}

export function fingerprintSortedManifest<T>(namespace: string, values: readonly T[], key: (value: T) => string): string {
  const keyed = values.map((value) => ({ key: key(value), value }));
  const unique = new Set(keyed.map((item) => item.key));
  if (unique.size !== keyed.length) throw new Error("DUPLICATE_MANIFEST_IDENTITY");
  keyed.sort((left, right) => left.key.localeCompare(right.key));
  return shadowSha256({ namespace, members: keyed });
}
