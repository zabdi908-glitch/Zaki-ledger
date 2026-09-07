import {
  canonicalizePolicyInput,
  canonicalPolicyJson,
  clientPolicySnapshotSha256,
  policyBundleSha256,
} from "../autonomy-policy-canonicalization";
import type {
  AutonomyPolicyBundle,
  CanonicalPolicyInput,
  ClientPolicySnapshot,
  NormalizedPolicyInput,
} from "../autonomy-policy-contract";
import type { ShadowScope } from "./shadow-contract";

export interface ImmutablePolicyArtifact<T> {
  id: string;
  sha256: string;
  canonicalJson: string;
  value: T;
}

export interface ReadOnlyPolicyArtifactPort {
  loadActiveBundle(clientEntityId: string): Promise<ImmutablePolicyArtifact<AutonomyPolicyBundle> | null>;
  loadCurrentSnapshot(clientEntityId: string): Promise<ImmutablePolicyArtifact<ClientPolicySnapshot> | null>;
}

export interface ShadowPolicyAssemblyRequest extends ShadowScope {
  evaluationAsOf: string;
  priorStageFingerprints: readonly string[];
  normalizedInput: Omit<NormalizedPolicyInput, "evaluationAsOf">;
}

export interface ShadowPolicyAssembly {
  bundle: ImmutablePolicyArtifact<AutonomyPolicyBundle>;
  snapshot: ImmutablePolicyArtifact<ClientPolicySnapshot>;
  canonicalInput: CanonicalPolicyInput;
}

/** Reads existing Step 7 artifacts and assembles facts; it creates no policy or posting object. */
export class ReadOnlyPolicyInputAssembler {
  constructor(private readonly artifacts: ReadOnlyPolicyArtifactPort) {}

  async assemble(request: ShadowPolicyAssemblyRequest): Promise<ShadowPolicyAssembly> {
    const [bundle, snapshot] = await Promise.all([
      this.artifacts.loadActiveBundle(request.clientEntityId),
      this.artifacts.loadCurrentSnapshot(request.clientEntityId),
    ]);
    if (!bundle) throw new Error("POLICY_BUNDLE_MISSING_REVIEW");
    if (!snapshot) throw new Error("CLIENT_POLICY_SNAPSHOT_MISSING_REVIEW");
    if (canonicalPolicyJson(bundle.value) !== bundle.canonicalJson ||
        policyBundleSha256(bundle.value) !== bundle.sha256) {
      throw new Error("POLICY_BUNDLE_INTEGRITY_BLOCKED");
    }
    if (canonicalPolicyJson(snapshot.value) !== snapshot.canonicalJson ||
        clientPolicySnapshotSha256(snapshot.value, bundle.sha256) !== snapshot.sha256) {
      throw new Error("CLIENT_POLICY_SNAPSHOT_INTEGRITY_BLOCKED");
    }
    if (snapshot.value.clientEntityId !== request.clientEntityId ||
        snapshot.value.policyVersion !== bundle.value.policyVersion) {
      throw new Error("POLICY_SCOPE_INTEGRITY_BLOCKED");
    }
    if (request.normalizedInput.client.clientEntityId !== request.clientEntityId ||
        request.normalizedInput.client.ledgerBookId !== request.ledgerBookId) {
      throw new Error("POLICY_INPUT_SCOPE_INTEGRITY_BLOCKED");
    }
    if (request.normalizedInput.action.fingerprintVersion !== "step7-action-fingerprint-v1" ||
        request.normalizedInput.action.step5AuthorizedRequestFingerprint !== null) {
      throw new Error("STEP5_INPUT_PROHIBITED_IN_SHADOW_ASSEMBLY");
    }
    if (!request.priorStageFingerprints.every((value) => /^[0-9a-f]{64}$/.test(value))) {
      throw new Error("POLICY_PROVENANCE_FINGERPRINT_INVALID");
    }
    return {
      bundle, snapshot,
      canonicalInput: canonicalizePolicyInput({
        ...request.normalizedInput,
        evaluationAsOf: request.evaluationAsOf,
      }),
    };
  }
}
