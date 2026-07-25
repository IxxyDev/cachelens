import { describe, expect, it, vi } from "vitest";
import { tokenCount } from "../model/types.js";
import {
  cachingCountTokensAdapter,
  hashPrefix,
  offlineCountTokensAdapter
} from "./count-tokens.js";
describe("offlineCountTokensAdapter", () => {
  it("always resolves to undefined (cannot confirm, never a guess)", async () => {
    await expect(offlineCountTokensAdapter.countTokens("anything")).resolves.toBeUndefined();
  });
});
describe("hashPrefix", () => {
  it("is deterministic for the same input", () => {
    expect(hashPrefix("hello world")).toBe(hashPrefix("hello world"));
  });
  it("differs for different input", () => {
    expect(hashPrefix("a")).not.toBe(hashPrefix("b"));
  });
});
describe("cachingCountTokensAdapter", () => {
  it("calls the underlying adapter once per distinct prefix", async () => {
    const underlying = { countTokens: vi.fn(async () => tokenCount(42)) };
    const cached = cachingCountTokensAdapter(underlying);
    await cached.countTokens("prefix-a");
    await cached.countTokens("prefix-a");
    await cached.countTokens("prefix-b");
    expect(underlying.countTokens).toHaveBeenCalledTimes(2);
  });
  it("returns the memoized result on a repeated prefix", async () => {
    const underlying = { countTokens: vi.fn(async () => tokenCount(100)) };
    const cached = cachingCountTokensAdapter(underlying);
    const first = await cached.countTokens("same");
    const second = await cached.countTokens("same");
    expect(first).toBe(100);
    expect(second).toBe(100);
  });
  it("memoizes an undefined ('cannot confirm') result too, not just successes", async () => {
    const underlying = { countTokens: vi.fn(async () => undefined) };
    const cached = cachingCountTokensAdapter(underlying);
    await cached.countTokens("x");
    await cached.countTokens("x");
    expect(underlying.countTokens).toHaveBeenCalledTimes(1);
  });
});
