import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import { byteOffset, tokenCount, usd } from "../model/types.js";
import { getModelPricing } from "../pricing/table.js";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import { tierSegment } from "../serialize/segment-map.js";
import {
  buildDynamicPrefixContentDiagnosis,
  checkBreakpointMisplacement,
  checkContentBlockChurn,
  checkLookbackWindowExceeded,
  checkPrefixTooShort,
  checkRequestParamInvalidation,
  checkToolsTierDrift,
  checkTtlExpiry
} from "./rules.js";
const pricing = getModelPricing("claude-sonnet-4-5");
function makeCall(wireBody: unknown, overrides: Partial<LlmCall> = {}): LlmCall {
  return {
    id: "call-1",
    sessionId: "s",
    stepName: "step",
    timestamp: 0,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: JSON.stringify(wireBody) },
    usage: {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(300),
      cacheReadInputTokens: tokenCount(0)
    },
    ...overrides
  };
}
function sumMap(map: ReadonlyMap<string, number>): number {
  return [...map.values()].reduce((a, b) => a + b, 0);
}
describe("checkRequestParamInvalidation wastedUsdByTier", () => {
  it("splits the waste across all three tiers on a model change, summing to wastedUsd", () => {
    const wireBody = {
      tools: [{ name: "search" }],
      system: [{ type: "text", text: "a fairly long stable system prompt goes here" }],
      messages: [{ role: "user", content: "hi" }]
    };
    const previous = makeCall(wireBody, { params: { model: "claude-sonnet-4-5" } });
    const current = makeCall(wireBody, { params: { model: "claude-opus-4-5" } });
    const diagnosis = checkRequestParamInvalidation(previous, current, pricing);
    expect(diagnosis).not.toBeNull();
    if (!diagnosis) throw new Error("expected a diagnosis");
    expect(diagnosis.wastedUsdByTier.size).toBe(3);
    expect(diagnosis.wastedUsdByTier.get("tools")).toBeGreaterThan(0);
    expect(diagnosis.wastedUsdByTier.get("system")).toBeGreaterThan(0);
    expect(diagnosis.wastedUsdByTier.get("messages")).toBeGreaterThan(0);
    expect(sumMap(diagnosis.wastedUsdByTier)).toBeCloseTo(diagnosis.wastedUsd, 6);
  });
  it("zeroes the tools tier when only tool_choice/thinking changed (system+messages scope)", () => {
    const wireBody = {
      tools: [{ name: "search" }],
      system: "x",
      messages: [{ role: "user", content: "hi" }]
    };
    const previous = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", thinking: false }
    });
    const current = makeCall(wireBody, { params: { model: "claude-sonnet-4-5", thinking: true } });
    const diagnosis = checkRequestParamInvalidation(previous, current, pricing);
    expect(diagnosis).not.toBeNull();
    if (!diagnosis) throw new Error("expected a diagnosis");
    expect(diagnosis.wastedUsdByTier.get("tools")).toBe(0);
    expect(sumMap(diagnosis.wastedUsdByTier)).toBeCloseTo(diagnosis.wastedUsd, 6);
  });
});
describe("checkRequestParamInvalidation excerpt", () => {
  it("describes a budget_tokens-only change distinctly from a generic 'params changed' message", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", thinking: true, thinkingBudgetTokens: 8000 }
    });
    const current = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", thinking: true, thinkingBudgetTokens: 16000 }
    });
    const diagnosis = checkRequestParamInvalidation(previous, current, pricing);
    expect(diagnosis).not.toBeNull();
    expect(diagnosis?.excerpt).toBe("thinking.budget_tokens: 8000 -> 16000");
  });
  it("describes a speed-only change", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", speed: "standard" }
    });
    const current = makeCall(wireBody, { params: { model: "claude-sonnet-4-5", speed: "fast" } });
    const diagnosis = checkRequestParamInvalidation(previous, current, pricing);
    expect(diagnosis?.excerpt).toBe("speed: standard -> fast");
  });
  it("describes an images-present change", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, { params: { model: "claude-sonnet-4-5" } });
    const current = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", imagesPresent: true }
    });
    const diagnosis = checkRequestParamInvalidation(previous, current, pricing);
    expect(diagnosis?.excerpt).toBe("images present: undefined -> true");
  });
  it("describes a citations-enabled change", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", citationsEnabled: false }
    });
    const current = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", citationsEnabled: true }
    });
    const diagnosis = checkRequestParamInvalidation(previous, current, pricing);
    expect(diagnosis?.excerpt).toBe("citations enabled: false -> true");
  });
});
describe("tierByteLengthsFromWireBody fallback (via checkRequestParamInvalidation)", () => {
  it("falls back to an even split rather than throwing when the wire-body can't be re-parsed (defensive)", () => {
    const previous = makeCall({}, { params: { model: "claude-sonnet-4-5" } });
    const current: LlmCall = {
      ...makeCall({}, { params: { model: "claude-opus-4-5" } }),
      payload: { wireBody: "42" }
    };
    const diagnosis = checkRequestParamInvalidation(previous, current, pricing);
    expect(diagnosis).not.toBeNull();
    if (!diagnosis) throw new Error("expected a diagnosis");
    expect(diagnosis.wastedUsdByTier.get("tools")).toBeGreaterThan(0);
    expect(diagnosis.wastedUsdByTier.get("system")).toBeGreaterThan(0);
    expect(diagnosis.wastedUsdByTier.get("messages")).toBeGreaterThan(0);
  });
});
describe("checkToolsTierDrift wastedUsdByTier", () => {
  it("attributes an exact share to tools and splits the remainder evenly between system/messages", () => {
    const canonicalCurrent = buildCanonicalRequest(
      JSON.stringify({
        tools: [{ name: "search" }, { name: "lookup" }],
        system: "a stable system prompt",
        messages: [{ role: "user", content: "hi" }]
      })
    );
    const toolsSegment = tierSegment(canonicalCurrent.segments, "tools");
    if (!toolsSegment) throw new Error("expected a tools segment");
    const currentToolsText = canonicalCurrent.text.slice(toolsSegment.start, toolsSegment.end);
    const diagnosis = checkToolsTierDrift({
      tier: "tools",
      previousToolsText: '[{"name":"search"}]',
      currentToolsText,
      divergenceByteOffset: byteOffset(0),
      canonicalCurrentText: canonicalCurrent.text,
      currentUsage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(300),
        cacheReadInputTokens: tokenCount(0)
      },
      pricing
    });
    expect(diagnosis).not.toBeNull();
    if (!diagnosis) throw new Error("expected a diagnosis");
    expect(diagnosis.wastedUsdByTier.get("tools")).toBeGreaterThan(0);
    expect(diagnosis.wastedUsdByTier.get("system")).toBeGreaterThan(0);
    expect(diagnosis.wastedUsdByTier.get("messages")).toBeGreaterThan(0);
    expect(diagnosis.wastedUsdByTier.get("system")).toBeCloseTo(
      diagnosis.wastedUsdByTier.get("messages") ?? -1,
      10
    );
    expect(sumMap(diagnosis.wastedUsdByTier)).toBeCloseTo(diagnosis.wastedUsd, 6);
  });
});
describe("checkBreakpointMisplacement", () => {
  it("returns null when the breakpoint is already at or after the stable boundary (not misplaced)", () => {
    const diagnosis = checkBreakpointMisplacement({
      prefixDiff: {
        identical: false,
        previousIsPrefixOfCurrent: false,
        divergenceByteOffset: byteOffset(50)
      },
      currentBreakpoints: [{ byteOffset: byteOffset(50), index: 0, ttl: "5m", tier: "system" }],
      currentUsage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(300),
        cacheReadInputTokens: tokenCount(0)
      },
      minCacheableBytesProxy: 10,
      currentSegments: [],
      canonicalCurrentText: "x".repeat(60),
      pricing
    });
    expect(diagnosis).toBeNull();
  });
  it("returns null when usage shows both creation and reads (not the misplacement signature)", () => {
    const diagnosis = checkBreakpointMisplacement({
      prefixDiff: {
        identical: false,
        previousIsPrefixOfCurrent: false,
        divergenceByteOffset: byteOffset(50)
      },
      currentBreakpoints: [{ byteOffset: byteOffset(10), index: 0, ttl: "5m", tier: "system" }],
      currentUsage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(100),
        cacheReadInputTokens: tokenCount(50)
      },
      minCacheableBytesProxy: 10,
      currentSegments: [],
      canonicalCurrentText: "x".repeat(60),
      pricing
    });
    expect(diagnosis).toBeNull();
  });
});
describe("checkTtlExpiry", () => {
  it("defaults to a 5m ttl when the previous call declared no breakpoint at all", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      timestamp: 0,
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(300)
      }
    });
    const current = makeCall(wireBody, {
      timestamp: 6 * 60 * 1000,
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(300),
        cacheReadInputTokens: tokenCount(0)
      }
    });
    const diagnosis = checkTtlExpiry({
      previous,
      current,
      previousBreakpoints: [],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(0)
      },
      pricing
    });
    expect(diagnosis).not.toBeNull();
    expect(diagnosis?.excerpt).toContain("5m TTL");
  });
});
describe("checkTtlExpiry guard", () => {
  it("returns null when cache_creation_input_tokens is 0 (no re-creation signal)", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      timestamp: 0,
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(300)
      }
    });
    const current = makeCall(wireBody, {
      timestamp: 6 * 60 * 1000,
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(300)
      }
    });
    const diagnosis = checkTtlExpiry({
      previous,
      current,
      previousBreakpoints: [],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(0)
      },
      pricing
    });
    expect(diagnosis).toBeNull();
  });
  it("returns null when request params changed (defers to request-param-invalidation)", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      timestamp: 0,
      params: { model: "claude-sonnet-4-5" },
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(300)
      }
    });
    const current = makeCall(wireBody, {
      timestamp: 6 * 60 * 1000,
      params: { model: "claude-opus-4-5" },
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(300),
        cacheReadInputTokens: tokenCount(0)
      }
    });
    const diagnosis = checkTtlExpiry({
      previous,
      current,
      previousBreakpoints: [],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(0)
      },
      pricing
    });
    expect(diagnosis).toBeNull();
  });
});
describe("checkContentBlockChurn defensive parsing", () => {
  const baseUsage = {
    inputTokens: tokenCount(0),
    outputTokens: tokenCount(0),
    cacheCreationInputTokens: tokenCount(300),
    cacheReadInputTokens: tokenCount(0)
  };
  it("returns null when no segment matches the structural path (defensive)", () => {
    const diagnosis = checkContentBlockChurn({
      tier: "messages",
      structuralPath: "messages[0].content[0]",
      divergenceByteOffset: byteOffset(0),
      currentSegments: [],
      canonicalCurrentText: "{}",
      currentUsage: baseUsage,
      pricing
    });
    expect(diagnosis).toBeNull();
  });
  it("returns null when the located segment's bytes aren't valid JSON", () => {
    const text = "not-json-block";
    const diagnosis = checkContentBlockChurn({
      tier: "messages",
      structuralPath: "messages[0].content[0]",
      divergenceByteOffset: byteOffset(0),
      currentSegments: [
        {
          start: byteOffset(0),
          end: byteOffset(text.length),
          tier: "messages",
          structuralPath: "messages[0].content[0]"
        }
      ],
      canonicalCurrentText: text,
      currentUsage: baseUsage,
      pricing
    });
    expect(diagnosis).toBeNull();
  });
  it("returns null when the located segment's bytes parse to a non-object", () => {
    const text = "42";
    const diagnosis = checkContentBlockChurn({
      tier: "messages",
      structuralPath: "messages[0].content[0]",
      divergenceByteOffset: byteOffset(0),
      currentSegments: [
        {
          start: byteOffset(0),
          end: byteOffset(text.length),
          tier: "messages",
          structuralPath: "messages[0].content[0]"
        }
      ],
      canonicalCurrentText: text,
      currentUsage: baseUsage,
      pricing
    });
    expect(diagnosis).toBeNull();
  });
});
describe("checkLookbackWindowExceeded", () => {
  it("returns null when the breakpoint sits at or before the stable point (nothing to look back over)", () => {
    const diagnosis = checkLookbackWindowExceeded({
      currentSegments: [],
      currentBreakpoints: [{ byteOffset: byteOffset(20), index: 0, ttl: "5m", tier: "system" }],
      stableByteOffset: byteOffset(30),
      canonicalCurrentText: "x".repeat(60),
      currentUsage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(300),
        cacheReadInputTokens: tokenCount(0)
      },
      pricing
    });
    expect(diagnosis).toBeNull();
  });
});
describe("checkPrefixTooShort wastedUsdByTier", () => {
  it("splits the waste evenly across all three tiers (no tier-differentiated data available)", () => {
    const diagnosis = checkPrefixTooShort({
      currentBreakpoints: [{ byteOffset: byteOffset(10), index: 0, ttl: "5m", tier: "system" }],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(30)
      },
      confirmedTokenCount: tokenCount(50),
      minCacheableTokens: pricing.minCacheableTokens,
      canonicalCurrentText: "x".repeat(60),
      currentUsage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(300),
        cacheReadInputTokens: tokenCount(0)
      },
      pricing
    });
    expect(diagnosis).not.toBeNull();
    if (!diagnosis) throw new Error("expected a diagnosis");
    const tools = diagnosis.wastedUsdByTier.get("tools") ?? -1;
    const system = diagnosis.wastedUsdByTier.get("system") ?? -1;
    const messages = diagnosis.wastedUsdByTier.get("messages") ?? -1;
    expect(tools).toBeCloseTo(system, 10);
    expect(system).toBeCloseTo(messages, 10);
    expect(tools + system + messages).toBeCloseTo(diagnosis.wastedUsd, 6);
  });
  it("returns null when the confirmed token count meets the min-cacheable threshold (not too short)", () => {
    const diagnosis = checkPrefixTooShort({
      currentBreakpoints: [{ byteOffset: byteOffset(10), index: 0, ttl: "5m", tier: "system" }],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(30)
      },
      confirmedTokenCount: pricing.minCacheableTokens,
      minCacheableTokens: pricing.minCacheableTokens,
      canonicalCurrentText: "x".repeat(60),
      currentUsage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(300),
        cacheReadInputTokens: tokenCount(0)
      },
      pricing
    });
    expect(diagnosis).toBeNull();
  });
});
describe("buildDynamicPrefixContentDiagnosis wastedUsdByTier (single-tier, exact)", () => {
  it("attributes the entire waste to the single invalidated tier, zero elsewhere", () => {
    const diagnosis = buildDynamicPrefixContentDiagnosis({
      tier: "system",
      structuralPath: "system[0].text",
      divergenceByteOffset: byteOffset(5),
      canonicalCurrentText: "some canonical text here",
      currentUsage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(1000000),
        cacheReadInputTokens: tokenCount(0)
      },
      pricing
    });
    expect(diagnosis.wastedUsdByTier.get("system")).toBeCloseTo(diagnosis.wastedUsd, 6);
    expect(diagnosis.wastedUsdByTier.get("tools")).toBe(0);
    expect(diagnosis.wastedUsdByTier.get("messages")).toBe(0);
    expect(diagnosis.wastedUsd).toBeGreaterThan(usd(0));
  });
});
describe("provider gating: breakpoint-family causes never fire for a non-anthropic provider", () => {
  const missUsage = {
    inputTokens: tokenCount(0),
    outputTokens: tokenCount(0),
    cacheCreationInputTokens: tokenCount(300),
    cacheReadInputTokens: tokenCount(0)
  };
  it("checkBreakpointMisplacement", () => {
    const base = {
      prefixDiff: {
        identical: false,
        previousIsPrefixOfCurrent: false,
        divergenceByteOffset: byteOffset(50)
      },
      currentBreakpoints: [
        { byteOffset: byteOffset(10), index: 0, ttl: "5m" as const, tier: "system" as const }
      ],
      currentUsage: missUsage,
      minCacheableBytesProxy: 10,
      currentSegments: [],
      canonicalCurrentText: "x".repeat(60),
      pricing
    };
    expect(checkBreakpointMisplacement(base)).not.toBeNull();
    expect(checkBreakpointMisplacement({ ...base, provider: "openai" as const })).toBeNull();
  });
  it("checkTtlExpiry", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      timestamp: 0,
      usage: {
        ...missUsage,
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(300)
      }
    });
    const current = makeCall(wireBody, { timestamp: 6 * 60 * 1000, usage: missUsage });
    const base = {
      previous,
      current,
      previousBreakpoints: [],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(0)
      },
      pricing
    };
    expect(checkTtlExpiry(base)).not.toBeNull();
    expect(checkTtlExpiry({ ...base, provider: "openai" as const })).toBeNull();
  });
  it("checkPrefixTooShort", () => {
    const base = {
      currentBreakpoints: [
        { byteOffset: byteOffset(10), index: 0, ttl: "5m" as const, tier: "system" as const }
      ],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(30)
      },
      confirmedTokenCount: tokenCount(50),
      minCacheableTokens: pricing.minCacheableTokens,
      canonicalCurrentText: "x".repeat(60),
      currentUsage: missUsage,
      pricing
    };
    expect(checkPrefixTooShort(base)).not.toBeNull();
    expect(checkPrefixTooShort({ ...base, provider: "openai" as const })).toBeNull();
  });
  it("checkLookbackWindowExceeded", () => {
    const segments = Array.from({ length: 21 }, (_, i) => ({
      structuralPath: `messages[0].content[${i}]`,
      start: byteOffset(i),
      end: byteOffset(i + 1),
      tier: "messages" as const
    }));
    const withSegments = {
      currentSegments: segments,
      currentBreakpoints: [
        { byteOffset: byteOffset(40), index: 0, ttl: "5m" as const, tier: "messages" as const }
      ],
      stableByteOffset: byteOffset(0),
      canonicalCurrentText: "x".repeat(60),
      currentUsage: missUsage,
      pricing
    };
    expect(checkLookbackWindowExceeded(withSegments)).not.toBeNull();
    expect(
      checkLookbackWindowExceeded({ ...withSegments, provider: "openai" as const })
    ).toBeNull();
  });
});
