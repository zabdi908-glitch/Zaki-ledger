import type { ImmutableReference, ShadowScope } from "./shadow-contract";
import { fingerprintSortedManifest, shadowSha256 } from "./shadow-canonicalization";

export interface CanonicalObservationCommand {
  sourceLocator: string;
  root: Record<string, unknown>;
  revision: Record<string, unknown>;
  identityClaims: readonly Record<string, unknown>[];
  eventRevision: Record<string, unknown>;
  occurrence: Record<string, unknown>;
}

export interface ExtractionCanonicalInput extends ShadowScope {
  artifact: ImmutableReference & { namespace: "import_artifact" };
  extraction: ImmutableReference & { namespace: "shadow_extraction_run" };
  parserName: string;
  parserVersion: string;
  observations: readonly CanonicalObservationCommand[];
}

export interface CanonicalDomainPort {
  startImport(input: {
    clientEntityId: string; artifactId: string; idempotencyKey: string;
    requestFingerprint: string; parserName: string; parserVersion: string;
  }): Promise<{ runId: string }>;
  ingestObservation(input: CanonicalObservationCommand & { clientEntityId: string }): Promise<{
    observationId: string; revisionId: string; eventId: string;
  }>;
  recordOccurrence(input: {
    clientEntityId: string; observationId: string; importRunId: string;
    artifactId: string; occurrence: Record<string, unknown>;
  }): Promise<{ occurrenceId: string }>;
}

export interface CanonicalAdapterResult {
  importRunId: string;
  members: readonly {
    sourceLocator: string; observationId: string; revisionId: string;
    eventId: string; occurrenceId: string;
  }[];
  outputFingerprint: string;
}

/** Typed mapping only; all canonical identity/idempotency remains owned by Step 3 RPCs. */
export class ExtractionToCanonicalAdapter {
  constructor(private readonly canonical: CanonicalDomainPort) {}

  async apply(input: ExtractionCanonicalInput): Promise<CanonicalAdapterResult> {
    const locators = new Set(input.observations.map((item) => item.sourceLocator));
    if (locators.size !== input.observations.length || locators.has("")) {
      throw new Error("CANONICAL_SOURCE_LOCATOR_CONFLICT");
    }
    const requestFingerprint = shadowSha256({ namespace: "step9-canonical-adapter-input-v1", input });
    const started = await this.canonical.startImport({
      clientEntityId: input.clientEntityId, artifactId: input.artifact.id,
      idempotencyKey: requestFingerprint, requestFingerprint,
      parserName: input.parserName, parserVersion: input.parserVersion,
    });
    const members = [];
    for (const command of [...input.observations].sort((a, b) => a.sourceLocator.localeCompare(b.sourceLocator))) {
      if (command.identityClaims.length === 0) throw new Error("CANONICAL_MAPPING_REVIEW_REQUIRED");
      const observed = await this.canonical.ingestObservation({ ...command, clientEntityId: input.clientEntityId });
      const occurrence = await this.canonical.recordOccurrence({
        clientEntityId: input.clientEntityId, observationId: observed.observationId,
        importRunId: started.runId, artifactId: input.artifact.id, occurrence: command.occurrence,
      });
      members.push({ sourceLocator: command.sourceLocator, ...observed, occurrenceId: occurrence.occurrenceId });
    }
    return {
      importRunId: started.runId, members,
      outputFingerprint: fingerprintSortedManifest("step9-canonical-adapter-output-v1", members, (item) => item.sourceLocator),
    };
  }
}
