import { locateBreakpoints } from "../breakpoints/locate.js";
import type { CacheBreakpoint, CacheTtl } from "../model/breakpoint.js";
import type { LlmCall, Usage } from "../model/call.js";
import { CACHE_TIER_ORDER, type CacheTier } from "../model/tier.js";
import { type TokenCount, type Usd, usd } from "../model/types.js";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import type { ModelPricing } from "./table.js";

const TOKENS_PER_MILLION = 1000000;
function ttlWriteMultiplier(pricing: ModelPricing, ttl: CacheTtl): number {
  return ttl === "1h" ? pricing.cacheWrite1hMultiplier : pricing.cacheWrite5mMultiplier;
}
/** The TTL a request's cache writes are billed at: 1h only when every breakpoint asks for 1h. */
export function writeTtlFromBreakpoints(breakpoints: readonly CacheBreakpoint[]): CacheTtl {
  return breakpoints.length > 0 && breakpoints.every((bp) => bp.ttl === "1h") ? "1h" : "5m";
}
/** `writeTtlFromBreakpoints` for a recorded call; an unparseable wire body falls back to 5m. */
export function declaredWriteTtl(call: LlmCall): CacheTtl {
  try {
    const canonical = buildCanonicalRequest(call.payload.wireBody);
    return writeTtlFromBreakpoints(locateBreakpoints(call.payload.wireBody, canonical.segments));
  } catch {
    return "5m";
  }
}
export interface CacheWriteSplit {
  readonly tokens5m: number;
  readonly tokens1h: number;
}
/**
 * How the call's cache-creation tokens divide between the 5m and 1h write prices: the API's own
 * `cache_creation.ephemeral_5m/1h_input_tokens` split when captured, else all at `fallbackTtl`.
 */
export function cacheWriteSplit(usage: Usage, fallbackTtl: CacheTtl): CacheWriteSplit {
  const { cacheCreation5mInputTokens: reported5m, cacheCreation1hInputTokens: reported1h } = usage;
  if (reported5m !== undefined || reported1h !== undefined) {
    const tokens1h = reported1h ?? 0;
    const tokens5m = reported5m ?? Math.max(0, usage.cacheCreationInputTokens - tokens1h);
    return { tokens5m, tokens1h };
  }
  return fallbackTtl === "1h"
    ? { tokens5m: 0, tokens1h: usage.cacheCreationInputTokens }
    : { tokens5m: usage.cacheCreationInputTokens, tokens1h: 0 };
}
/**
 * Blended cache-write price multiplier for this usage (token-weighted over the 5m/1h split).
 * With no written tokens it is the multiplier of `fallbackTtl`.
 */
export function effectiveWriteMultiplier(
  usage: Usage,
  pricing: ModelPricing,
  fallbackTtl: CacheTtl
): number {
  const { tokens5m, tokens1h } = cacheWriteSplit(usage, fallbackTtl);
  const total = tokens5m + tokens1h;
  if (total === 0) {
    return ttlWriteMultiplier(pricing, fallbackTtl);
  }
  return (
    (tokens5m * pricing.cacheWrite5mMultiplier + tokens1h * pricing.cacheWrite1hMultiplier) / total
  );
}
/** The call's blended write multiplier, with the TTL fallback taken from its own breakpoints. */
export function writeMultiplierFor(call: LlmCall, pricing: ModelPricing): number {
  return effectiveWriteMultiplier(call.usage, pricing, declaredWriteTtl(call));
}
/**
 * Cost of one call. `ttl` is only the fallback for calls whose usage carries no 5m/1h split;
 * pass `declaredWriteTtl(call)` for a recorded call.
 */
export function computeCallCost(usage: Usage, pricing: ModelPricing, ttl: CacheTtl): Usd {
  const { tokens5m, tokens1h } = cacheWriteSplit(usage, ttl);
  const inputCost = (usage.inputTokens / TOKENS_PER_MILLION) * pricing.inputPricePerMTok;
  const outputCost = (usage.outputTokens / TOKENS_PER_MILLION) * pricing.outputPricePerMTok;
  const cacheWriteCost =
    (pricing.inputPricePerMTok / TOKENS_PER_MILLION) *
    (tokens5m * pricing.cacheWrite5mMultiplier + tokens1h * pricing.cacheWrite1hMultiplier);
  const cacheReadCost =
    (usage.cacheReadInputTokens / TOKENS_PER_MILLION) *
    pricing.inputPricePerMTok *
    pricing.cacheReadMultiplier;
  return usd(inputCost + outputCost + cacheWriteCost + cacheReadCost);
}
export interface TieredCounterfactual {
  readonly wastedUsdByTier: ReadonlyMap<CacheTier, Usd>;
  readonly totalWastedUsd: Usd;
}
/** Splits a total waste across the invalidated tiers proportionally to their byte lengths. */
export function splitWastedUsdByTier(
  invalidatedTiers: readonly CacheTier[],
  tierByteLengths: Readonly<Record<CacheTier, number>>,
  totalWastedUsd: Usd
): ReadonlyMap<CacheTier, Usd> {
  const totalInvalidatedBytes = invalidatedTiers.reduce(
    (sum, tier) => sum + tierByteLengths[tier],
    0
  );
  const wastedUsdByTier = new Map<CacheTier, Usd>();
  for (const tier of CACHE_TIER_ORDER) {
    const isInvalidated = invalidatedTiers.includes(tier);
    if (!isInvalidated || totalInvalidatedBytes === 0) {
      wastedUsdByTier.set(tier, usd(0));
      continue;
    }
    const share = tierByteLengths[tier] / totalInvalidatedBytes;
    wastedUsdByTier.set(tier, usd(totalWastedUsd * share));
  }
  return wastedUsdByTier;
}
export function computeTieredCounterfactual(params: {
  readonly invalidatedTiers: readonly CacheTier[];
  readonly tierByteLengths: Readonly<Record<CacheTier, number>>;
  readonly cacheCreationInputTokens: TokenCount;
  readonly pricing: ModelPricing;
  readonly ttl: CacheTtl;
}): TieredCounterfactual {
  const { invalidatedTiers, tierByteLengths, cacheCreationInputTokens, pricing, ttl } = params;
  const totalWastedUsd = computeWastedUsd(cacheCreationInputTokens, pricing, ttl);
  return {
    wastedUsdByTier: splitWastedUsdByTier(invalidatedTiers, tierByteLengths, totalWastedUsd),
    totalWastedUsd
  };
}
/**
 * Extra cost of paying `writeMultiplier` (a cache write, or 1x for an uncached OpenAI read)
 * instead of the cache-read price for `tokens`.
 */
export function wastedUsdAtMultiplier(
  tokens: number,
  pricing: ModelPricing,
  writeMultiplier: number
): Usd {
  const extra =
    (tokens / TOKENS_PER_MILLION) *
    pricing.inputPricePerMTok *
    (writeMultiplier - pricing.cacheReadMultiplier);
  return usd(Math.max(0, extra));
}
export function computeWastedUsd(
  cacheCreationInputTokens: TokenCount,
  pricing: ModelPricing,
  ttl: CacheTtl
): Usd {
  return wastedUsdAtMultiplier(cacheCreationInputTokens, pricing, ttlWriteMultiplier(pricing, ttl));
}
