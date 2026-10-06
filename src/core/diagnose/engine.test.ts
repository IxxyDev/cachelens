import { describe, expect, it } from "vitest";
import { diffPrefix } from "../diff/prefix-diff.js";
import type { LlmCall, RequestParams, Usage } from "../model/call.js";
import { byteOffset, tokenCount } from "../model/types.js";
import { hashPrefix } from "../pricing/count-tokens.js";
import {
  buildCanonicalRequest,
  canonicalPrefixComparisonText
} from "../serialize/canonical-request.js";
import { sliceByBytes } from "../serialize/segment-map.js";
import { diagnoseCall, unparseableRequestWarnings } from "./engine.js";

const GAP_MS = 5000;
function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: tokenCount(0),
    outputTokens: tokenCount(0),
    cacheCreationInputTokens: tokenCount(0),
    cacheReadInputTokens: tokenCount(0),
    ...overrides
  };
}
function makeCall(params: {
  readonly wireBody: unknown;
  readonly timestamp: number;
  readonly usage?: Partial<Usage>;
  readonly requestParams?: Partial<RequestParams>;
}): LlmCall {
  return {
    id: `call-${params.timestamp}`,
    sessionId: "session-1",
    stepName: "step",
    timestamp: params.timestamp,
    params: { model: "claude-sonnet-4-5", ...params.requestParams },
    payload: { wireBody: JSON.stringify(params.wireBody) },
    usage: makeUsage(params.usage)
  };
}
describe("diagnoseCall", () => {
  it("returns cold-start when there is no previous call", () => {
    const current = makeCall({ wireBody: { tools: [], system: "hi", messages: [] }, timestamp: 0 });
    expect(diagnoseCall(undefined, current)).toEqual({ kind: "cold-start" });
  });
  it("returns gap-exceeds-max-ttl end-to-end when the gap to the last touch exceeds max TTL", () => {
    const wireBody = { tools: [], system: "hi", messages: [] };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: 60 * 60 * 1000 + 1,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    expect(diagnoseCall(previous, current)).toEqual({ kind: "gap-exceeds-max-ttl" });
  });
  it("uses a shorter, provider-appropriate default max TTL for openai than anthropic", () => {
    const wireBody = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) },
      requestParams: { model: "gpt-4o" }
    });
    const current = makeCall({
      wireBody,
      timestamp: 15 * 60 * 1000,
      usage: { cacheCreationInputTokens: tokenCount(300) },
      requestParams: { model: "gpt-4o" }
    });
    const openaiResult = diagnoseCall(
      { ...previous, provider: "openai" },
      { ...current, provider: "openai" }
    );
    expect(openaiResult).toEqual({ kind: "gap-exceeds-max-ttl" });
    const anthropicWireBody = { tools: [], system: "hi", messages: [] };
    const anthropicPrevious = makeCall({
      wireBody: anthropicWireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const anthropicCurrent = makeCall({
      wireBody: anthropicWireBody,
      timestamp: 15 * 60 * 1000,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const anthropicResult = diagnoseCall(anthropicPrevious, anthropicCurrent);
    expect(anthropicResult).not.toEqual({ kind: "gap-exceeds-max-ttl" });
  });
  it("an explicit maxTtlMs option still overrides the provider-specific default", () => {
    const wireBody = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) },
      requestParams: { model: "gpt-4o" }
    });
    const current = makeCall({
      wireBody,
      timestamp: 15 * 60 * 1000,
      usage: { cacheCreationInputTokens: tokenCount(300) },
      requestParams: { model: "gpt-4o" }
    });
    const result = diagnoseCall(
      { ...previous, provider: "openai" },
      { ...current, provider: "openai" },
      { maxTtlMs: 60 * 60 * 1000 }
    );
    expect(result).not.toEqual({ kind: "gap-exceeds-max-ttl" });
  });
  it("isolates a system-tier divergence from an unchanged tools tier", () => {
    const tools = [{ name: "search" }];
    const previous = makeCall({
      wireBody: { tools, system: [{ type: "text", text: "You are helpful." }], messages: [] },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(500) }
    });
    const current = makeCall({
      wireBody: { tools, system: [{ type: "text", text: "You are very helpful." }], messages: [] },
      timestamp: GAP_MS,
      usage: { cacheReadInputTokens: tokenCount(500), cacheCreationInputTokens: tokenCount(80) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.invalidatedTiers).toEqual(["system"]);
  });
  it("byte differences from multi-turn growth with a usage-confirmed full read are healthy-extension, not a miss", () => {
    const previous = makeCall({
      wireBody: { tools: [], system: "be helpful", messages: [{ role: "user", content: "hi" }] },
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(200) }
    });
    const current = makeCall({
      wireBody: {
        tools: [],
        system: "be helpful",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" }
        ]
      },
      timestamp: GAP_MS,
      usage: { cacheReadInputTokens: tokenCount(200), cacheCreationInputTokens: tokenCount(50) }
    });
    expect(diagnoseCall(previous, current)).toEqual({ kind: "healthy-extension" });
  });
  it("a model change invalidates all tiers even on a byte-identical prefix", () => {
    const wireBody = { tools: [], system: "x", messages: [{ role: "user", content: "hi" }] };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      requestParams: { model: "claude-sonnet-4-5" },
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: GAP_MS,
      requestParams: { model: "claude-opus-4-8" },
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("request-param-invalidation");
    expect(result.diagnosis.invalidatedTiers).toEqual(["tools", "system", "messages"]);
  });
  it("a thinking change invalidates messages (tools/system only model-specific)", () => {
    const wireBody = {
      tools: [{ name: "search" }],
      system: "x",
      messages: [{ role: "user", content: "hi" }]
    };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      requestParams: { thinking: { type: "disabled" } },
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: GAP_MS,
      requestParams: { thinking: { type: "adaptive" } },
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("request-param-invalidation");
    expect(result.diagnosis.invalidatedTiers).toEqual(["messages"]);
  });
  it("moving the breakpoint to the latest message on a growing conversation is not a prefix change", () => {
    const turns = ["first question", "first answer", "second question"];
    const makeMessages = (count: number) =>
      turns.slice(0, count).map((text, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text,
            ...(i === count - 1 ? { cache_control: { type: "ephemeral" } } : {})
          }
        ]
      }));
    const system = [{ type: "text", text: "S".repeat(4200), cache_control: { type: "ephemeral" } }];
    const previous = makeCall({
      wireBody: { tools: [], system, messages: makeMessages(1) },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(1100), cacheCreationInputTokens: tokenCount(10) }
    });
    const current = makeCall({
      wireBody: { tools: [], system, messages: makeMessages(3) },
      timestamp: GAP_MS,
      usage: { cacheReadInputTokens: tokenCount(1110), cacheCreationInputTokens: tokenCount(20) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).not.toBe("diagnosis");
  });
  it("detects nondeterministic-serialization when only tool key order differs", () => {
    const makeTools = (schema: Record<string, unknown>) => [
      { name: "search", description: "x", input_schema: schema }
    ];
    const previous = makeCall({
      wireBody: {
        tools: makeTools({ type: "object", properties: { q: { type: "string" } } }),
        system: "s",
        messages: []
      },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: {
        tools: makeTools({ properties: { q: { type: "string" } }, type: "object" }),
        system: "s",
        messages: []
      },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("nondeterministic-serialization");
    expect(result.diagnosis.invalidatedTiers).toEqual(["tools"]);
  });
  it("structural tool key order alone does not diverge the prefix", () => {
    const previous = makeCall({
      wireBody: { tools: [{ name: "search", description: "x" }], system: "s", messages: [] },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: { tools: [{ description: "x", name: "search" }], system: "s", messages: [] },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("unclassified-miss");
  });
  it("detects nondeterministic-serialization when only a tool_use input's key order differs", () => {
    const makeMessages = (input: Record<string, unknown>) => [
      { role: "user", content: [{ type: "text", text: "find x" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system: "s", messages: makeMessages({ q: "x", limit: 3 }) },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: { tools: [], system: "s", messages: makeMessages({ limit: 3, q: "x" }) },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("nondeterministic-serialization");
    expect(result.diagnosis.invalidatedTiers).toEqual(["messages"]);
    expect(result.diagnosis.structuralPath).toBe("messages[1].content[0]");
  });
  it("falls back to dynamic-prefix-content with an exact byteOffset and structuralPath for a timestamp change", () => {
    const previousTimestamp = "2026-07-24T10:00:00Z";
    const currentTimestamp = "2026-11-01T03:30:00Z";
    const makeSystem = (timestamp: string) => [
      { type: "text", text: `You are an agent. Current time: ${timestamp}. Be concise.` }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system: makeSystem(previousTimestamp), messages: [] },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: { tools: [], system: makeSystem(currentTimestamp), messages: [] },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("dynamic-prefix-content");
    expect(result.diagnosis.invalidatedTiers).toEqual(["system"]);
    expect(result.diagnosis.structuralPath).toBe("system[0].text");
    const currentCanonical = buildCanonicalRequest(current.payload.wireBody);
    const divergingSubstring = `Current time: ${previousTimestamp.slice(0, 5)}`;
    const expectedByteOffset =
      new TextEncoder().encode(
        currentCanonical.text.slice(0, currentCanonical.text.indexOf(divergingSubstring))
      ).length + new TextEncoder().encode(divergingSubstring).length;
    expect(result.diagnosis.byteOffset).toBe(expectedByteOffset);
    expect(result.diagnosis.excerpt).toContain("2026-11-01");
  });
  it("describes a tool_choice change in the diagnosis excerpt", () => {
    const wireBody = { tools: [{ name: "search" }], system: "x", messages: [] };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      requestParams: { toolChoice: "auto" },
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: GAP_MS,
      requestParams: { toolChoice: "any" },
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.excerpt).toBe('tool_choice: "auto" -> "any"');
  });
  it("falls through to no-op when nothing matches the gate's short-circuits or either miss signature", () => {
    const previous = makeCall({
      wireBody: {
        tools: [],
        system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
        messages: []
      },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: {
        tools: [],
        system: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }],
        messages: []
      },
      timestamp: GAP_MS
    });
    expect(diagnoseCall(previous, current)).toEqual({ kind: "no-op" });
  });
  it("signature-2 on a breakpoint far below the min-cacheable size is prefix-too-short, estimated from bytes", () => {
    const wireBody = {
      tools: [],
      system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
      messages: []
    };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({ wireBody, timestamp: GAP_MS });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("prefix-too-short");
    expect(result.diagnosis.wastedEstimate).toBe(true);
    expect(result.diagnosis.recommendation).toContain("estimated from bytes");
  });
  it("returns an unclassified-miss, and reports it to onUnclassifiedMiss, when a signature-2 miss on a long enough prefix matches no cause", () => {
    const wireBody = {
      tools: [],
      system: [{ type: "text", text: "S".repeat(4200), cache_control: { type: "ephemeral" } }],
      messages: []
    };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(1050) }
    });
    const current = makeCall({ wireBody, timestamp: GAP_MS });
    const reported: string[] = [];
    const result = diagnoseCall(previous, current, {
      onUnclassifiedMiss: (call, signature) => reported.push(`${call.id}:${signature}`)
    });
    expect(result).toEqual({ kind: "unclassified-miss", signature: "signature-2" });
    expect(reported).toEqual([`${current.id}:signature-2`]);
  });
  it("ttl-expiry when the gap to the last touch exceeds the declared 5m ttl", () => {
    const wireBody = {
      tools: [],
      system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
      messages: []
    };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: 6 * 60 * 1000,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("ttl-expiry");
    expect(result.diagnosis.invalidatedTiers).toEqual(["tools", "system", "messages"]);
  });
  it("control: a 2m gap under the declared 5m ttl is not ttl-expiry", () => {
    const wireBody = {
      tools: [],
      system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
      messages: []
    };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: 2 * 60 * 1000,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).not.toBe("diagnosis");
    expect(result).toEqual({ kind: "unclassified-miss", signature: "signature-1" });
  });
  it("a genuine tool-set change is tools-tier-drift, invalidating all tiers", () => {
    const previous = makeCall({
      wireBody: { tools: [{ name: "search" }], system: "x", messages: [] },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: { tools: [{ name: "search" }, { name: "lookup" }], system: "x", messages: [] },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("tools-tier-drift");
    expect(result.diagnosis.invalidatedTiers).toEqual(["tools", "system", "messages"]);
  });
  it("a changed image block is content-block-churn, not the generic fallback", () => {
    const makeMessages = (data: string) => [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }]
      }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system: [], messages: makeMessages("AAAA") },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: { tools: [], system: [], messages: makeMessages("BBBB") },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("content-block-churn");
    expect(result.diagnosis.structuralPath).toBe("messages[0].content[0]");
    expect(result.diagnosis.invalidatedTiers).toEqual(["messages"]);
  });
  it("more than 20 content blocks before the breakpoint is lookback-window-exceeded", () => {
    const FILLER_COUNT = 25;
    const makeContent = (firstBlockText: string) => {
      const blocks = [{ type: "text", text: firstBlockText }];
      for (let i = 0; i < FILLER_COUNT; i++) {
        const isLast = i === FILLER_COUNT - 1;
        blocks.push({
          type: "text",
          text: `filler-${i}`,
          ...(isLast ? { cache_control: { type: "ephemeral" } } : {})
        });
      }
      return blocks;
    };
    const previous = makeCall({
      wireBody: {
        tools: [],
        system: [],
        messages: [{ role: "user", content: makeContent("a") }]
      },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: {
        tools: [],
        system: [],
        messages: [{ role: "user", content: makeContent("b") }]
      },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("lookback-window-exceeded");
    expect(result.diagnosis.excerpt).toContain("25 content blocks");
  });
  it("the same lookback-window-exceeded fixture falls through to dynamic-prefix-content for provider: openai", () => {
    const FILLER_COUNT = 25;
    const makeContent = (firstBlockText: string) => {
      const blocks = [{ type: "text", text: firstBlockText }];
      for (let i = 0; i < FILLER_COUNT; i++) {
        const isLast = i === FILLER_COUNT - 1;
        blocks.push({
          type: "text",
          text: `filler-${i}`,
          ...(isLast ? { cache_control: { type: "ephemeral" } } : {})
        });
      }
      return blocks;
    };
    const previous = makeCall({
      wireBody: {
        tools: [],
        system: [],
        messages: [{ role: "user", content: makeContent("a") }]
      },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: {
        tools: [],
        system: [],
        messages: [{ role: "user", content: makeContent("b") }]
      },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(
      { ...previous, provider: "openai" },
      { ...current, provider: "openai" }
    );
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("dynamic-prefix-content");
  });
  it("an OpenAI-shaped call with no cache_control at all still gets dynamic-prefix-content via the openai miss signature", () => {
    const stableSystemPrompt = "You are a helpful assistant. ".repeat(150);
    const makeBody = (dynamicSuffix: string) => ({
      model: "gpt-4o",
      messages: [
        { role: "system", content: stableSystemPrompt },
        { role: "user", content: `current time: ${dynamicSuffix}` }
      ]
    });
    const zeroUsage = makeUsage();
    const previous = makeCall({
      wireBody: makeBody("2026-07-24T10:00:00Z"),
      timestamp: 0,
      usage: zeroUsage,
      requestParams: { model: "gpt-4o" }
    });
    const current = makeCall({
      wireBody: makeBody("2026-07-24T11:00:00Z"),
      timestamp: GAP_MS,
      usage: zeroUsage,
      requestParams: { model: "gpt-4o" }
    });
    const result = diagnoseCall(
      { ...previous, provider: "openai" },
      { ...current, provider: "openai" }
    );
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("dynamic-prefix-content");
  });
  it("prefix-too-short when a supplied count_tokens result is below the model minimum", () => {
    const wireBody = {
      tools: [],
      system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      messages: []
    };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: 1000,
      usage: { cacheCreationInputTokens: tokenCount(50) }
    });
    const canonicalPrevious = buildCanonicalRequest(previous.payload.wireBody);
    const canonicalCurrent = buildCanonicalRequest(current.payload.wireBody);
    const prefixDiff = diffPrefix(
      canonicalPrefixComparisonText(canonicalPrevious),
      canonicalPrefixComparisonText(canonicalCurrent)
    );
    const stablePrefixText = sliceByBytes(
      canonicalCurrent.text,
      byteOffset(0),
      prefixDiff.divergenceByteOffset
    );
    const confirmedPrefixTokenCounts = new Map([[hashPrefix(stablePrefixText), tokenCount(50)]]);
    const result = diagnoseCall(previous, current, { confirmedPrefixTokenCounts });
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("prefix-too-short");
    expect(result.diagnosis.invalidatedTiers).toEqual(["tools", "system", "messages"]);
  });
  it("multibyte regression: prefix-too-short's hash lookup matches with multibyte content before the divergence", () => {
    const wireBody = (tail: string) => ({
      tools: [],
      system: [
        {
          type: "text",
          text: "☕☕☕☕☕ stable instructions",
          cache_control: { type: "ephemeral" }
        },
        { type: "text", text: tail }
      ],
      messages: []
    });
    const previous = makeCall({
      wireBody: wireBody("X"),
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: wireBody("Y"),
      timestamp: 1000,
      usage: { cacheCreationInputTokens: tokenCount(50) }
    });
    const canonicalCurrent = buildCanonicalRequest(current.payload.wireBody);
    const canonicalPrevious = buildCanonicalRequest(previous.payload.wireBody);
    const prefixDiff = diffPrefix(
      canonicalPrefixComparisonText(canonicalPrevious),
      canonicalPrefixComparisonText(canonicalCurrent)
    );
    expect(prefixDiff.divergenceByteOffset).toBeGreaterThan(30);
    const stablePrefixText = sliceByBytes(
      canonicalCurrent.text,
      byteOffset(0),
      prefixDiff.divergenceByteOffset
    );
    const confirmedPrefixTokenCounts = new Map([[hashPrefix(stablePrefixText), tokenCount(50)]]);
    const result = diagnoseCall(previous, current, { confirmedPrefixTokenCounts });
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("prefix-too-short");
  });
  it("offline control: without a confirmed token count, prefix-too-short is skipped rather than guessed", () => {
    const wireBody = {
      tools: [],
      system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      messages: []
    };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: 1000,
      usage: { cacheCreationInputTokens: tokenCount(50) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).not.toBe("diagnosis");
  });
  // Vendor reasoning for breakpoint-misplacement: the cache stores the prefix up to each
  // breakpoint, and breakpoints only sit at block ends. If cache_read is 0, even the content
  // BEFORE the breakpoint missed, so moving the breakpoint cannot be the cause (the old rule fired
  // here because the next block's JSON scaffolding is always byte-identical). Misplacement needs
  // a partial hit (cache_read > 0) plus at least one whole stable block after the last breakpoint.
  it("read == 0: a breakpoint before a dynamic block is NOT misplacement — the dynamic content is the cause", () => {
    const longStableText = "S".repeat(4200);
    const makeSystem = (tail: string) => [
      { type: "text", text: longStableText, cache_control: { type: "ephemeral" } },
      { type: "text", text: tail }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system: makeSystem("tail-a"), messages: [] },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: { tools: [], system: makeSystem("tail-b"), messages: [] },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("dynamic-prefix-content");
    expect(result.diagnosis.structuralPath).toBe("system[1].text");
  });
  it("a partial read with a whole stable block after the breakpoint is breakpoint-misplacement, snapped to that block's end", () => {
    const makeSystem = (tail: string) => [
      { type: "text", text: "S".repeat(4200), cache_control: { type: "ephemeral" } },
      { type: "text", text: "M".repeat(300) },
      { type: "text", text: `Current time: ${tail}` }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system: makeSystem("2026-07-24T10:00:00Z"), messages: [] },
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(1050) }
    });
    const current = makeCall({
      wireBody: { tools: [], system: makeSystem("2026-11-01T03:30:00Z"), messages: [] },
      timestamp: GAP_MS,
      usage: { cacheReadInputTokens: tokenCount(1050), cacheCreationInputTokens: tokenCount(90) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("breakpoint-misplacement");
    expect(result.diagnosis.invalidatedTiers).toEqual(["system"]);
    expect(result.diagnosis.structuralPath).toBe("system[1]");
    const middle = buildCanonicalRequest(current.payload.wireBody).segments.find(
      (s) => s.structuralPath === "system[1]"
    );
    expect(result.diagnosis.byteOffset).toBe(middle?.end);
    expect(result.diagnosis.recommendation).toContain("Move the cache breakpoint");
  });
  it("overlap: breakpoint-misplacement wins over dynamic-prefix-content when the misplacement signature (read > 0) holds", () => {
    const makeSystem = (iso: string) => [
      { type: "text", text: "S".repeat(4200), cache_control: { type: "ephemeral" } },
      { type: "text", text: "stable instructions ".repeat(20) },
      { type: "text", text: `Current time: ${iso}` }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system: makeSystem("2026-07-24T10:00:00Z"), messages: [] },
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(1100) }
    });
    const current = makeCall({
      wireBody: { tools: [], system: makeSystem("2026-11-01T03:30:00Z"), messages: [] },
      timestamp: GAP_MS,
      usage: { cacheReadInputTokens: tokenCount(1050), cacheCreationInputTokens: tokenCount(100) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("breakpoint-misplacement");
  });
  it("overlap: nondeterministic-serialization wins over a misplacement-shaped signature", () => {
    const longStableText = "S".repeat(4200);
    const system = [{ type: "text", text: longStableText, cache_control: { type: "ephemeral" } }];
    const makeMessages = (schemaLikeInput: Record<string, unknown>) => [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "search", input: schemaLikeInput }]
      }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system, messages: makeMessages({ a: 1, b: 2 }) },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: { tools: [], system, messages: makeMessages({ b: 2, a: 1 }) },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("nondeterministic-serialization");
    expect(result.diagnosis.invalidatedTiers).toEqual(["messages"]);
  });
  it("ttl-expiry on a growing conversation: 10-minute gap, 5m TTL, appended turn is ttl-expiry, not breakpoint-misplacement", () => {
    const system = [{ type: "text", text: "S".repeat(4200), cache_control: { type: "ephemeral" } }];
    const firstTurn = { role: "user", content: [{ type: "text", text: "first question" }] };
    const previous = makeCall({
      wireBody: { tools: [], system, messages: [firstTurn] },
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(1100) }
    });
    const current = makeCall({
      wireBody: {
        tools: [],
        system,
        messages: [
          firstTurn,
          { role: "assistant", content: [{ type: "text", text: "first answer" }] },
          { role: "user", content: [{ type: "text", text: "second question" }] }
        ]
      },
      timestamp: 10 * 60 * 1000,
      usage: { cacheCreationInputTokens: tokenCount(1150) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("ttl-expiry");
    // Only the 1100 tokens the expired entry held are waste; the 50 appended had to be written.
    expect(result.diagnosis.wastedTokens).toBe(1100);
  });
  // Audit M11: a loop whose breakpoint sits on a too-short prefix never activates caching (read 0,
  // creation 0 every turn). The gate routes it to signature-2; with no count_tokens result the
  // byte size up to the breakpoint is the evidence, so it is reported as an estimated
  // prefix-too-short instead of being dropped as an unclassified miss (0 findings, exit 0).
  it("a multi-turn loop that never activated caching (breakpoint declared, read 0, creation 0) is an estimated prefix-too-short", () => {
    const system = [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }];
    const firstTurn = { role: "user", content: "hi" };
    const previous = makeCall({
      wireBody: { tools: [], system, messages: [firstTurn] },
      timestamp: 0
    });
    const current = makeCall({
      wireBody: { tools: [], system, messages: [firstTurn, { role: "assistant", content: "yo" }] },
      timestamp: GAP_MS
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("prefix-too-short");
    expect(result.diagnosis.wastedEstimate).toBe(true);
    const breakpointEnd = buildCanonicalRequest(current.payload.wireBody).segments.find(
      (s) => s.structuralPath === "system[0]"
    )?.end;
    expect(result.diagnosis.byteOffset).toBe(breakpointEnd);
  });
  it("an unparseable wire body is unparseable-request, checked before the cold-start return", () => {
    const broken: LlmCall = {
      ...makeCall({ wireBody: {}, timestamp: GAP_MS }),
      payload: { wireBody: "{not json" }
    };
    expect(diagnoseCall(undefined, broken)).toEqual({ kind: "unparseable-request" });
    const previous = makeCall({ wireBody: { tools: [], system: "x", messages: [] }, timestamp: 0 });
    expect(diagnoseCall(previous, broken)).toEqual({ kind: "unparseable-request" });
  });
  it("unparseableRequestWarnings names each call with an unparseable wire body, and only those", () => {
    const ok = makeCall({ wireBody: { tools: [], system: "x", messages: [] }, timestamp: 0 });
    const broken: LlmCall = {
      ...makeCall({ wireBody: {}, timestamp: GAP_MS }),
      payload: { wireBody: "{not json" }
    };
    const warnings = unparseableRequestWarnings([ok, broken]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"${broken.id}"`);
  });
  it("an unparseable partner does not throw: the current call is treated as a cold start", () => {
    const broken: LlmCall = {
      ...makeCall({ wireBody: {}, timestamp: 0 }),
      payload: { wireBody: "{not json" }
    };
    const current = makeCall({
      wireBody: { tools: [], system: "x", messages: [] },
      timestamp: GAP_MS
    });
    expect(diagnoseCall(broken, current)).toEqual({ kind: "cold-start" });
  });
  it("signature-3: one early breakpoint on a growing conversation (read > 0, creation 0) is breakpoint-misplacement at a block boundary", () => {
    // Only the system prompt carries a breakpoint, so each turn reads the system prompt and
    // writes nothing; the stable earlier turns after it are re-billed as plain input.
    const system = [{ type: "text", text: "S".repeat(4200), cache_control: { type: "ephemeral" } }];
    const turn = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });
    const history = [
      turn("user", `first question ${"q".repeat(4200)}`),
      turn("assistant", `first answer ${"a".repeat(600)}`)
    ];
    const previous = makeCall({
      wireBody: { tools: [], system, messages: history },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(1050), inputTokens: tokenCount(1200) }
    });
    const current = makeCall({
      wireBody: { tools: [], system, messages: [...history, turn("user", "second question")] },
      timestamp: GAP_MS,
      usage: { cacheReadInputTokens: tokenCount(1050), inputTokens: tokenCount(1210) }
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("breakpoint-misplacement");
    expect(result.diagnosis.structuralPath).toBe("messages[1].content[0]");
    const lastStableBlock = buildCanonicalRequest(current.payload.wireBody).segments.find(
      (s) => s.structuralPath === "messages[1].content[0]"
    );
    expect(result.diagnosis.byteOffset).toBe(lastStableBlock?.end);
    // Nothing was written, so the waste is the stable input after the breakpoint, estimated.
    expect(result.diagnosis.wastedEstimate).toBe(true);
    expect(result.diagnosis.wastedTokens).toBeGreaterThan(0);
    expect(result.diagnosis.wastedTokens).toBeLessThanOrEqual(1210);
    expect(result.diagnosis.wastedUsd).toBeGreaterThan(0);
  });
  it("control: the same conversation with the breakpoint moved to the latest turn (appended turn written) stays healthy-extension", () => {
    const system = [{ type: "text", text: "S".repeat(4200) }];
    const turn = (role: string, text: string, cached = false) => ({
      role,
      content: [{ type: "text", text, ...(cached ? { cache_control: { type: "ephemeral" } } : {}) }]
    });
    const previous = makeCall({
      wireBody: {
        tools: [],
        system,
        messages: [turn("user", `first question ${"q".repeat(4200)}`, true)]
      },
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(2100) }
    });
    const current = makeCall({
      wireBody: {
        tools: [],
        system,
        messages: [
          turn("user", `first question ${"q".repeat(4200)}`),
          turn("assistant", "first answer"),
          turn("user", "second question", true)
        ]
      },
      timestamp: GAP_MS,
      usage: { cacheReadInputTokens: tokenCount(2100), cacheCreationInputTokens: tokenCount(10) }
    });
    expect(diagnoseCall(previous, current)).toEqual({ kind: "healthy-extension" });
  });
  it("near-simultaneous cold creations on an identical prefix are concurrent-cold-fill, not a diagnosis", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall({
      wireBody,
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody,
      timestamp: 500,
      usage: { cacheCreationInputTokens: tokenCount(300) }
    });
    expect(diagnoseCall(previous, current)).toEqual({ kind: "concurrent-cold-fill" });
  });
});
describe("min-cacheable threshold: token-count converted to a byte proxy", () => {
  it("a real ~300-token/~1.3KB gpt-4o prompt below the min-cacheable floor produces no diagnosis", () => {
    const shortStableText = "The quick brown fox jumps over the lazy dog. ".repeat(28);
    const makeBody = (tail: string) => ({
      model: "gpt-4o",
      messages: [
        { role: "system", content: shortStableText },
        { role: "user", content: `question: ${tail}` }
      ]
    });
    const previous = makeCall({
      wireBody: makeBody("a"),
      timestamp: 0,
      requestParams: { model: "gpt-4o" }
    });
    const current = makeCall({
      wireBody: makeBody("b"),
      timestamp: GAP_MS,
      requestParams: { model: "gpt-4o" }
    });
    const result = diagnoseCall(
      { ...previous, provider: "openai" },
      { ...current, provider: "openai" }
    );
    expect(result.kind).not.toBe("diagnosis");
  });
  it("a real above-floor gpt-4o prompt (>1024 tokens / >4096 bytes) still gets diagnosed", () => {
    const longStableText = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const makeBody = (tail: string) => ({
      model: "gpt-4o",
      messages: [
        { role: "system", content: longStableText },
        { role: "user", content: `question: ${tail}` }
      ]
    });
    const previous = makeCall({
      wireBody: makeBody("a"),
      timestamp: 0,
      requestParams: { model: "gpt-4o" },
      usage: { inputTokens: tokenCount(1200) }
    });
    const current = makeCall({
      wireBody: makeBody("b"),
      timestamp: GAP_MS,
      requestParams: { model: "gpt-4o" },
      usage: { inputTokens: tokenCount(1200) }
    });
    const result = diagnoseCall(
      { ...previous, provider: "openai" },
      { ...current, provider: "openai" }
    );
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("dynamic-prefix-content");
    // OpenAI reports no cache writes: waste is estimated from the stable zone's share of the prompt.
    const canonical = buildCanonicalRequest(current.payload.wireBody);
    const stableBytes = result.diagnosis.byteOffset;
    expect(result.diagnosis.wastedEstimate).toBe(true);
    expect(result.diagnosis.wastedTokens).toBe(
      Math.round((stableBytes / canonical.byteLength) * 1200)
    );
    expect(result.diagnosis.wastedUsd).toBeGreaterThan(0);
  });
  it("the same short-prefix shape still correctly diagnoses for anthropic, whose 1024-token floor (~4096 bytes) is unaffected by the openai-specific miss signature", () => {
    const shortStableText = "The quick brown fox jumps over the lazy dog. ".repeat(28);
    const makeSystem = (tail: string) => [
      { type: "text", text: shortStableText, cache_control: { type: "ephemeral" } },
      { type: "text", text: tail }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system: makeSystem("tail-a"), messages: [] },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(300) }
    });
    const current = makeCall({
      wireBody: { tools: [], system: makeSystem("tail-b"), messages: [] },
      timestamp: GAP_MS
    });
    const result = diagnoseCall(previous, current);
    expect(result.kind).not.toBe("diagnosis");
  });
});
describe("min-cacheable threshold: per-model minimum from the pricing table", () => {
  function shortPrefixPair(model: string) {
    // ~600 tokens / ~2.4KB of stable text: above the 512-token 5.x floor, below the 1024-token 4.x floor.
    const stableText = "The quick brown fox jumps over the lazy dog. ".repeat(54);
    const makeSystem = (tail: string) => [
      { type: "text", text: stableText, cache_control: { type: "ephemeral" } },
      { type: "text", text: tail }
    ];
    const previous = makeCall({
      wireBody: { tools: [], system: makeSystem("tail-a"), messages: [] },
      timestamp: 0,
      usage: { cacheReadInputTokens: tokenCount(600) },
      requestParams: { model }
    });
    const current = makeCall({
      wireBody: { tools: [], system: makeSystem("tail-b"), messages: [] },
      timestamp: GAP_MS,
      usage: { cacheCreationInputTokens: tokenCount(600) },
      requestParams: { model }
    });
    const canonicalCurrent = buildCanonicalRequest(current.payload.wireBody);
    const prefixDiff = diffPrefix(
      canonicalPrefixComparisonText(buildCanonicalRequest(previous.payload.wireBody)),
      canonicalPrefixComparisonText(canonicalCurrent)
    );
    const stablePrefixText = sliceByBytes(
      canonicalCurrent.text,
      byteOffset(0),
      prefixDiff.divergenceByteOffset
    );
    const confirmedPrefixTokenCounts = new Map([[hashPrefix(stablePrefixText), tokenCount(600)]]);
    return diagnoseCall(previous, current, { confirmedPrefixTokenCounts });
  }
  it("a ~600-token prefix on claude-sonnet-5-5 (512-token floor) is diagnosed, but not as prefix-too-short", () => {
    const result = shortPrefixPair("claude-sonnet-5-5");
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).not.toBe("prefix-too-short");
  });
  it("an unpriced model is still diagnosed structurally (1024-token default floor), with unknown dollars", () => {
    const result = shortPrefixPair("claude-unknown-9");
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    // Same cause as the priced claude-sonnet-4-5 control (1024-token floor) below.
    expect(result.diagnosis.cause).toBe("prefix-too-short");
    expect(result.diagnosis.wastedTokens).toBe(600);
    expect(result.diagnosis.wastedUsd).toBeNull();
    expect(result.diagnosis.wastedUsdByTier).toBeNull();
  });
  it("control: the same prefix on claude-sonnet-4-5 (1024-token floor) is prefix-too-short", () => {
    const result = shortPrefixPair("claude-sonnet-4-5");
    expect(result.kind).toBe("diagnosis");
    if (result.kind !== "diagnosis") throw new Error("expected a diagnosis");
    expect(result.diagnosis.cause).toBe("prefix-too-short");
  });
});
