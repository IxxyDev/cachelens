import { describe, expect, it } from "vitest";
import { normalizeSortedKeys, normalizedJsonEquals } from "./normalize.js";
describe("normalizeSortedKeys", () => {
  it("sorts object keys recursively", () => {
    expect(normalizeSortedKeys({ b: 1, a: { d: 1, c: 2 } })).toEqual({ a: { c: 2, d: 1 }, b: 1 });
  });
  it("preserves array element order", () => {
    expect(
      normalizeSortedKeys([
        { b: 1, a: 2 },
        { d: 1, c: 2 }
      ])
    ).toEqual([
      { a: 2, b: 1 },
      { c: 2, d: 1 }
    ]);
  });
});
describe("normalizedJsonEquals", () => {
  it("returns true for logically-identical JSON with different key order", () => {
    const a = '[{"name":"search","description":"x"}]';
    const b = '[{"description":"x","name":"search"}]';
    expect(normalizedJsonEquals(a, b)).toBe(true);
  });
  it("returns false when the underlying data actually differs", () => {
    const a = '[{"name":"search"}]';
    const b = '[{"name":"lookup"}]';
    expect(normalizedJsonEquals(a, b)).toBe(false);
  });
  it("returns false (not a silent match) when either text fails to parse", () => {
    expect(normalizedJsonEquals("not json", '{"a":1}')).toBe(false);
  });
});
