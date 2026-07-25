import { tokenCount } from "../../core/model/types.js";
import type { CountTokensAdapter } from "../../core/pricing/count-tokens.js";
import type { FetchLike } from "../wrap/anthropic.js";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
export interface AnthropicCountTokensAdapterOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly anthropicVersion?: string;
  readonly fetch?: FetchLike;
}
export function createAnthropicCountTokensAdapter(
  options: AnthropicCountTokensAdapterOptions
): CountTokensAdapter {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  return {
    async countTokens(prefixText) {
      try {
        const response = await fetchImpl(`${baseUrl}${COUNT_TOKENS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": anthropicVersion
          },
          body: JSON.stringify({
            model: options.model,
            messages: [{ role: "user", content: prefixText }]
          })
        });
        if (!response.ok) {
          return undefined;
        }
        const body = await response.json();
        if (body === null || typeof body !== "object") {
          return undefined;
        }
        const inputTokens = (
          body as {
            input_tokens?: unknown;
          }
        ).input_tokens;
        return typeof inputTokens === "number" ? tokenCount(inputTokens) : undefined;
      } catch {
        return undefined;
      }
    }
  };
}
