import { describe, expect, it } from "vitest";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER_1H,
  CACHE_WRITE_MULTIPLIER_5M,
  UnknownModelError,
  getModelPricing
} from "./table.js";
describe("getModelPricing", () => {
  it("returns pricing for a known model with a per-model min-cacheable threshold", () => {
    const pricing = getModelPricing("claude-opus-4-5");
    expect(pricing.model).toBe("claude-opus-4-5");
    expect(pricing.minCacheableTokens).toBe(4096);
  });
  it("uses the 1024-token threshold for Sonnet 4.5 and below", () => {
    expect(getModelPricing("claude-sonnet-4-5").minCacheableTokens).toBe(1024);
  });
  it("has a pricing entry for claude-opus-4-8 (current Opus 4.x)", () => {
    expect(getModelPricing("claude-opus-4-8").minCacheableTokens).toBe(4096);
  });
  it("throws UnknownModelError for an unrecognized model id", () => {
    expect(() => getModelPricing("not-a-real-model")).toThrow(UnknownModelError);
  });
});
describe("getModelPricing (OpenAI entries)", () => {
  it("returns openai-provider pricing with the ~1024-token min-cacheable proxy and a cacheReadMultiplier override", () => {
    const pricing = getModelPricing("gpt-4o");
    expect(pricing.provider).toBe("openai");
    expect(pricing.minCacheableTokens).toBe(1024);
    expect(pricing.cacheReadMultiplier).toBe(0.5);
  });
  it("has a pricing entry for gpt-4o-mini", () => {
    const pricing = getModelPricing("gpt-4o-mini");
    expect(pricing.provider).toBe("openai");
    expect(pricing.inputPricePerMTok).toBeLessThan(getModelPricing("gpt-4o").inputPricePerMTok);
  });
  it("anthropic entries default to no cacheReadMultiplier override (use the shared constant)", () => {
    expect(getModelPricing("claude-sonnet-4-5").cacheReadMultiplier).toBeUndefined();
  });
});
describe("getModelPricing (dated model-id family/prefix matching)", () => {
  it("matches a dated gpt-4o snapshot id to the gpt-4o family entry", () => {
    const pricing = getModelPricing("gpt-4o-2024-08-20");
    expect(pricing.model).toBe("gpt-4o");
    expect(pricing.provider).toBe("openai");
  });
  it("prefers the longest (most specific) family match: gpt-4o-mini over gpt-4o", () => {
    const pricing = getModelPricing("gpt-4o-mini-2024-07-18");
    expect(pricing.model).toBe("gpt-4o-mini");
  });
  it("does not match past a word boundary (gpt-4o1 is not a snapshot of gpt-4o)", () => {
    expect(() => getModelPricing("gpt-4o1")).toThrow(UnknownModelError);
  });
  it("still throws UnknownModelError for a truly unrecognized model id", () => {
    expect(() => getModelPricing("totally-fake-model-9000")).toThrow(UnknownModelError);
  });
  it("an exact match always wins over a family match, even if a shorter prefix exists", () => {
    expect(getModelPricing("gpt-4o-mini").model).toBe("gpt-4o-mini");
  });
});
describe("shared cache multipliers", () => {
  it("matches Anthropic's documented write/read multipliers", () => {
    expect(CACHE_WRITE_MULTIPLIER_5M).toBe(1.25);
    expect(CACHE_WRITE_MULTIPLIER_1H).toBe(2.0);
    expect(CACHE_READ_MULTIPLIER).toBe(0.1);
  });
});
