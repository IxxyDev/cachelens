import { describe, expect, it } from "vitest";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import { sliceByBytes } from "../serialize/segment-map.js";
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
  it("places each explicit breakpoint at the end of its block in the marker-free canonical text", () => {
    const wireBody = JSON.stringify({
      tools: [{ name: "search", cache_control: { type: "ephemeral" } }, { name: "lookup" }],
      system: [
        { type: "text", text: "static", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "dynamic" }
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a", cache_control: { type: "ephemeral" } },
            { type: "text", text: "b" }
          ]
        }
      ]
    });
    const canonical = buildCanonicalRequest(wireBody);
    expect(canonical.text).not.toContain("cache_control");
    const breakpoints = locateBreakpoints(wireBody, canonical.segments);
    const prefixUpTo = (offset: number) =>
      sliceByBytes(canonical.text, 0 as never, offset as never);
    expect(breakpoints.map((bp) => [bp.tier, bp.kind, bp.ttl])).toEqual([
      ["tools", "explicit", "5m"],
      ["system", "explicit", "1h"],
      ["messages", "explicit", "5m"]
    ]);
    const [tools, system, messages] = breakpoints;
    expect(prefixUpTo(tools?.byteOffset ?? 0)).toBe('[{"name":"search"}');
    expect(prefixUpTo(system?.byteOffset ?? 0).endsWith('{"text":"static","type":"text"}')).toBe(
      true
    );
    expect(
      prefixUpTo(messages?.byteOffset ?? 0).endsWith('"content":[{"text":"a","type":"text"}')
    ).toBe(true);
  });
  it("records a top-level cache_control as an automatic breakpoint at the last block", () => {
    const wireBody = JSON.stringify({
      cache_control: { type: "ephemeral", ttl: "1h" },
      tools: [{ name: "search" }],
      system: [{ type: "text", text: "s" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "b" },
            { type: "text", text: "c" }
          ]
        }
      ]
    });
    const canonical = buildCanonicalRequest(wireBody);
    const breakpoints = locateBreakpoints(wireBody, canonical.segments);
    expect(breakpoints).toHaveLength(1);
    const last = canonical.segments.find((s) => s.structuralPath === "messages[1].content[1]");
    expect(breakpoints[0]).toEqual({
      byteOffset: last?.end,
      index: 1,
      ttl: "1h",
      tier: "messages",
      kind: "automatic"
    });
  });
  it("places an automatic breakpoint on the last message when its content is a plain string", () => {
    const wireBody = JSON.stringify({
      cache_control: { type: "ephemeral" },
      tools: [],
      system: "s",
      messages: [{ role: "user", content: "hi" }]
    });
    const canonical = buildCanonicalRequest(wireBody);
    const [breakpoint] = locateBreakpoints(wireBody, canonical.segments);
    const message = canonical.segments.find((s) => s.structuralPath === "messages[0]");
    expect(breakpoint).toMatchObject({ kind: "automatic", tier: "messages", index: 0 });
    expect(breakpoint?.byteOffset).toBe(message?.end);
  });
});
