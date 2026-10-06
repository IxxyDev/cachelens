import type { CacheTier } from "../model/tier.js";
import type { ByteOffset, TokenCount, Usd } from "../model/types.js";
export type Cause =
  | "ttl-expiry"
  | "tools-tier-drift"
  | "request-param-invalidation"
  | "nondeterministic-serialization"
  | "content-block-churn"
  | "lookback-window-exceeded"
  | "breakpoint-misplacement"
  | "prefix-too-short"
  | "dynamic-prefix-content";
export type CorroborationStatus = "confirmed" | "contradicted" | "unavailable";
export interface Corroboration {
  readonly status: CorroborationStatus;
  readonly note?: string;
}
export interface Diagnosis {
  readonly cause: Cause;
  readonly invalidatedTiers: readonly CacheTier[];
  readonly byteOffset: ByteOffset;
  readonly structuralPath: string;
  readonly excerpt: string;
  readonly wastedTokens: TokenCount;
  /** Null when the model has no pricing entry: the miss is diagnosed, its dollar cost is unknown. */
  readonly wastedUsd: Usd | null;
  /** Null exactly when `wastedUsd` is null. */
  readonly wastedUsdByTier: ReadonlyMap<CacheTier, Usd> | null;
  /**
   * True when `wastedTokens` is an estimate rather than reported usage: OpenAI reports no cache
   * writes, so the stable zone's share of the prompt tokens stands in for them.
   */
  readonly wastedEstimate?: boolean;
  readonly recommendation: string;
  readonly corroboration?: Corroboration;
}
/** A diagnosis with a known price: what every rule produces before the engine sees the model. */
export type PricedDiagnosis = Diagnosis & {
  readonly wastedUsd: Usd;
  readonly wastedUsdByTier: ReadonlyMap<CacheTier, Usd>;
};
