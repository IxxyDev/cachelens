import { describe, expect, it } from "vitest";
import { byteOffset } from "../model/types.js";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import { classifyRegion } from "./classify-region.js";
import { locateBreakpoints } from "./locate.js";
describe("classifyRegion", () => {
  it("attributes a divergence inside the system tier's text leaf correctly", () => {
    const wireBody = JSON.stringify({
      tools: [],
      system: [{ type: "text", text: "Current time: 2026-07-24T10:00:00Z." }],
      messages: []
    });
    const canonical = buildCanonicalRequest(wireBody);
    const textSegment = canonical.segments.find((s) => s.structuralPath === "system[0].text");
    if (!textSegment) throw new Error("expected a system[0].text segment");
    const region = classifyRegion(byteOffset(textSegment.start + 5), canonical.segments, []);
    expect(region.tier).toBe("system");
    expect(region.structuralPath).toBe("system[0].text");
  });
  it("finds the nearest breakpoint at or before the divergence offset", () => {
    const wireBody = JSON.stringify({
      tools: [],
      system: [
        { type: "text", text: "stable block", cache_control: { type: "ephemeral" } },
        { type: "text", text: "dynamic block" }
      ],
      messages: []
    });
    const canonical = buildCanonicalRequest(wireBody);
    const breakpoints = locateBreakpoints(wireBody, canonical.segments);
    const dynamicBlockSegment = canonical.segments.find((s) => s.structuralPath === "system[1]");
    if (!dynamicBlockSegment) throw new Error("expected a system[1] segment");
    const region = classifyRegion(dynamicBlockSegment.start, canonical.segments, breakpoints);
    expect(region.nearestBreakpointBefore).toBeDefined();
    expect(region.nearestBreakpointBefore?.index).toBe(0);
  });
  it("returns undefined nearestBreakpointBefore when no breakpoint precedes the divergence", () => {
    const region = classifyRegion(byteOffset(0), [], []);
    expect(region.nearestBreakpointBefore).toBeUndefined();
  });
});
