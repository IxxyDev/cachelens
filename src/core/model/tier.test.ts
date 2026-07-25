import { describe, expect, it } from "vitest";
import { CACHE_TIER_ORDER } from "./tier.js";
describe("CACHE_TIER_ORDER", () => {
  it("matches the cache-key hashing prefix order: tools -> system -> messages", () => {
    expect(CACHE_TIER_ORDER).toEqual(["tools", "system", "messages"]);
  });
});
