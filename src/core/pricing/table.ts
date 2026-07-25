import type { Provider } from "../model/provider.js";
import { type TokenCount, type Usd, tokenCount, usd } from "../model/types.js";
export const CACHE_WRITE_MULTIPLIER_5M = 1.25;
export const CACHE_WRITE_MULTIPLIER_1H = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;
export interface ModelPricing {
  readonly model: string;
  readonly provider: Provider;
  readonly inputPricePerMTok: Usd;
  readonly outputPricePerMTok: Usd;
  readonly minCacheableTokens: TokenCount;
  readonly cacheReadMultiplier?: number;
}
export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`No pricing entry for model "${model}". Add it to core/pricing/table.ts.`);
    this.name = "UnknownModelError";
  }
}
const PRICING_TABLE: readonly ModelPricing[] = [
  {
    model: "claude-opus-4-8",
    provider: "anthropic",
    inputPricePerMTok: usd(15),
    outputPricePerMTok: usd(75),
    minCacheableTokens: tokenCount(4096)
  },
  {
    model: "claude-opus-4-5",
    provider: "anthropic",
    inputPricePerMTok: usd(15),
    outputPricePerMTok: usd(75),
    minCacheableTokens: tokenCount(4096)
  },
  {
    model: "claude-haiku-4-5",
    provider: "anthropic",
    inputPricePerMTok: usd(1),
    outputPricePerMTok: usd(5),
    minCacheableTokens: tokenCount(4096)
  },
  {
    model: "claude-fable-5",
    provider: "anthropic",
    inputPricePerMTok: usd(3),
    outputPricePerMTok: usd(15),
    minCacheableTokens: tokenCount(2048)
  },
  {
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    inputPricePerMTok: usd(3),
    outputPricePerMTok: usd(15),
    minCacheableTokens: tokenCount(2048)
  },
  {
    model: "claude-haiku-3-5",
    provider: "anthropic",
    inputPricePerMTok: usd(0.8),
    outputPricePerMTok: usd(4),
    minCacheableTokens: tokenCount(2048)
  },
  {
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inputPricePerMTok: usd(3),
    outputPricePerMTok: usd(15),
    minCacheableTokens: tokenCount(1024)
  },
  {
    model: "gpt-4o",
    provider: "openai",
    inputPricePerMTok: usd(2.5),
    outputPricePerMTok: usd(10),
    minCacheableTokens: tokenCount(1024),
    cacheReadMultiplier: 0.5
  },
  {
    model: "gpt-4o-mini",
    provider: "openai",
    inputPricePerMTok: usd(0.15),
    outputPricePerMTok: usd(0.6),
    minCacheableTokens: tokenCount(1024),
    cacheReadMultiplier: 0.5
  }
];
function findFamilyMatch(model: string): ModelPricing | undefined {
  let best: ModelPricing | undefined;
  for (const entry of PRICING_TABLE) {
    if (!model.startsWith(entry.model)) {
      continue;
    }
    const nextChar = model[entry.model.length];
    const isWordBoundary =
      nextChar === undefined || nextChar === "-" || nextChar === "_" || nextChar === ".";
    if (!isWordBoundary) {
      continue;
    }
    if (!best || entry.model.length > best.model.length) {
      best = entry;
    }
  }
  return best;
}
export function getModelPricing(model: string): ModelPricing {
  const exact = PRICING_TABLE.find((entry) => entry.model === model);
  if (exact) {
    return exact;
  }
  const familyMatch = findFamilyMatch(model);
  if (familyMatch) {
    return familyMatch;
  }
  throw new UnknownModelError(model);
}
