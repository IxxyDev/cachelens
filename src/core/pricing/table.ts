import type { Provider } from "../model/provider.js";
import { type TokenCount, tokenCount, type Usd, usd } from "../model/types.js";
/**
 * Date the prices below were last checked against the providers' published pricing pages
 * (Anthropic: platform.claude.com pricing + prompt-caching docs; OpenAI: developers.openai.com/api/docs/pricing).
 */
export const PRICING_AS_OF = "2026-10-06";
export interface ModelPricing {
  readonly model: string;
  readonly provider: Provider;
  readonly inputPricePerMTok: Usd;
  readonly outputPricePerMTok: Usd;
  readonly minCacheableTokens: TokenCount;
  /** Cache-read price as a fraction of the base input price. */
  readonly cacheReadMultiplier: number;
  /** Cache-write price for a 5-minute TTL as a multiple of the base input price. */
  readonly cacheWrite5mMultiplier: number;
  /** Cache-write price for a 1-hour TTL as a multiple of the base input price. */
  readonly cacheWrite1hMultiplier: number;
}
export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`No pricing entry for model "${model}". Add it to core/pricing/table.ts.`);
    this.name = "UnknownModelError";
  }
}
function anthropic(
  model: string,
  input: number,
  output: number,
  cacheReadMultiplier: number,
  minCacheableTokens: number
): ModelPricing {
  return {
    model,
    provider: "anthropic",
    inputPricePerMTok: usd(input),
    outputPricePerMTok: usd(output),
    minCacheableTokens: tokenCount(minCacheableTokens),
    cacheReadMultiplier,
    cacheWrite5mMultiplier: 1.25,
    cacheWrite1hMultiplier: 2
  };
}
/**
 * OpenAI caches automatically from 1024 tokens with a single TTL, so both write multipliers are the
 * same: 1x where the page lists no cache-write price, the listed cache-write price otherwise.
 */
function openai(
  model: string,
  input: number,
  cachedInput: number,
  output: number,
  cacheWrite?: number
): ModelPricing {
  const writeMultiplier = cacheWrite === undefined ? 1 : cacheWrite / input;
  return {
    model,
    provider: "openai",
    inputPricePerMTok: usd(input),
    outputPricePerMTok: usd(output),
    minCacheableTokens: tokenCount(1024),
    cacheReadMultiplier: cachedInput / input,
    cacheWrite5mMultiplier: writeMultiplier,
    cacheWrite1hMultiplier: writeMultiplier
  };
}
const PRICING_TABLE: readonly ModelPricing[] = [
  anthropic("claude-fable-5-1", 10, 50, 0.025, 512),
  anthropic("claude-fable-5", 10, 50, 0.1, 512),
  anthropic("claude-opus-5-5", 4, 20, 0.05, 512),
  anthropic("claude-opus-5", 5, 25, 0.1, 512),
  anthropic("claude-opus-4-8", 5, 25, 0.1, 1024),
  anthropic("claude-opus-4-7", 5, 25, 0.1, 2048),
  anthropic("claude-opus-4-6", 5, 25, 0.1, 4096),
  anthropic("claude-opus-4-5", 5, 25, 0.1, 4096),
  anthropic("claude-sonnet-5-5", 2, 10, 0.1, 512),
  anthropic("claude-sonnet-5", 2, 10, 0.1, 1024),
  anthropic("claude-sonnet-4-6", 3, 15, 0.1, 1024),
  anthropic("claude-sonnet-4-5", 3, 15, 0.1, 1024),
  anthropic("claude-haiku-4-5", 1, 5, 0.1, 4096),
  openai("gpt-6-astra", 10, 1, 50, 12.5),
  openai("gpt-6.1-sol", 2, 0.1, 10, 2.5),
  openai("gpt-6-sol", 2, 0.2, 10, 2.5),
  openai("gpt-6-luna", 0.1, 0.01, 0.5, 0.125),
  openai("gpt-5.6-sol", 4, 0.4, 20, 5),
  openai("gpt-5.6-terra", 2, 0.2, 12, 2.5),
  openai("gpt-5.6-luna", 0.2, 0.02, 1.2, 0.25),
  openai("gpt-5.5", 5, 0.5, 30),
  openai("gpt-5.4", 2.5, 0.25, 15),
  openai("gpt-5.4-mini", 0.75, 0.075, 4.5),
  openai("gpt-5.4-nano", 0.2, 0.02, 1.25),
  openai("gpt-5.2", 1.75, 0.175, 14),
  openai("gpt-5.1", 1.25, 0.125, 10),
  openai("gpt-5", 1.25, 0.125, 10),
  openai("gpt-5-mini", 0.25, 0.025, 2),
  openai("gpt-5-nano", 0.05, 0.005, 0.4),
  openai("gpt-4.1", 2, 0.5, 8),
  openai("gpt-4.1-mini", 0.4, 0.1, 1.6),
  openai("gpt-4.1-nano", 0.1, 0.025, 0.4),
  openai("gpt-4o", 2.5, 1.25, 10),
  openai("gpt-4o-mini", 0.15, 0.075, 0.6)
];
export const PRICED_MODEL_IDS: readonly string[] = PRICING_TABLE.map((entry) => entry.model);
/**
 * What may follow a row id for the id to still resolve to that row: a dated snapshot
 * (-20260301 or -2024-05-13), "-latest", or one deployment segment that does not start with a
 * digit (-thinking). A remainder that starts with a digit segment is a version bump
 * (claude-opus-5-6 is not claude-opus-5) and must stay unpriced rather than borrow a price.
 */
const FAMILY_SUFFIX = /^-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|[a-z][a-z0-9]*)$/;
/** Longest row id that `model` extends with an allowed suffix. */
function findFamilyMatch(model: string): ModelPricing | undefined {
  let best: ModelPricing | undefined;
  for (const entry of PRICING_TABLE) {
    if (!model.startsWith(entry.model) || !FAMILY_SUFFIX.test(model.slice(entry.model.length))) {
      continue;
    }
    if (!best || entry.model.length > best.model.length) {
      best = entry;
    }
  }
  return best;
}
export function tryGetModelPricing(model: string): ModelPricing | undefined {
  return PRICING_TABLE.find((entry) => entry.model === model) ?? findFamilyMatch(model);
}
export function getModelPricing(model: string): ModelPricing {
  const pricing = tryGetModelPricing(model);
  if (!pricing) {
    throw new UnknownModelError(model);
  }
  return pricing;
}
/** One warning per distinct model id that has no pricing entry, in first-seen order. */
export function unpricedModelWarnings(models: Iterable<string>): string[] {
  const unpriced = new Set<string>();
  for (const model of models) {
    if (!tryGetModelPricing(model)) {
      unpriced.add(model);
    }
  }
  return [...unpriced].map(
    (model) =>
      `no pricing for model "${model}" (pricing as of ${PRICING_AS_OF}); costs for this model are excluded from totals; its cache misses are still diagnosed, with wasted $ shown as n/a`
  );
}
