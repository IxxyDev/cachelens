import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import type { CacheTier } from "../model/tier.js";
import { tokenCount } from "../model/types.js";
import {
  cacheWriteSplit,
  computeCallCost,
  computeTieredCounterfactual,
  computeWastedUsd,
  declaredWriteTtl,
  writeMultiplierFor
} from "./cost.js";
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
describe("computeCallCost (per-model cache-read multiplier)", () => {
  const oneMillionCacheRead = {
    inputTokens: tokenCount(0),
    outputTokens: tokenCount(0),
    cacheCreationInputTokens: tokenCount(0),
    cacheReadInputTokens: tokenCount(1000000)
  };
  it("prices a 1M-token cache read on claude-opus-5-5 at $0.20 (0.05x of $4)", () => {
    expect(
      computeCallCost(oneMillionCacheRead, getModelPricing("claude-opus-5-5"), "5m")
    ).toBeCloseTo(0.2, 10);
  });
  it("prices a 1M-token cache read on claude-fable-5-1 at $0.25 (0.025x of $10)", () => {
    expect(
      computeCallCost(oneMillionCacheRead, getModelPricing("claude-fable-5-1"), "5m")
    ).toBeCloseTo(0.25, 10);
  });
  it("computeWastedUsd subtracts the model's own read multiplier", () => {
    const wasted = computeWastedUsd(tokenCount(1000000), getModelPricing("claude-opus-5-5"), "5m");
    expect(wasted).toBeCloseTo(4 * (1.25 - 0.05), 10);
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
  it("applies the model's own cacheReadMultiplier (0.5x for gpt-4o)", () => {
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
describe("TTL-aware cache-write pricing", () => {
  const pricing = getModelPricing("claude-sonnet-4-5");
  function callWithSystem(
    cacheControl: Record<string, unknown> | undefined,
    usage: Partial<LlmCall["usage"]> = {}
  ): LlmCall {
    return {
      id: "c",
      sessionId: "s",
      stepName: "step",
      timestamp: 0,
      params: { model: "claude-sonnet-4-5" },
      payload: {
        wireBody: JSON.stringify({
          system: [
            { type: "text", text: "x", ...(cacheControl ? { cache_control: cacheControl } : {}) }
          ],
          messages: []
        })
      },
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(1000000),
        cacheReadInputTokens: tokenCount(0),
        ...usage
      }
    };
  }
  it("a 1h write costs 2x the base input price", () => {
    const call = callWithSystem({ type: "ephemeral", ttl: "1h" });
    expect(declaredWriteTtl(call)).toBe("1h");
    expect(writeMultiplierFor(call, pricing)).toBe(2);
    expect(computeCallCost(call.usage, pricing, declaredWriteTtl(call))).toBeCloseTo(3 * 2, 6);
  });
  it("a call with no breakpoint, a 5m breakpoint, or an unparseable body falls back to 5m (1.25x)", () => {
    expect(declaredWriteTtl(callWithSystem(undefined))).toBe("5m");
    expect(declaredWriteTtl(callWithSystem({ type: "ephemeral" }))).toBe("5m");
    const broken = { ...callWithSystem(undefined), payload: { wireBody: "{oops" } };
    expect(declaredWriteTtl(broken)).toBe("5m");
    expect(writeMultiplierFor(callWithSystem({ type: "ephemeral" }), pricing)).toBe(1.25);
  });
  it("prices a reported 148/100 split at 1.25x/2x respectively, regardless of the fallback TTL", () => {
    const usage = {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(248),
      cacheCreation5mInputTokens: tokenCount(148),
      cacheCreation1hInputTokens: tokenCount(100),
      cacheReadInputTokens: tokenCount(0)
    };
    expect(cacheWriteSplit(usage, "1h")).toEqual({ tokens5m: 148, tokens1h: 100 });
    const expected = (3 / 1000000) * (148 * 1.25 + 100 * 2);
    expect(computeCallCost(usage, pricing, "5m")).toBeCloseTo(expected, 12);
    expect(computeCallCost(usage, pricing, "1h")).toBeCloseTo(expected, 12);
    const call = callWithSystem({ type: "ephemeral" }, usage);
    expect(writeMultiplierFor(call, pricing)).toBeCloseTo((148 * 1.25 + 100 * 2) / 248, 12);
  });
});
