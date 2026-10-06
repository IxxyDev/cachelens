import type { Provider } from "./provider.js";
import type { TokenCount } from "./types.js";
export interface Usage {
  readonly inputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly cacheCreationInputTokens: TokenCount;
  readonly cacheReadInputTokens: TokenCount;
  /** Anthropic `usage.cache_creation.ephemeral_5m_input_tokens`, when reported. */
  readonly cacheCreation5mInputTokens?: TokenCount;
  /** Anthropic `usage.cache_creation.ephemeral_1h_input_tokens`, when reported. */
  readonly cacheCreation1hInputTokens?: TokenCount;
}
export type ThinkingType = "adaptive" | "enabled" | "disabled";
export interface ThinkingParams {
  readonly type: ThinkingType;
  readonly budgetTokens?: number;
}
export interface RequestParams {
  readonly model: string;
  readonly toolChoice?: string;
  readonly thinking?: ThinkingParams;
  /** `output_config.effort`. */
  readonly effort?: string;
  /** Stable (sorted-key) JSON of `context_management`. */
  readonly contextManagement?: string;
  readonly inferenceGeo?: string;
  readonly speed?: string;
  readonly imagesPresent?: boolean;
  readonly citationsEnabled?: boolean;
  /** A server `web_search` tool is present in `tools`. */
  readonly webSearchEnabled?: boolean;
}
export interface RequestPayload {
  readonly wireBody: string;
}
export interface LlmCall {
  readonly id: string;
  readonly sessionId: string;
  readonly stepName: string;
  readonly parentCallId?: string;
  readonly timestamp: number;
  readonly params: RequestParams;
  readonly payload: RequestPayload;
  readonly usage: Usage;
  readonly durationMs?: number;
  readonly provider?: Provider;
}
