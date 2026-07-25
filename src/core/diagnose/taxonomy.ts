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
  readonly wastedUsd: Usd;
  readonly wastedUsdByTier: ReadonlyMap<CacheTier, Usd>;
  readonly recommendation: string;
  readonly corroboration?: Corroboration;
}
