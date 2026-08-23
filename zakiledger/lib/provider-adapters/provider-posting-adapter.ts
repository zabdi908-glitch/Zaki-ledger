import type { PostingProvider } from "../posting-contract";

/**
 * The only interface permitted to hold provider financial-mutation capability.
 * Provider implementations receive execution grants created by the
 * authoritative service after durable dispatch preparation. General routes
 * and services never receive transport credentials or this capability.
 */
export interface ProviderPostingAdapter {
  readonly provider: PostingProvider;
}

export interface SanitizedProviderFailure {
  classification: "VALIDATION_REJECTION" | "BEFORE_DELIVERY" | "UNCERTAIN_DELIVERY";
  code: string;
  /** Deliberately bounded and scrubbed; never a raw response body. */
  summary: string;
}

export class ProviderExecutionNotImplementedError extends Error {
  constructor(provider: PostingProvider) {
    super(`${provider} financial posting is not implemented.`);
    this.name = "ProviderExecutionNotImplementedError";
  }
}
