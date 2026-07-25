import { describe, expect, it } from "vitest";
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
});
