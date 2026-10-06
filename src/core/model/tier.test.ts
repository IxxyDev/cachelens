import { describe, expect, it } from "vitest";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import { tierAt } from "../serialize/segment-map.js";
import { CACHE_TIER_ORDER } from "./tier.js";
import { byteOffset } from "./types.js";

const wireBody = JSON.stringify({
  // Deliberately out of prefix order on the wire: the canonical form must not care.
  messages: [{ role: "user", content: "question" }],
  system: "be brief",
  tools: [{ name: "search", input_schema: { type: "object" } }]
});

describe("cache tiers in the canonical serialization", () => {
  const canonical = buildCanonicalRequest(wireBody);
  const topLevel = canonical.segments.filter((s) => s.structuralPath === s.tier);

  it("lays the tier segments out in CACHE_TIER_ORDER, back to back from offset 0", () => {
    const ordered = [...topLevel].sort((a, b) => a.start - b.start);
    expect(ordered.map((s) => s.tier)).toEqual(CACHE_TIER_ORDER);
    expect(ordered[0]?.start).toBe(0);
    expect(ordered[1]?.start).toBe(ordered[0]?.end);
    expect(ordered[2]?.start).toBe(ordered[1]?.end);
    expect(ordered[2]?.end).toBe(canonical.byteLength);
  });

  it("maps concrete byte offsets to the tier whose bytes contain them", () => {
    const at = (needle: string) => byteOffset(Buffer.from(canonical.text).indexOf(needle));
    expect(tierAt(canonical.segments, at("search"))).toBe("tools");
    expect(tierAt(canonical.segments, at("be brief"))).toBe("system");
    expect(tierAt(canonical.segments, at("question"))).toBe("messages");
    expect(tierAt(canonical.segments, byteOffset(canonical.byteLength))).toBeUndefined();
  });
});
