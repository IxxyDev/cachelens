import { describe, expect, it } from "vitest";
import { excerptAroundByteOffset } from "../diagnose/recommend.js";
import { diffPrefix } from "./prefix-diff.js";

describe("diffPrefix", () => {
  it("reports identical for byte-for-byte equal texts", () => {
    const result = diffPrefix('{"a":1}', '{"a":1}');
    expect(result.identical).toBe(true);
    expect(result.previousIsPrefixOfCurrent).toBe(true);
    expect(result.divergenceByteOffset).toBe(7);
  });
  it("reports previousIsPrefixOfCurrent when current only appends content", () => {
    const result = diffPrefix(
      '[{"role":"user","content":"hi"}',
      '[{"role":"user","content":"hi"},{"role":"assistant"}]'
    );
    expect(result.identical).toBe(false);
    expect(result.previousIsPrefixOfCurrent).toBe(true);
    expect(result.divergenceByteOffset).toBe(31);
  });
  it("locates the divergence offset when content changes mid-string", () => {
    const result = diffPrefix('{"a":1,"b":2}', '{"a":1,"b":9}');
    expect(result.identical).toBe(false);
    expect(result.previousIsPrefixOfCurrent).toBe(false);
    expect(result.divergenceByteOffset).toBe(11);
  });
  it("counts UTF-8 bytes, not UTF-16 code units, for multi-byte characters", () => {
    const result = diffPrefix('{"a":"é', '{"a":"éX"}');
    expect(result.previousIsPrefixOfCurrent).toBe(true);
    expect(result.divergenceByteOffset).toBe(8);
  });
  it("reports a divergence inside a multi-byte character at the first differing byte", () => {
    // "é" is C3 A9 and "è" is C3 A8: both share the lead byte, so the first
    // differing byte is the continuation byte, one past the character start.
    const previous = '{"name":"café au lait"}';
    const current = '{"name":"cafè au lait"}';
    const result = diffPrefix(previous, current);
    expect(result.identical).toBe(false);
    expect(result.previousIsPrefixOfCurrent).toBe(false);
    expect(result.divergenceByteOffset).toBe(13);
    expect(new TextEncoder().encode(current)[12]).toBe(0xc3);
  });
  it("lets an excerpt at a mid-character divergence snap to whole characters", () => {
    const current = '{"name":"cafè au lait"}';
    const { divergenceByteOffset } = diffPrefix('{"name":"café au lait"}', current);
    // A window ending exactly at the divergence would split "è"; the excerpt
    // must extend to the character boundary rather than emit U+FFFD.
    expect(excerptAroundByteOffset(current, divergenceByteOffset, 1)).toBe("è");
    expect(excerptAroundByteOffset(current, divergenceByteOffset, 4)).toBe("cafè au");
  });
});
