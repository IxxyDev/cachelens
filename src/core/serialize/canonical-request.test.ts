import { describe, expect, it } from "vitest";
import { byteOffset } from "../model/types.js";
import { CanonicalRequestParseError, buildCanonicalRequest } from "./canonical-request.js";
import type { CanonicalRequest } from "./canonical-request.js";
import {
  type Segment,
  byteLengthUtf8,
  sliceByBytes,
  structuralPathAt,
  tierAt
} from "./segment-map.js";
function requireSegment(canonical: CanonicalRequest, structuralPath: string): Segment {
  const segment = canonical.segments.find((s) => s.structuralPath === structuralPath);
  if (!segment) throw new Error(`expected a "${structuralPath}" segment`);
  return segment;
}
function systemTierText(canonical: CanonicalRequest): string {
  const segment = requireSegment(canonical, "system");
  return sliceByBytes(canonical.text, segment.start, segment.end);
}
describe("buildCanonicalRequest", () => {
  it("throws CanonicalRequestParseError on invalid JSON", () => {
    expect(() => buildCanonicalRequest("not json")).toThrow(CanonicalRequestParseError);
  });
  it("throws CanonicalRequestParseError when the wire-body doesn't parse to an object", () => {
    expect(() => buildCanonicalRequest("null")).toThrow(CanonicalRequestParseError);
    expect(() => buildCanonicalRequest('"a string"')).toThrow(CanonicalRequestParseError);
  });
  it("passes through a non-object system block unchanged (defensive, malformed input)", () => {
    const canonical = buildCanonicalRequest(
      JSON.stringify({ tools: [], system: ["plain string block"], messages: [] })
    );
    const block0 = requireSegment(canonical, "system[0]");
    expect(sliceByBytes(canonical.text, block0.start, block0.end)).toBe('"plain string block"');
  });
  it("orders segments tools -> system -> messages", () => {
    const wireBody = JSON.stringify({
      model: "claude-sonnet-4-5",
      tools: [{ name: "search" }],
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }]
    });
    const canonical = buildCanonicalRequest(wireBody);
    const tools = requireSegment(canonical, "tools");
    const system = requireSegment(canonical, "system");
    const messages = requireSegment(canonical, "messages");
    expect(tools.start).toBe(0);
    expect(tools.end).toBeLessThanOrEqual(system.start);
    expect(system.end).toBeLessThanOrEqual(messages.start);
    expect(messages.end).toBe(canonical.byteLength);
  });
  it("tracks per-block and per-text-leaf offsets within an array system", () => {
    const timestamp = "2026-07-24T10:00:00Z";
    const text = `You are an agent. Current time: ${timestamp}. Be concise.`;
    const wireBody = JSON.stringify({
      model: "claude-sonnet-4-5",
      tools: [],
      system: [{ type: "text", text }],
      messages: []
    });
    const canonical = buildCanonicalRequest(wireBody);
    const block0 = requireSegment(canonical, "system[0]");
    const block0Text = requireSegment(canonical, "system[0].text");
    expect(block0).toBeDefined();
    const decoded = sliceByBytes(canonical.text, block0Text.start, block0Text.end);
    expect(decoded).toBe(JSON.stringify(text));
    const timestampByteOffset = byteOffset(
      byteLengthUtf8(canonical.text.slice(0, canonical.text.indexOf(timestamp)))
    );
    expect(tierAt(canonical.segments, timestampByteOffset)).toBe("system");
    expect(structuralPathAt(canonical.segments, timestampByteOffset)).toBe("system[0].text");
  });
  it("uses a fixed canonical key order for system blocks regardless of source order", () => {
    const a = buildCanonicalRequest(
      JSON.stringify({ tools: [], system: [{ text: "hi", type: "text" }], messages: [] })
    );
    const b = buildCanonicalRequest(
      JSON.stringify({ tools: [], system: [{ type: "text", text: "hi" }], messages: [] })
    );
    expect(systemTierText(a)).toBe(systemTierText(b));
  });
  it("tracks per-message and per-content-block segments within messages", () => {
    const wireBody = JSON.stringify({
      tools: [],
      system: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
          ]
        }
      ]
    });
    const canonical = buildCanonicalRequest(wireBody);
    const message0 = requireSegment(canonical, "messages[0]");
    const block0 = requireSegment(canonical, "messages[0].content[0]");
    const block1 = requireSegment(canonical, "messages[0].content[1]");
    expect(block0.tier).toBe("messages");
    expect(block1.tier).toBe("messages");
    expect(block0.end).toBeLessThanOrEqual(block1.start);
    expect(block1.end).toBeLessThanOrEqual(message0.end);
    const decodedBlock1 = sliceByBytes(canonical.text, block1.start, block1.end);
    expect(JSON.parse(decodedBlock1)).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" }
    });
  });
  it("counts multiple messages and blocks independently for lookback-style counting", () => {
    const wireBody = JSON.stringify({
      tools: [],
      system: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" }
          ]
        },
        { role: "assistant", content: [{ type: "text", text: "c" }] }
      ]
    });
    const canonical = buildCanonicalRequest(wireBody);
    const blockSegments = canonical.segments.filter((s) =>
      /content\[\d+\]$/.test(s.structuralPath)
    );
    expect(blockSegments).toHaveLength(3);
  });
  it("passes through a non-array messages field unchanged (defensive, malformed input)", () => {
    const canonical = buildCanonicalRequest(
      JSON.stringify({ tools: [], system: [], messages: "not an array" })
    );
    const messagesSegment = requireSegment(canonical, "messages");
    expect(sliceByBytes(canonical.text, messagesSegment.start, messagesSegment.end)).toBe(
      '"not an array"'
    );
  });
  it("passes through a non-object message entry unchanged (defensive, malformed input)", () => {
    const canonical = buildCanonicalRequest(
      JSON.stringify({ tools: [], system: [], messages: ["plain string message"] })
    );
    const message0 = requireSegment(canonical, "messages[0]");
    expect(sliceByBytes(canonical.text, message0.start, message0.end)).toBe(
      '"plain string message"'
    );
  });
  it("leaves a plain-string message content unsegmented (no content[] blocks)", () => {
    const wireBody = JSON.stringify({
      tools: [],
      system: [],
      messages: [{ role: "user", content: "hi" }]
    });
    const canonical = buildCanonicalRequest(wireBody);
    expect(canonical.segments.some((s) => s.structuralPath.includes(".content["))).toBe(false);
  });
});
