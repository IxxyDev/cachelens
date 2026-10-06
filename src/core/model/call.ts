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
export interface RequestParams {
  readonly model: string;
  readonly toolChoice?: string;
  readonly thinking?: boolean;
  readonly thinkingBudgetTokens?: number;
  readonly speed?: string;
  readonly imagesPresent?: boolean;
  readonly citationsEnabled?: boolean;
}
export interface RequestPayload {
  readonly wireBody: string;
}
export interface Step {
  readonly name: string;
  readonly parentCallId?: string;
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
