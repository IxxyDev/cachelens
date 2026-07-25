import type { CacheTtl } from "../model/breakpoint.js";
import type { Usage } from "../model/call.js";
import { CACHE_TIER_ORDER, type CacheTier } from "../model/tier.js";
import { type TokenCount, type Usd, usd } from "../model/types.js";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER_1H,
  CACHE_WRITE_MULTIPLIER_5M
} from "./table.js";
import type { ModelPricing } from "./table.js";
const TOKENS_PER_MILLION = 1000000;
function writeMultiplier(pricing: ModelPricing, ttl: CacheTtl): number {
  if (pricing.provider === "openai") {
    return 1;
  }
  return ttl === "1h" ? CACHE_WRITE_MULTIPLIER_1H : CACHE_WRITE_MULTIPLIER_5M;
}
function readMultiplier(pricing: ModelPricing): number {
  return pricing.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER;
}
export function computeCallCost(usage: Usage, pricing: ModelPricing, ttl: CacheTtl): Usd {
  const inputCost = (usage.inputTokens / TOKENS_PER_MILLION) * pricing.inputPricePerMTok;
  const outputCost = (usage.outputTokens / TOKENS_PER_MILLION) * pricing.outputPricePerMTok;
  const cacheWriteCost =
    (usage.cacheCreationInputTokens / TOKENS_PER_MILLION) *
    pricing.inputPricePerMTok *
    writeMultiplier(pricing, ttl);
  const cacheReadCost =
    (usage.cacheReadInputTokens / TOKENS_PER_MILLION) *
    pricing.inputPricePerMTok *
    readMultiplier(pricing);
  return usd(inputCost + outputCost + cacheWriteCost + cacheReadCost);
}
export interface TieredCounterfactual {
  readonly wastedUsdByTier: ReadonlyMap<CacheTier, Usd>;
  readonly totalWastedUsd: Usd;
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
  return { wastedUsdByTier, totalWastedUsd };
}
export function computeWastedUsd(
  cacheCreationInputTokens: TokenCount,
  pricing: ModelPricing,
  ttl: CacheTtl
): Usd {
  const extra =
    (cacheCreationInputTokens / TOKENS_PER_MILLION) *
    pricing.inputPricePerMTok *
    (writeMultiplier(pricing, ttl) - readMultiplier(pricing));
  return usd(Math.max(0, extra));
}
