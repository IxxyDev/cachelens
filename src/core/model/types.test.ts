import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ByteOffset,
  byteOffset,
  type TokenCount,
  tokenCount,
  type Usd,
  usd
} from "./types.js";

describe("branded primitives", () => {
  it("keeps the numeric value, so arithmetic and JSON see a plain number", () => {
    const offset = byteOffset(40);
    expect(offset + 2).toBe(42);
    expect(JSON.stringify({ tokens: tokenCount(1024), cost: usd(0.015) })).toBe(
      '{"tokens":1024,"cost":0.015}'
    );
  });

  it("does not let a bare number or a different unit stand in for a brand", () => {
    expectTypeOf(byteOffset(1)).toEqualTypeOf<ByteOffset>();
    expectTypeOf<number>().not.toExtend<ByteOffset>();
    expectTypeOf<TokenCount>().not.toExtend<Usd>();
    expectTypeOf<Usd>().not.toExtend<ByteOffset>();
    // A branded value still widens to number where a plain number is expected.
    expectTypeOf<TokenCount>().toExtend<number>();
    // @ts-expect-error a token count is not a dollar amount
    const wrongUnit: Usd = tokenCount(5);
    expect(wrongUnit).toBe(5);
  });
});
