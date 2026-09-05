import {
  actionFingerprint,
  canonicalizePolicyInput,
  clientPolicySnapshotSha256,
  policyBundleSha256,
} from "../lib/autonomy-policy-canonicalization";
import type {
  ClientPolicySnapshot,
  NormalizedPolicyInput,
  PolicyEvaluationRequest,
} from "../lib/autonomy-policy-contract";
import { STEP7_INITIAL_POLICY_BUNDLE } from "../lib/autonomy-policy-evaluator";

export const CLIENT_ID = "70000000-0000-4000-8000-000000000001";
export const LEDGER_BOOK_ID = "72000000-0000-4000-8000-000000000001";
const actionSnapshot = {
  actionType: "CREATE_BILL",
  clientEntityId: CLIENT_ID,
  ledgerBookId: LEDGER_BOOK_ID,
  destination: { provider: "quickbooks", realmId: "realm-a" },
  amountMinor: 10_000n,
  currencyCode: "USD",
};
const fingerprint = actionFingerprint(actionSnapshot);

export const BASE_INPUT: NormalizedPolicyInput = {
  schemaVersion: "step7-normalized-policy-input-v1",
  client: { clientEntityId: CLIENT_ID, ledgerBookId: LEDGER_BOOK_ID, active: true },
  action: {
    actionType: "CREATE_BILL",
    fingerprintVersion: "step7-action-fingerprint-v1",
    claimedActionFingerprint: fingerprint,
    computedActionFingerprint: fingerprint,
    step5AuthorizedRequestFingerprint: null,
    snapshot: actionSnapshot,
  },
  amount: { amountMinor: 10_000n, currencyCode: "USD", dailyAggregateBeforeMinor: 5_000n, rawSourceDecimal: "100.00" },
  evidence: {
    quality: "STRONG",
    completeness: "COMPLETE",
    facts: [{ evidenceId: "artifact-a", revisionId: "revision-a", sha256: "a".repeat(64), verifiedSha256: "a".repeat(64), clientEntityId: CLIENT_ID, ledgerBookId: LEDGER_BOOK_ID, retained: true, verified: true, provenance: "DETERMINISTIC" }],
  },
  confidence: [{ fact: "vendor", basisPoints: 10_000, provenance: "DETERMINISTIC" }],
  transactionType: "BILL",
  accountTreatment: { certainty: "EXACT", mappingId: "account-map-a", verified: true },
  taxTreatment: { certainty: "EXACT", treatmentId: "tax-a", verified: true },
  reversibility: "COMPENSATING",
  history: { priorVerifiedActions: 3, stablePattern: true, hasCorrectionsOrReversals: false, snapshotSha256: "b".repeat(64) },
  riskFlags: [],
  humanAuthorization: { state: "EXACT", authorizationId: "authorization-a", authorizedActionFingerprint: fingerprint, authorizedClientEntityId: CLIENT_ID, authorizedLedgerBookId: LEDGER_BOOK_ID, authorizedActionType: "CREATE_BILL" },
  profileFacts: { existingVendorMatch: "NOT_APPLICABLE", billArithmeticVerified: true, duplicateCheck: "CLEAR", vendorBindingVerified: true },
  evaluationAsOf: "2026-09-05T12:00:00.000Z",
  modelProposedPermission: null,
};

export const BASE_SNAPSHOT: ClientPolicySnapshot = {
  snapshotVersion: 1,
  clientEntityId: CLIENT_ID,
  policyVersion: "step7-initial-profiles-v1",
  enabledProfiles: ["ADOPT_EXISTING_VENDOR", "CREATE_VENDOR", "CREATE_BILL"],
  maxSingleActionAmountMinor: 100_000n,
  maxDailyAggregateAmountMinor: 500_000n,
  requireHumanAuthorizationFor: ["ADOPT_EXISTING_VENDOR", "CREATE_VENDOR", "CREATE_BILL"],
  suspended: false,
};

export function requestFor(
  input: NormalizedPolicyInput = BASE_INPUT,
  snapshot: ClientPolicySnapshot = BASE_SNAPSHOT,
): PolicyEvaluationRequest {
  const bundleSha256 = policyBundleSha256(STEP7_INITIAL_POLICY_BUNDLE);
  return {
    bundle: STEP7_INITIAL_POLICY_BUNDLE,
    bundleSha256,
    clientSnapshot: snapshot,
    clientSnapshotSha256: clientPolicySnapshotSha256(snapshot, bundleSha256),
    canonicalInput: canonicalizePolicyInput(input),
  };
}

export function withAction(
  actionType: string,
  transactionType: string,
  changes: Partial<NormalizedPolicyInput> = {},
): NormalizedPolicyInput {
  const snapshot = { actionType, clientEntityId: CLIENT_ID, ledgerBookId: LEDGER_BOOK_ID, destination: { provider: "quickbooks", realmId: "realm-a" } };
  const actionHash = actionFingerprint(snapshot);
  return {
    ...BASE_INPUT,
    ...changes,
    action: {
      actionType,
      fingerprintVersion: "step7-action-fingerprint-v1",
      claimedActionFingerprint: actionHash,
      computedActionFingerprint: actionHash,
      step5AuthorizedRequestFingerprint: null,
      snapshot,
    },
    transactionType,
    humanAuthorization: { state: "EXACT", authorizationId: "authorization-a", authorizedActionFingerprint: actionHash, authorizedClientEntityId: CLIENT_ID, authorizedLedgerBookId: LEDGER_BOOK_ID, authorizedActionType: actionType },
  };
}
