export type Provider = "anthropic" | "openai";
export const DEFAULT_PROVIDER: Provider = "anthropic";
export function resolveProvider(call: {
  readonly provider?: Provider | undefined;
}): Provider {
  return call.provider ?? DEFAULT_PROVIDER;
}
