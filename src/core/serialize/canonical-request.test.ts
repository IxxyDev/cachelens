import { describe, expect, it } from "vitest";
import { locateBreakpoints } from "../breakpoints/locate.js";
import { diffPrefix } from "../diff/prefix-diff.js";
import { byteOffset } from "../model/types.js";
import type { CanonicalRequest } from "./canonical-request.js";
import {
  buildCanonicalRequest,
  CanonicalRequestParseError,
  canonicalPrefixComparisonText
} from "./canonical-request.js";
import {
  byteLengthUtf8,
  type Segment,
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
  it("strips cache_control markers from tools, system blocks, content blocks and the top level", () => {
    const canonical = buildCanonicalRequest(
      JSON.stringify({
        cache_control: { type: "ephemeral" },
        tools: [{ name: "search", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]
          }
        ]
      })
    );
    expect(canonical.text).not.toContain("cache_control");
    expect(sliceByBytes(canonical.text, ...range(canonical, "tools[0]"))).toBe('{"name":"search"}');
    expect(sliceByBytes(canonical.text, ...range(canonical, "system[0]"))).toBe(
      '{"text":"sys","type":"text"}'
    );
    expect(sliceByBytes(canonical.text, ...range(canonical, "messages[0].content[0]"))).toBe(
      '{"text":"hi","type":"text"}'
    );
  });
  it("treats two requests that differ only in breakpoint position as prefix-identical", () => {
    const body = (markedIndex: number) =>
      JSON.stringify({
        tools: [],
        system: [{ type: "text", text: "sys" }],
        messages: ["a", "b", "c"].map((text, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: [
            {
              type: "text",
              text,
              ...(i === markedIndex ? { cache_control: { type: "ephemeral" } } : {})
            }
          ]
        }))
      });
    const previous = buildCanonicalRequest(body(1));
    const current = buildCanonicalRequest(body(2));
    const result = diffPrefix(
      canonicalPrefixComparisonText(previous),
      canonicalPrefixComparisonText(current)
    );
    expect(result.identical).toBe(true);
  });
  it("sorts structural keys at every level so their order alone never changes the text", () => {
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const input = { q: "x", limit: 3 };
    const a = buildCanonicalRequest(
      JSON.stringify({
        tools: [{ name: "search", description: "d", input_schema: schema }],
        system: [{ type: "text", text: "s" }],
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "search", input }]
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "r" }] },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }
            ]
          }
        ]
      })
    );
    const b = buildCanonicalRequest(
      JSON.stringify({
        messages: [
          {
            content: [{ input, name: "search", id: "t1", type: "tool_use" }],
            role: "assistant"
          },
          {
            content: [
              { content: [{ text: "r", type: "text" }], tool_use_id: "t1", type: "tool_result" },
              { source: { data: "AA", media_type: "image/png", type: "base64" }, type: "image" }
            ],
            role: "user"
          }
        ],
        system: [{ text: "s", type: "text" }],
        tools: [{ input_schema: schema, description: "d", name: "search" }]
      })
    );
    expect(a.text).toBe(b.text);
  });
  it("keeps the key order of opaque payloads the server renders as JSON text", () => {
    const body = (
      schema: Record<string, unknown>,
      input: Record<string, unknown>,
      resultContent: Record<string, unknown>
    ) =>
      buildCanonicalRequest(
        JSON.stringify({
          tools: [{ name: "search", input_schema: schema }],
          system: [],
          messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input }] },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "t1", content: resultContent }]
            }
          ]
        })
      );
    const base = body({ type: "object", properties: {} }, { q: "x", limit: 3 }, { a: 1, b: 2 });
    const schemaDrift = body(
      { properties: {}, type: "object" },
      { q: "x", limit: 3 },
      { a: 1, b: 2 }
    );
    const inputDrift = body(
      { type: "object", properties: {} },
      { limit: 3, q: "x" },
      { a: 1, b: 2 }
    );
    const resultDrift = body(
      { type: "object", properties: {} },
      { q: "x", limit: 3 },
      { b: 2, a: 1 }
    );
    expect(base.text).toContain('"input_schema":{"type":"object","properties":{}}');
    expect(base.text).toContain('"input":{"q":"x","limit":3}');
    expect(schemaDrift.text).not.toBe(base.text);
    expect(inputDrift.text).not.toBe(base.text);
    expect(resultDrift.text).not.toBe(base.text);
  });
  it("keeps array element order", () => {
    const a = buildCanonicalRequest(
      JSON.stringify({ tools: [{ name: "a" }, { name: "b" }], system: [], messages: [] })
    );
    const b = buildCanonicalRequest(
      JSON.stringify({ tools: [{ name: "b" }, { name: "a" }], system: [], messages: [] })
    );
    expect(a.text).not.toBe(b.text);
  });
  it("pads redaction placeholders so a redacted body keeps the raw body's byte length and breakpoints", () => {
    const placeholder = (text: string, hash: string) => `[R:${hash}:${byteLengthUtf8(text)}]`;
    const texts = {
      description: "Searches the internal knowledge base for documents.",
      system: "You are a careful assistant. Ответы — кратко. 回答は簡潔に。",
      user: "Please summarize the quarterly report and list three risks.",
      short: "ok"
    };
    const body = (leaf: (text: string, hash: string) => string) =>
      JSON.stringify({
        tools: [{ name: "search", description: leaf(texts.description, "0000000a") }],
        system: [
          {
            type: "text",
            text: leaf(texts.system, "0000000b"),
            cache_control: { type: "ephemeral" }
          }
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: leaf(texts.user, "0000000c") },
              {
                type: "text",
                text: leaf(texts.short, "0000000d"),
                cache_control: { type: "ephemeral" }
              }
            ]
          }
        ]
      });
    const rawBody = body((text) => text);
    const redactedBody = body(placeholder);
    const raw = buildCanonicalRequest(rawBody);
    const redacted = buildCanonicalRequest(redactedBody);
    expect(redacted.text).toContain(`"[R:0000000a:${byteLengthUtf8(texts.description)}]_`);
    expect(redacted.text).toContain('"[R:0000000d:2]"');
    const shortPlaceholderGrowth = byteLengthUtf8('"[R:0000000d:2]"') - byteLengthUtf8('"ok"');
    expect(redacted.byteLength).toBe(raw.byteLength + shortPlaceholderGrowth);
    const rawBreakpoints = locateBreakpoints(rawBody, raw.segments);
    const redactedBreakpoints = locateBreakpoints(redactedBody, redacted.segments);
    expect(redactedBreakpoints[0]?.byteOffset).toBe(rawBreakpoints[0]?.byteOffset);
    expect(redactedBreakpoints[1]?.byteOffset).toBe(
      (rawBreakpoints[1]?.byteOffset ?? 0) + shortPlaceholderGrowth
    );
    for (const path of ["tools", "system", "system[0].text", "messages[0].content[0]"]) {
      const rawSegment = requireSegment(raw, path);
      const redactedSegment = requireSegment(redacted, path);
      expect([redactedSegment.start, redactedSegment.end]).toEqual([
        rawSegment.start,
        rawSegment.end
      ]);
    }
  });
  it("gives a fully padded redacted body exactly the raw body's byte length", () => {
    const text = "A long enough user message to exceed the placeholder length.";
    const rawBody = JSON.stringify({ messages: [{ role: "user", content: text }] });
    const redactedBody = JSON.stringify({
      messages: [{ role: "user", content: `[R:12345678:${byteLengthUtf8(text)}]` }]
    });
    expect(buildCanonicalRequest(redactedBody).byteLength).toBe(
      buildCanonicalRequest(rawBody).byteLength
    );
  });
  it("keeps two different redaction placeholders distinct after padding", () => {
    const body = (hash: string) =>
      JSON.stringify({
        tools: [],
        system: [{ type: "text", text: `[R:${hash}:200]` }],
        messages: []
      });
    const a = buildCanonicalRequest(body("aaaaaaaa"));
    const b = buildCanonicalRequest(body("bbbbbbbb"));
    expect(a.byteLength).toBe(b.byteLength);
    const result = diffPrefix(a.text, b.text);
    expect(result.identical).toBe(false);
    expect(structuralPathAt(b.segments, result.divergenceByteOffset)).toBe("system[0].text");
  });
  it("leaves strings that merely resemble a placeholder untouched", () => {
    const canonical = buildCanonicalRequest(
      JSON.stringify({
        tools: [],
        system: "see [R:xyz:200] and [R:12345678:200] here",
        messages: []
      })
    );
    expect(canonical.text).toContain('"see [R:xyz:200] and [R:12345678:200] here"');
  });
});
function range(canonical: CanonicalRequest, structuralPath: string) {
  const segment = requireSegment(canonical, structuralPath);
  return [segment.start, segment.end] as const;
}
