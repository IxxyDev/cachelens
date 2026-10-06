import { describe, expect, it } from "vitest";
import {
  getModelPricing,
  PRICED_MODEL_IDS,
  PRICING_AS_OF,
  tryGetModelPricing,
  UnknownModelError,
  unpricedModelWarnings
} from "./table.js";

describe("pricing table contents", () => {
  it("records the date the prices were checked", () => {
    expect(PRICING_AS_OF).toBe("2026-10-06");
  });
  it("pins the exact list of priced model ids so drift is visible in review", () => {
    expect(PRICED_MODEL_IDS).toEqual([
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.2",
      "gpt-5.1",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini"
    ]);
  });
  it.each([
    ["claude-fable-5-1", 10, 50, 0.025, 512],
    ["claude-fable-5", 10, 50, 0.1, 512],
    ["claude-opus-5-5", 4, 20, 0.05, 512],
    ["claude-opus-5", 5, 25, 0.1, 512],
    ["claude-opus-4-8", 5, 25, 0.1, 1024],
    ["claude-opus-4-7", 5, 25, 0.1, 2048],
    ["claude-opus-4-6", 5, 25, 0.1, 4096],
    ["claude-opus-4-5", 5, 25, 0.1, 4096],
    ["claude-sonnet-5-5", 2, 10, 0.1, 512],
    ["claude-sonnet-5", 2, 10, 0.1, 1024],
    ["claude-sonnet-4-6", 3, 15, 0.1, 1024],
    ["claude-sonnet-4-5", 3, 15, 0.1, 1024],
    ["claude-haiku-4-5", 1, 5, 0.1, 4096]
  ])("prices %s at $%d/$%d, read x%d, min %d tokens", (model, input, output, read, minTokens) => {
    const pricing = getModelPricing(model);
    expect(pricing).toEqual({
      model,
      provider: "anthropic",
      inputPricePerMTok: input,
      outputPricePerMTok: output,
      minCacheableTokens: minTokens,
      cacheReadMultiplier: read,
      cacheWrite5mMultiplier: 1.25,
      cacheWrite1hMultiplier: 2
    });
  });
  it("no longer lists the retired claude-haiku-3-5", () => {
    expect(tryGetModelPricing("claude-haiku-3-5")).toBeUndefined();
  });
});
describe("getModelPricing", () => {
  it("throws UnknownModelError for an unrecognized model id", () => {
    expect(() => getModelPricing("not-a-real-model")).toThrow(UnknownModelError);
  });
});
describe("tryGetModelPricing", () => {
  it("returns undefined instead of throwing for an unknown model", () => {
    expect(tryGetModelPricing("claude-unknown-9")).toBeUndefined();
  });
  it("returns the same entry getModelPricing returns for a known model", () => {
    expect(tryGetModelPricing("claude-sonnet-4-5")).toBe(getModelPricing("claude-sonnet-4-5"));
  });
});
describe("getModelPricing (OpenAI entries)", () => {
  it("derives the read multiplier from the listed cached-input price", () => {
    const pricing = getModelPricing("gpt-4o");
    expect(pricing.provider).toBe("openai");
    expect(pricing.minCacheableTokens).toBe(1024);
    expect(pricing.cacheReadMultiplier).toBe(0.5);
    expect(getModelPricing("gpt-5").cacheReadMultiplier).toBeCloseTo(0.1, 10);
  });
  it("has no write premium where the page lists no cache-write price", () => {
    const pricing = getModelPricing("gpt-5.5");
    expect(pricing.cacheWrite5mMultiplier).toBe(1);
    expect(pricing.cacheWrite1hMultiplier).toBe(1);
  });
  it("uses the listed cache-write price where one exists (gpt-6 family, 1.25x)", () => {
    const pricing = getModelPricing("gpt-6-astra");
    expect(pricing.cacheWrite5mMultiplier).toBe(1.25);
    expect(pricing.cacheWrite1hMultiplier).toBe(1.25);
    expect(pricing.cacheReadMultiplier).toBe(0.1);
  });
  it("has a cheaper gpt-4o-mini entry", () => {
    expect(getModelPricing("gpt-4o-mini").inputPricePerMTok).toBeLessThan(
      getModelPricing("gpt-4o").inputPricePerMTok
    );
  });
});
describe("getModelPricing (dated model-id family/prefix matching)", () => {
  it("resolves claude-fable-5-1 to its own entry, not the claude-fable-5 prefix", () => {
    expect(getModelPricing("claude-fable-5-1").model).toBe("claude-fable-5-1");
    expect(getModelPricing("claude-fable-5-1").cacheReadMultiplier).toBe(0.025);
  });
  it("resolves a dated claude-opus-5-5 snapshot via the longest prefix", () => {
    expect(getModelPricing("claude-opus-5-5-20260301").model).toBe("claude-opus-5-5");
  });
  it("matches a dated gpt-4o snapshot id to the gpt-4o family entry", () => {
    expect(getModelPricing("gpt-4o-2024-08-20").model).toBe("gpt-4o");
  });
  it("prefers the longest (most specific) family match: gpt-4o-mini over gpt-4o", () => {
    expect(getModelPricing("gpt-4o-mini-2024-07-18").model).toBe("gpt-4o-mini");
  });
  it("does not match past a word boundary (gpt-4o1 is not a snapshot of gpt-4o)", () => {
    expect(tryGetModelPricing("gpt-4o1")).toBeUndefined();
  });
  it("does not treat a dotted version as a snapshot (gpt-5.3-codex is not gpt-5)", () => {
    expect(tryGetModelPricing("gpt-5.3-codex")).toBeUndefined();
  });
  it("does not borrow a family price across a version bump (claude-opus-5-6 is unpriced)", () => {
    expect(tryGetModelPricing("claude-opus-5-6")).toBeUndefined();
    expect(tryGetModelPricing("claude-opus-5-5-1")).toBeUndefined();
    expect(tryGetModelPricing("claude-fable-5-2")).toBeUndefined();
  });
  it("resolves the -latest alias to its row", () => {
    expect(getModelPricing("claude-opus-5-5-latest").model).toBe("claude-opus-5-5");
  });
  it("resolves a hyphenated-date snapshot (gpt-4o-2024-05-13) to its family", () => {
    expect(getModelPricing("gpt-4o-2024-05-13").model).toBe("gpt-4o");
  });
  it("resolves one non-numeric deployment segment, but not a segment followed by more", () => {
    expect(getModelPricing("claude-sonnet-5-5-thinking").model).toBe("claude-sonnet-5-5");
    expect(tryGetModelPricing("claude-sonnet-5-5-thinking-2")).toBeUndefined();
  });
  it("an exact match always wins over a family match", () => {
    expect(getModelPricing("gpt-4o-mini").model).toBe("gpt-4o-mini");
  });
});
describe("unpricedModelWarnings", () => {
  it("returns one warning per distinct unpriced model, naming it", () => {
    const warnings = unpricedModelWarnings([
      "claude-unknown-9",
      "claude-sonnet-4-5",
      "claude-unknown-9",
      "mystery-model"
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"claude-unknown-9"');
    expect(warnings[0]).toContain("excluded from totals");
    expect(warnings[1]).toContain('"mystery-model"');
  });
  it("returns nothing when every model is priced", () => {
    expect(unpricedModelWarnings(["claude-opus-5-5-20260301", "gpt-5"])).toEqual([]);
  });
});
