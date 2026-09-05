import { createHash } from "node:crypto";
import type {
  AutonomyPolicyBundle,
  CanonicalPolicyInput,
  ClientPolicySnapshot,
  NormalizationIssue,
  NormalizedPolicyInput,
  PolicyEvaluationResult,
} from "./autonomy-policy-contract";

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const ascii = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function escapeString(value: string): string {
  return JSON.stringify(value.normalize("NFC"));
}

/** Frozen step7-canonical-json-v1 serializer. Bigints become unquoted JSON integer tokens. */
export function canonicalPolicyJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return escapeString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical policy numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map((key) => `${escapeString(key)}:${canonicalPolicyJson(object[key])}`).join(",")}}`;
  }
  throw new Error(`Unsupported canonical policy value: ${typeof value}`);
}

export function policySha256(value: unknown): string {
  return canonicalPolicyJsonSha256(canonicalPolicyJson(value));
}

export function canonicalPolicyJsonSha256(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

export function actionFingerprint(actionSnapshot: Record<string, unknown>): string {
  return policySha256(actionSnapshot);
}

const allowedKeys = new Map<string, readonly string[]>([
  ["", ["schemaVersion", "client", "action", "amount", "evidence", "confidence", "transactionType", "accountTreatment", "taxTreatment", "reversibility", "history", "riskFlags", "humanAuthorization", "profileFacts", "evaluationAsOf", "modelProposedPermission"]],
  ["/client", ["clientEntityId", "ledgerBookId", "active"]],
  ["/action", ["actionType", "fingerprintVersion", "claimedActionFingerprint", "computedActionFingerprint", "step5AuthorizedRequestFingerprint", "snapshot"]],
  ["/amount", ["amountMinor", "currencyCode", "dailyAggregateBeforeMinor", "rawSourceDecimal"]],
  ["/evidence", ["quality", "completeness", "facts"]],
  ["/evidence/facts/*", ["evidenceId", "revisionId", "sha256", "verifiedSha256", "clientEntityId", "ledgerBookId", "retained", "verified", "provenance"]],
  ["/confidence/*", ["fact", "basisPoints", "provenance"]],
  ["/accountTreatment", ["certainty", "mappingId", "verified"]],
  ["/taxTreatment", ["certainty", "treatmentId", "verified"]],
  ["/history", ["priorVerifiedActions", "stablePattern", "hasCorrectionsOrReversals", "snapshotSha256"]],
  ["/riskFlags/*", ["code", "severity", "evidenceSha256"]],
  ["/humanAuthorization", ["state", "authorizationId", "authorizedActionFingerprint", "authorizedClientEntityId", "authorizedLedgerBookId", "authorizedActionType"]],
  ["/profileFacts", ["existingVendorMatch", "billArithmeticVerified", "duplicateCheck", "vendorBindingVerified"]],
]);

function issue(code: string, path: string, value: unknown): NormalizationIssue {
  let digest: string;
  try { digest = policySha256(value); } catch { digest = policySha256(String(value)); }
  return { code, path, valueDigest: digest };
}

function inspectUnknownKeys(value: unknown, path: string, issues: NormalizationIssue[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const schemaPath = path.replace(/\/\d+(?=\/|$)/g, "/*");
  const allowed = allowedKeys.get(schemaPath);
  if (allowed) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!allowed.includes(key)) issues.push(issue("UNKNOWN_FIELD", `${path}/${key}`, key));
    }
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "snapshot") continue;
    if (Array.isArray(child)) child.forEach((item, index) => inspectUnknownKeys(item, `${path}/${key}/${index}`, issues));
    else inspectUnknownKeys(child, `${path}/${key}`, issues);
  }
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function validateInput(input: NormalizedPolicyInput): NormalizationIssue[] {
  const issues: NormalizationIssue[] = [];
  inspectUnknownKeys(input, "", issues);
  if (input.schemaVersion !== "step7-normalized-policy-input-v1") issues.push(issue("UNKNOWN_SCHEMA_VERSION", "/schemaVersion", input.schemaVersion));
  if (!UUID.test(input.client.clientEntityId)) issues.push(issue("INVALID_UUID", "/client/clientEntityId", input.client.clientEntityId));
  if (!UUID.test(input.client.ledgerBookId)) issues.push(issue("INVALID_UUID", "/client/ledgerBookId", input.client.ledgerBookId));
  if (!oneOf(input.action.fingerprintVersion, ["step7-action-fingerprint-v1", "step5-authorized-request-v1"])) issues.push(issue("UNKNOWN_FINGERPRINT_VERSION", "/action/fingerprintVersion", input.action.fingerprintVersion));
  for (const [path, hash] of [
    ["/action/claimedActionFingerprint", input.action.claimedActionFingerprint],
    ["/action/computedActionFingerprint", input.action.computedActionFingerprint],
    ["/history/snapshotSha256", input.history.snapshotSha256],
  ] as const) if (!HEX.test(hash)) issues.push(issue("INVALID_SHA256", path, hash));
  if (input.action.step5AuthorizedRequestFingerprint !== null && !HEX.test(input.action.step5AuthorizedRequestFingerprint)) issues.push(issue("INVALID_SHA256", "/action/step5AuthorizedRequestFingerprint", input.action.step5AuthorizedRequestFingerprint));
  if (typeof input.amount.amountMinor === "number" || typeof input.amount.dailyAggregateBeforeMinor === "number") issues.push(issue("MONEY_NOT_INTEGER_MINOR_UNITS", "/amount", input.amount));
  if (input.amount.amountMinor !== null && typeof input.amount.amountMinor !== "bigint") issues.push(issue("MONEY_NOT_INTEGER_MINOR_UNITS", "/amount/amountMinor", input.amount.amountMinor));
  if (input.amount.dailyAggregateBeforeMinor !== null && typeof input.amount.dailyAggregateBeforeMinor !== "bigint") issues.push(issue("MONEY_NOT_INTEGER_MINOR_UNITS", "/amount/dailyAggregateBeforeMinor", input.amount.dailyAggregateBeforeMinor));
  if (typeof input.amount.amountMinor === "bigint" && (input.amount.amountMinor < INT64_MIN || input.amount.amountMinor > INT64_MAX)) issues.push(issue("MONEY_OUT_OF_RANGE", "/amount/amountMinor", input.amount.amountMinor));
  if (typeof input.amount.dailyAggregateBeforeMinor === "bigint" && (input.amount.dailyAggregateBeforeMinor < INT64_MIN || input.amount.dailyAggregateBeforeMinor > INT64_MAX)) issues.push(issue("MONEY_OUT_OF_RANGE", "/amount/dailyAggregateBeforeMinor", input.amount.dailyAggregateBeforeMinor));
  if (input.amount.rawSourceDecimal !== null && typeof input.amount.rawSourceDecimal !== "string") issues.push(issue("INVALID_PROVENANCE", "/amount/rawSourceDecimal", input.amount.rawSourceDecimal));
  if (!oneOf(input.evidence.quality, ["STRONG", "ACCEPTABLE", "WEAK", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", "/evidence/quality", input.evidence.quality));
  if (!oneOf(input.evidence.completeness, ["COMPLETE", "INCOMPLETE", "CONFLICTED", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", "/evidence/completeness", input.evidence.completeness));
  if (!oneOf(input.accountTreatment.certainty, ["EXACT", "AMBIGUOUS", "MISSING", "NOT_APPLICABLE", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", "/accountTreatment/certainty", input.accountTreatment.certainty));
  if (!oneOf(input.taxTreatment.certainty, ["EXACT", "AMBIGUOUS", "MISSING", "NOT_APPLICABLE", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", "/taxTreatment/certainty", input.taxTreatment.certainty));
  if (!oneOf(input.reversibility, ["DIRECT", "COMPENSATING", "IRREVERSIBLE", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", "/reversibility", input.reversibility));
  if (!oneOf(input.humanAuthorization.state, ["EXACT", "MISSING", "EXPIRED", "REVOKED", "WRONG_SCOPE", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", "/humanAuthorization/state", input.humanAuthorization.state));
  if (!oneOf(input.profileFacts.existingVendorMatch, ["EXACT_UNIQUE_CURRENT_VERIFIED", "AMBIGUOUS", "MISSING", "NOT_APPLICABLE", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", "/profileFacts/existingVendorMatch", input.profileFacts.existingVendorMatch));
  if (!oneOf(input.profileFacts.duplicateCheck, ["CLEAR", "POSSIBLE_DUPLICATE", "INCOMPLETE", "NOT_APPLICABLE", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", "/profileFacts/duplicateCheck", input.profileFacts.duplicateCheck));
  if (input.modelProposedPermission !== null && !oneOf(input.modelProposedPermission, ["ALLOW", "REVIEW", "DENY"])) issues.push(issue("UNKNOWN_ENUM", "/modelProposedPermission", input.modelProposedPermission));
  if (!RFC3339_UTC.test(input.evaluationAsOf) || Number.isNaN(Date.parse(input.evaluationAsOf))) issues.push(issue("INVALID_EVALUATION_AS_OF", "/evaluationAsOf", input.evaluationAsOf));
  for (const [index, fact] of input.confidence.entries()) {
    if (!Number.isInteger(fact.basisPoints) || fact.basisPoints < 0 || fact.basisPoints > 10_000) issues.push(issue("INVALID_CONFIDENCE", `/confidence/${index}/basisPoints`, fact.basisPoints));
    if (!oneOf(fact.provenance, ["DETERMINISTIC", "MODEL", "HUMAN_ATTESTED", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", `/confidence/${index}/provenance`, fact.provenance));
  }
  for (const [index, fact] of input.evidence.facts.entries()) {
    if (!HEX.test(fact.sha256)) issues.push(issue("INVALID_SHA256", `/evidence/facts/${index}/sha256`, fact.sha256));
    if (!HEX.test(fact.verifiedSha256)) issues.push(issue("INVALID_SHA256", `/evidence/facts/${index}/verifiedSha256`, fact.verifiedSha256));
    if (!UUID.test(fact.clientEntityId)) issues.push(issue("INVALID_UUID", `/evidence/facts/${index}/clientEntityId`, fact.clientEntityId));
    if (!UUID.test(fact.ledgerBookId)) issues.push(issue("INVALID_UUID", `/evidence/facts/${index}/ledgerBookId`, fact.ledgerBookId));
    if (!oneOf(fact.provenance, ["DETERMINISTIC", "MODEL", "HUMAN_ATTESTED", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", `/evidence/facts/${index}/provenance`, fact.provenance));
  }
  for (const [index, flag] of input.riskFlags.entries()) {
    if (!HEX.test(flag.evidenceSha256)) issues.push(issue("INVALID_SHA256", `/riskFlags/${index}/evidenceSha256`, flag.evidenceSha256));
    if (!oneOf(flag.severity, ["INFO", "REVIEW", "DENY", "UNKNOWN"])) issues.push(issue("UNKNOWN_ENUM", `/riskFlags/${index}/severity`, flag.severity));
  }
  return issues.sort((a, b) => ascii(a.code, b.code) || ascii(a.path, b.path) || ascii(a.valueDigest, b.valueDigest));
}

export function canonicalizePolicyInput(submitted: NormalizedPolicyInput): CanonicalPolicyInput {
  const computed = actionFingerprint(submitted.action.snapshot);
  const issues = validateInput(submitted);
  const input: NormalizedPolicyInput = {
    ...submitted,
    action: { ...submitted.action, computedActionFingerprint: computed },
    amount: {
      ...submitted.amount,
      amountMinor: submitted.amount.amountMinor === null || typeof submitted.amount.amountMinor === "bigint" ? submitted.amount.amountMinor : null,
      dailyAggregateBeforeMinor: submitted.amount.dailyAggregateBeforeMinor === null || typeof submitted.amount.dailyAggregateBeforeMinor === "bigint" ? submitted.amount.dailyAggregateBeforeMinor : null,
    },
    evidence: { ...submitted.evidence, facts: [...submitted.evidence.facts].sort((a, b) => ascii(a.evidenceId, b.evidenceId) || ascii(a.revisionId ?? "", b.revisionId ?? "") || ascii(a.sha256, b.sha256)) },
    confidence: [...submitted.confidence].sort((a, b) => ascii(a.fact, b.fact) || ascii(a.provenance, b.provenance)),
    riskFlags: [...submitted.riskFlags].sort((a, b) => ascii(a.code, b.code) || ascii(a.evidenceSha256, b.evidenceSha256)),
  };
  const seen = new Set<string>();
  for (const fact of input.evidence.facts) {
    const key = `${fact.evidenceId}\u0000${fact.revisionId ?? ""}\u0000${fact.sha256}`;
    if (seen.has(key)) issues.push(issue("DUPLICATE_SET_MEMBER", "/evidence/facts", key));
    seen.add(key);
  }
  const riskSeen = new Set<string>();
  for (const flag of input.riskFlags) {
    if (riskSeen.has(flag.code)) issues.push(issue("DUPLICATE_SET_MEMBER", "/riskFlags", flag.code));
    riskSeen.add(flag.code);
  }
  const confidenceSeen = new Set<string>();
  for (const fact of input.confidence) {
    if (confidenceSeen.has(fact.fact)) issues.push(issue("DUPLICATE_SET_MEMBER", "/confidence", fact.fact));
    confidenceSeen.add(fact.fact);
  }
  issues.sort((a, b) => ascii(a.code, b.code) || ascii(a.path, b.path) || ascii(a.valueDigest, b.valueDigest));
  const normalizedInputCanonicalJson = canonicalPolicyJson(input);
  return {
    input,
    issues,
    actionSnapshotCanonicalJson: canonicalPolicyJson(input.action.snapshot),
    normalizedInputCanonicalJson,
    normalizedInputSha256: canonicalPolicyJsonSha256(normalizedInputCanonicalJson),
    submittedPayloadSha256: (() => {
      try { return policySha256(submitted); }
      catch {
        return policySha256({ namespace: "step7-invalid-submitted-payload-v1", normalizedInputCanonicalJson, issues });
      }
    })(),
  };
}

export function policyBundleSha256(bundle: AutonomyPolicyBundle): string {
  return policySha256(bundle);
}

export function clientPolicySnapshotSha256(snapshot: ClientPolicySnapshot, bundleSha256: string): string {
  return policySha256({ namespace: "step7-client-policy-snapshot-v1", bundleSha256, snapshot });
}

export function policyDecisionKey(bundleSha256: string, snapshotSha256: string, input: CanonicalPolicyInput): string {
  return policySha256({
    namespace: "step7-policy-decision-v1",
    policyBundleSha256: bundleSha256,
    clientPolicySnapshotSha256: snapshotSha256,
    normalizedInputSha256: input.normalizedInputSha256,
    computedActionFingerprint: input.input.action.computedActionFingerprint,
  });
}

export function policyResultSha256(result: Omit<PolicyEvaluationResult, "resultSha256">): string {
  return policySha256(result);
}

export function assertLowercaseSha256(value: string, label: string): void {
  if (!HEX.test(value)) throw new Error(`${label} must be lowercase SHA-256 hex`);
}
