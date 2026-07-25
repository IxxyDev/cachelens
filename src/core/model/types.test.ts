import { describe, expect, it } from "vitest";
import { byteOffset, tokenCount, usd } from "./types.js";
describe("branded primitive constructors", () => {
  it("byteOffset wraps a plain number", () => {
    expect(byteOffset(42)).toBe(42);
  });
  it("tokenCount wraps a plain number", () => {
    expect(tokenCount(1024)).toBe(1024);
  });
  it("usd wraps a plain number", () => {
    expect(usd(0.015)).toBe(0.015);
  });
});
