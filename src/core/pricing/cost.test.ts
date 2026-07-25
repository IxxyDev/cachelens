import { describe, expect, it } from "vitest";
import type { CacheTier } from "../model/tier.js";
import { tokenCount } from "../model/types.js";
import { computeCallCost, computeTieredCounterfactual, computeWastedUsd } from "./cost.js";
import { getModelPricing } from "./table.js";
describe("computeCallCost", () => {
  const pricing = getModelPricing("claude-sonnet-4-5");
  it("prices a call with no cache activity as plain input + output", () => {
    const cost = computeCallCost(
      {
        inputTokens: tokenCount(1000000),
        outputTokens: tokenCount(1000000),
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(0)
      },
      pricing,
      "5m"
    );
    expect(cost).toBeCloseTo(3 + 15, 6);
  });
  it("applies the 5m write multiplier to cache-creation tokens", () => {
    const cost = computeCallCost(
      {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(1000000),
        cacheReadInputTokens: tokenCount(0)
      },
      pricing,
      "5m"
    );
    expect(cost).toBeCloseTo(3 * 1.25, 6);
  });
  it("applies the 1h write multiplier to cache-creation tokens", () => {
    const cost = computeCallCost(
      {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(1000000),
        cacheReadInputTokens: tokenCount(0)
      },
      pricing,
      "1h"
    );
    expect(cost).toBeCloseTo(3 * 2.0, 6);
  });
  it("applies the read multiplier to cache-read tokens", () => {
    const cost = computeCallCost(
      {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(1000000)
      },
      pricing,
      "5m"
    );
    expect(cost).toBeCloseTo(3 * 0.1, 6);
  });
  it("sums all four components", () => {
    const cost = computeCallCost(
      {
        inputTokens: tokenCount(500000),
        outputTokens: tokenCount(200000),
        cacheCreationInputTokens: tokenCount(300000),
        cacheReadInputTokens: tokenCount(1000000)
      },
      pricing,
      "5m"
    );
    const expected = 0.5 * 3 + 0.2 * 15 + 0.3 * 3 * 1.25 + 1.0 * 3 * 0.1;
    expect(cost).toBeCloseTo(expected, 6);
  });
});
describe("computeCallCost (OpenAI provider — no write premium, provider-specific read discount)", () => {
  const openaiPricing = getModelPricing("gpt-4o");
  it("prices cache-creation tokens at plain 1x (no write premium), unlike Anthropic's 1.25x/2.0x", () => {
    const cost = computeCallCost(
      {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(1000000),
        cacheReadInputTokens: tokenCount(0)
      },
      openaiPricing,
      "5m"
    );
    expect(cost).toBeCloseTo(2.5, 6);
  });
  it("applies the model's own cacheReadMultiplier instead of Anthropic's 0.1x default", () => {
    const cost = computeCallCost(
      {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(1000000)
      },
      openaiPricing,
      "5m"
    );
    expect(cost).toBeCloseTo(2.5 * 0.5, 6);
  });
  it("computeWastedUsd reflects the forgone read discount, not a write premium, for a hypothetical nonzero cache-creation figure", () => {
    const wasted = computeWastedUsd(tokenCount(1000000), openaiPricing, "5m");
    expect(wasted).toBeCloseTo(2.5 * (1 - 0.5), 6);
  });
  it("computeWastedUsd is 0 for OpenAI's real, always-zero cache-creation-tokens figure", () => {
    expect(computeWastedUsd(tokenCount(0), openaiPricing, "5m")).toBe(0);
  });
});
describe("computeTieredCounterfactual", () => {
  const pricing = getModelPricing("claude-sonnet-4-5");
  const tierByteLengths: Record<CacheTier, number> = { tools: 400, system: 100, messages: 900 };
  it("attributes the full waste to the single invalidated tier, zero elsewhere", () => {
    const result = computeTieredCounterfactual({
      invalidatedTiers: ["system"],
      tierByteLengths,
      cacheCreationInputTokens: tokenCount(1000000),
      pricing,
      ttl: "5m"
    });
    const expectedTotal = computeWastedUsd(tokenCount(1000000), pricing, "5m");
    expect(expectedTotal).toBeCloseTo(3 * (1.25 - 0.1), 6);
    expect(result.totalWastedUsd).toBeCloseTo(expectedTotal, 6);
    expect(result.wastedUsdByTier.get("system")).toBeCloseTo(expectedTotal, 6);
    expect(result.wastedUsdByTier.get("tools")).toBe(0);
    expect(result.wastedUsdByTier.get("messages")).toBe(0);
  });
  it("splits waste proportionally by byte length across multiple invalidated tiers", () => {
    const result = computeTieredCounterfactual({
      invalidatedTiers: ["tools", "system"],
      tierByteLengths,
      cacheCreationInputTokens: tokenCount(1000000),
      pricing,
      ttl: "5m"
    });
    const total = result.totalWastedUsd;
    expect(result.wastedUsdByTier.get("tools")).toBeCloseTo(total * 0.8, 6);
    expect(result.wastedUsdByTier.get("system")).toBeCloseTo(total * 0.2, 6);
    expect(result.wastedUsdByTier.get("messages")).toBe(0);
    const summed = [...result.wastedUsdByTier.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBeCloseTo(total, 6);
  });
  it("uses the 1h write multiplier when ttl is 1h", () => {
    const result = computeTieredCounterfactual({
      invalidatedTiers: ["messages"],
      tierByteLengths,
      cacheCreationInputTokens: tokenCount(1000000),
      pricing,
      ttl: "1h"
    });
    expect(result.totalWastedUsd).toBeCloseTo(3 * (2.0 - 0.1), 6);
  });
  it("zeroes every tier when no tier is invalidated", () => {
    const result = computeTieredCounterfactual({
      invalidatedTiers: [],
      tierByteLengths,
      cacheCreationInputTokens: tokenCount(1000000),
      pricing,
      ttl: "5m"
    });
    expect(result.wastedUsdByTier.get("tools")).toBe(0);
    expect(result.wastedUsdByTier.get("system")).toBe(0);
    expect(result.wastedUsdByTier.get("messages")).toBe(0);
  });
  it("does not divide by zero when invalidated tiers have zero total byte length", () => {
    const result = computeTieredCounterfactual({
      invalidatedTiers: ["system"],
      tierByteLengths: { tools: 0, system: 0, messages: 0 },
      cacheCreationInputTokens: tokenCount(1000000),
      pricing,
      ttl: "5m"
    });
    expect(result.wastedUsdByTier.get("system")).toBe(0);
  });
});
