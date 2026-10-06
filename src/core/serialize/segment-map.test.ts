import { describe, expect, it } from "vitest";
import { byteOffset } from "../model/types.js";
import {
  byteLengthUtf8,
  type Segment,
  sliceByBytes,
  structuralPathAt,
  tierAt,
  tierSegment
} from "./segment-map.js";

const segment = (start: number, end: number, tier: Segment["tier"], path: string): Segment => ({
  start: byteOffset(start),
  end: byteOffset(end),
  tier,
  structuralPath: path
});

const outer = segment(0, 100, "system", "system");
const inner = segment(10, 20, "system", "system[0].text");
const messages = segment(100, 150, "messages", "messages");

describe("segment lookup", () => {
  it("resolves an offset to the narrowest enclosing segment whichever order they are listed in", () => {
    expect(structuralPathAt([outer, inner], byteOffset(15))).toBe("system[0].text");
    expect(structuralPathAt([inner, outer], byteOffset(15))).toBe("system[0].text");
  });

  it("falls back to the enclosing segment outside the nested one", () => {
    expect(structuralPathAt([outer, inner], byteOffset(25))).toBe("system");
  });

  it("treats segment ends as exclusive", () => {
    expect(tierAt([outer, messages], byteOffset(99))).toBe("system");
    expect(tierAt([outer, messages], byteOffset(100))).toBe("messages");
    expect(tierAt([outer, messages], byteOffset(150))).toBeUndefined();
  });

  it("finds the top-level segment for a tier by its structural path", () => {
    expect(tierSegment([inner, outer, messages], "system")).toBe(outer);
    expect(tierSegment([inner, outer], "tools")).toBeUndefined();
  });
});

describe("UTF-8 byte helpers", () => {
  it("counts bytes, not UTF-16 code units", () => {
    expect(byteLengthUtf8("abc")).toBe(3);
    expect(byteLengthUtf8("é")).toBe(2);
    expect(byteLengthUtf8("😀")).toBe(4);
  });

  it("slices by byte offsets", () => {
    expect(sliceByBytes("café latte", byteOffset(0), byteOffset(5))).toBe("café");
    expect(sliceByBytes("café latte", byteOffset(6), byteOffset(11))).toBe("latte");
  });
});
