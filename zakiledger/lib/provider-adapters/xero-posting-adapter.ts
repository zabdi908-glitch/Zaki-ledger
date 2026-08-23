import {
  ProviderExecutionNotImplementedError,
  type ProviderPostingAdapter,
} from "./provider-posting-adapter";

/** Non-executing Day-3 boundary stub. It owns no token or network capability. */
export class XeroPostingAdapter implements ProviderPostingAdapter {
  readonly provider = "xero" as const;

  async execute(): Promise<never> {
    throw new ProviderExecutionNotImplementedError(this.provider);
  }
}
