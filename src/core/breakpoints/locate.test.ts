import { describe, expect, it } from "vitest";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import { locateBreakpoints } from "./locate.js";
describe("locateBreakpoints", () => {
  it("locates a cache_control breakpoint on a system content block", () => {
    const wireBody = JSON.stringify({
      tools: [],
      system: [{ type: "text", text: "static instructions", cache_control: { type: "ephemeral" } }],
      messages: []
    });
    const canonical = buildCanonicalRequest(wireBody);
    const breakpoints = locateBreakpoints(wireBody, canonical.segments);
    expect(breakpoints).toHaveLength(1);
    expect(breakpoints[0]).toMatchObject({ tier: "system", index: 0, ttl: "5m" });
  });
  it("respects an explicit 1h ttl", () => {
    const wireBody = JSON.stringify({
      tools: [],
      system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: []
    });
    const canonical = buildCanonicalRequest(wireBody);
    const breakpoints = locateBreakpoints(wireBody, canonical.segments);
    expect(breakpoints[0]?.ttl).toBe("1h");
  });
  it("locates a tools-tier breakpoint declared on the last tool", () => {
    const wireBody = JSON.stringify({
      tools: [{ name: "search" }, { name: "lookup", cache_control: { type: "ephemeral" } }],
      system: [],
      messages: []
    });
    const canonical = buildCanonicalRequest(wireBody);
    const breakpoints = locateBreakpoints(wireBody, canonical.segments);
    expect(breakpoints).toHaveLength(1);
    expect(breakpoints[0]).toMatchObject({ tier: "tools", index: 1 });
  });
  it("locates a cache_control breakpoint on a message content block", () => {
    const wireBody = JSON.stringify({
      tools: [],
      system: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b", cache_control: { type: "ephemeral" } }
          ]
        }
      ]
    });
    const canonical = buildCanonicalRequest(wireBody);
    const breakpoints = locateBreakpoints(wireBody, canonical.segments);
    expect(breakpoints).toHaveLength(1);
    expect(breakpoints[0]).toMatchObject({ tier: "messages", index: 1, ttl: "5m" });
  });
  it("returns an empty array when no cache_control is declared", () => {
    const wireBody = JSON.stringify({ tools: [], system: "hi", messages: [] });
    const canonical = buildCanonicalRequest(wireBody);
    expect(locateBreakpoints(wireBody, canonical.segments)).toEqual([]);
  });
  it("returns an empty array when the wire-body isn't valid JSON", () => {
    expect(locateBreakpoints("not json", [])).toEqual([]);
  });
  it("returns an empty array when the wire-body doesn't parse to an object", () => {
    expect(locateBreakpoints("null", [])).toEqual([]);
  });
});
