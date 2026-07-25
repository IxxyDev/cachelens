import { describe, expect, it } from "vitest";
import { byteOffset, tokenCount, usd } from "../model/types.js";
import type { ModelPricing } from "../pricing/table.js";
import { computeWastedUsd, excerptAroundByteOffset } from "./recommend.js";
const PRICING: ModelPricing = {
  model: "test-model",
  provider: "anthropic",
  inputPricePerMTok: usd(3),
  outputPricePerMTok: usd(15),
  minCacheableTokens: tokenCount(1024)
};
describe("computeWastedUsd", () => {
  it("computes the extra cost of a write vs. a read at the 5m multiplier", () => {
    const wasted = computeWastedUsd(tokenCount(1000000), PRICING, "5m");
    expect(wasted).toBeCloseTo(3 * (1.25 - 0.1), 6);
  });
  it("clamps to zero rather than going negative (defensive, e.g. a malformed negative price)", () => {
    const negativePricing: ModelPricing = { ...PRICING, inputPricePerMTok: usd(-3) };
    expect(computeWastedUsd(tokenCount(1000000), negativePricing, "5m")).toBe(0);
  });
});
describe("excerptAroundByteOffset", () => {
  it("returns a window of text around the given byte offset", () => {
    expect(excerptAroundByteOffset("0123456789", byteOffset(5), 2)).toBe("3456");
  });
  it("snaps window edges to UTF-8 character boundaries instead of emitting U+FFFD", () => {
    const text = "☕☕☕☕";
    const excerpt = excerptAroundByteOffset(text, byteOffset(4), 2);
    expect(excerpt).not.toContain("�");
    expect(excerpt).toBe("☕☕");
  });
  it("extends the window end forward to complete a character cut by the byte limit", () => {
    const excerpt = excerptAroundByteOffset("☕", byteOffset(0), 1);
    expect(excerpt).toBe("☕");
  });
  it("returns an empty excerpt for an offset past the end of the text", () => {
    expect(excerptAroundByteOffset("abc", byteOffset(100), 2)).toBe("");
  });
});
