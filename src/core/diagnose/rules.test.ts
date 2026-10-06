import { describe, expect, it } from "vitest";
import { locateBreakpoints } from "../breakpoints/locate.js";
import { diffPrefix } from "../diff/prefix-diff.js";
import type { LlmCall, Usage } from "../model/call.js";
import { byteOffset, tokenCount, usd } from "../model/types.js";
import { getModelPricing } from "../pricing/table.js";
import {
  buildCanonicalRequest,
  canonicalPrefixComparisonText
} from "../serialize/canonical-request.js";
import { tierSegment } from "../serialize/segment-map.js";
import {
  buildDynamicPrefixContentDiagnosis,
  checkBreakpointMisplacement,
  checkContentBlockChurn,
  checkLookbackWindowExceeded,
  checkPrefixTooShort,
  checkRequestParamInvalidation,
  checkToolsTierDrift,
  checkTtlExpiry,
  computeWaste
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
  it("zeroes the tools and system tiers when only thinking changed (messages scope, upstream model-specific)", () => {
    const wireBody = {
      tools: [{ name: "search" }],
      system: "x",
      messages: [{ role: "user", content: "hi" }]
    };
    const previous = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", thinking: { type: "disabled" } }
    });
    const current = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", thinking: { type: "adaptive" } }
    });
    const diagnosis = checkRequestParamInvalidation(previous, current, pricing);
    expect(diagnosis).not.toBeNull();
    if (!diagnosis) throw new Error("expected a diagnosis");
    expect(diagnosis.invalidatedTiers).toEqual(["messages"]);
    expect(diagnosis.wastedUsdByTier.get("tools")).toBe(0);
    expect(diagnosis.wastedUsdByTier.get("system")).toBe(0);
    expect(diagnosis.excerpt).toBe("thinking: disabled -> adaptive");
    expect(sumMap(diagnosis.wastedUsdByTier)).toBeCloseTo(diagnosis.wastedUsd, 6);
  });
});
describe("checkRequestParamInvalidation excerpt", () => {
  it("describes a budget_tokens-only change distinctly from a generic 'params changed' message", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", thinking: { type: "enabled", budgetTokens: 8000 } }
    });
    const current = makeCall(wireBody, {
      params: { model: "claude-sonnet-4-5", thinking: { type: "enabled", budgetTokens: 16000 } }
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
function usageOf(overrides: Partial<Usage>): Usage {
  return {
    inputTokens: tokenCount(0),
    outputTokens: tokenCount(0),
    cacheCreationInputTokens: tokenCount(0),
    cacheReadInputTokens: tokenCount(0),
    ...overrides
  };
}
/** system: [cached head (breakpoint), stable middle, dynamic tail] — the breakpoint sits too early. */
function misplacementInputs(currentUsage: Usage) {
  const makeBody = (tail: string) =>
    JSON.stringify({
      tools: [],
      system: [
        { type: "text", text: "H".repeat(200), cache_control: { type: "ephemeral" } },
        { type: "text", text: "M".repeat(200) },
        { type: "text", text: tail }
      ],
      messages: []
    });
  const previous = buildCanonicalRequest(makeBody("tail-a"));
  const currentBody = makeBody("tail-b");
  const current = buildCanonicalRequest(currentBody);
  return {
    prefixDiff: diffPrefix(
      canonicalPrefixComparisonText(previous),
      canonicalPrefixComparisonText(current)
    ),
    currentBreakpoints: locateBreakpoints(currentBody, current.segments),
    currentUsage,
    minCacheableBytesProxy: 10,
    currentSegments: current.segments,
    canonicalCurrentText: current.text,
    pricing
  };
}
describe("checkBreakpointMisplacement", () => {
  it("fires when part of the prefix was read and a whole stable block follows the breakpoint, snapping the offset to that block's end", () => {
    const inputs = misplacementInputs(
      usageOf({ cacheReadInputTokens: tokenCount(60), cacheCreationInputTokens: tokenCount(40) })
    );
    const diagnosis = checkBreakpointMisplacement(inputs);
    expect(diagnosis?.cause).toBe("breakpoint-misplacement");
    const middleBlock = inputs.currentSegments.find((s) => s.structuralPath === "system[1]");
    expect(diagnosis?.structuralPath).toBe("system[1]");
    expect(diagnosis?.byteOffset).toBe(middleBlock?.end);
    // A block boundary, not the mid-string divergence offset inside system[2].
    expect(diagnosis?.byteOffset).toBeLessThan(inputs.prefixDiff.divergenceByteOffset);
    expect(diagnosis?.recommendation).toContain("end of system[1]");
    expect(diagnosis?.invalidatedTiers).toEqual(["system"]);
  });
  it("does not fire when cache_read is 0: the content before the breakpoint missed too, which moving the breakpoint cannot explain", () => {
    const inputs = misplacementInputs(usageOf({ cacheCreationInputTokens: tokenCount(100) }));
    expect(checkBreakpointMisplacement(inputs)).toBeNull();
  });
  it("does not fire when no whole block lies between the breakpoint and the end of the stable zone", () => {
    const inputs = misplacementInputs(
      usageOf({ cacheReadInputTokens: tokenCount(60), cacheCreationInputTokens: tokenCount(40) })
    );
    const middleEnd = inputs.currentSegments.find((s) => s.structuralPath === "system[1]")?.end;
    const lateBreakpoints = inputs.currentBreakpoints.map((bp) => ({
      ...bp,
      byteOffset: byteOffset(middleEnd ?? 0)
    }));
    expect(
      checkBreakpointMisplacement({ ...inputs, currentBreakpoints: lateBreakpoints })
    ).toBeNull();
  });
  it("returns null when the breakpoint is already at or after the stable boundary (not misplaced)", () => {
    const diagnosis = checkBreakpointMisplacement({
      prefixDiff: {
        identical: false,
        previousIsPrefixOfCurrent: false,
        divergenceByteOffset: byteOffset(50)
      },
      currentBreakpoints: [{ byteOffset: byteOffset(50), index: 0, ttl: "5m", tier: "system" }],
      currentUsage: usageOf({
        cacheCreationInputTokens: tokenCount(300),
        cacheReadInputTokens: tokenCount(10)
      }),
      minCacheableBytesProxy: 10,
      currentSegments: [],
      canonicalCurrentText: "x".repeat(60),
      pricing
    });
    expect(diagnosis).toBeNull();
  });
});
describe("checkTtlExpiry on a growing conversation", () => {
  it("fires when the previous request is a strict prefix of the current one (an appended turn) and the gap exceeds the TTL", () => {
    const previous = makeCall(
      { tools: [], system: "x", messages: [{ role: "user", content: "q1" }] },
      { timestamp: 0, usage: usageOf({ cacheCreationInputTokens: tokenCount(300) }) }
    );
    const current = makeCall(
      {
        tools: [],
        system: "x",
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" }
        ]
      },
      { timestamp: 10 * 60 * 1000, usage: usageOf({ cacheCreationInputTokens: tokenCount(350) }) }
    );
    const diagnosis = checkTtlExpiry({
      previous,
      current,
      previousBreakpoints: [{ byteOffset: byteOffset(5), index: 0, ttl: "5m", tier: "system" }],
      prefixDiff: {
        identical: false,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(40)
      },
      pricing
    });
    expect(diagnosis?.cause).toBe("ttl-expiry");
    expect(diagnosis?.excerpt).toContain("extends the previous call");
    // The 50 appended tokens had to be written anyway: only the 300 the cache held are waste.
    expect(diagnosis?.wastedTokens).toBe(300);
  });
  it("does not fire when the prefix genuinely diverged (neither identical nor extended)", () => {
    const previous = makeCall({ tools: [], system: "x", messages: [] }, { timestamp: 0 });
    const current = makeCall(
      { tools: [], system: "y", messages: [] },
      { timestamp: 10 * 60 * 1000 }
    );
    const diagnosis = checkTtlExpiry({
      previous,
      current,
      previousBreakpoints: [],
      prefixDiff: {
        identical: false,
        previousIsPrefixOfCurrent: false,
        divergenceByteOffset: byteOffset(20)
      },
      pricing
    });
    expect(diagnosis).toBeNull();
  });
  it("prices a 1h-TTL expiry at the 2x write multiplier", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      timestamp: 0,
      usage: usageOf({ cacheReadInputTokens: tokenCount(1_000_000) })
    });
    const current = makeCall(wireBody, {
      timestamp: 2 * 60 * 60 * 1000,
      usage: usageOf({ cacheCreationInputTokens: tokenCount(1_000_000) })
    });
    const diagnosis = checkTtlExpiry({
      previous,
      current,
      previousBreakpoints: [{ byteOffset: byteOffset(5), index: 0, ttl: "1h", tier: "system" }],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(0)
      },
      pricing
    });
    // sonnet-4-5: $3/MTok input, 2x write vs 0.1x read.
    expect(diagnosis?.wastedUsd).toBeCloseTo(3 * (2 - 0.1), 6);
  });
});
describe("checkTtlExpiry write TTL", () => {
  it("prices the expiry at the previous call's 1h TTL even when the waste basis carries the current call's 5m TTL", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, {
      timestamp: 0,
      usage: usageOf({ cacheReadInputTokens: tokenCount(1_000_000) })
    });
    const current = makeCall(wireBody, {
      timestamp: 2 * 60 * 60 * 1000,
      usage: usageOf({ cacheCreationInputTokens: tokenCount(1_000_000) })
    });
    const diagnosis = checkTtlExpiry({
      previous,
      current,
      previousBreakpoints: [{ byteOffset: byteOffset(5), index: 0, ttl: "1h", tier: "system" }],
      prefixDiff: {
        identical: true,
        previousIsPrefixOfCurrent: true,
        divergenceByteOffset: byteOffset(0)
      },
      pricing,
      waste: { writeTtl: "5m" }
    });
    expect(diagnosis?.wastedUsd).toBeCloseTo(3 * (2 - 0.1), 6);
  });
});
describe("computeWaste", () => {
  it("caps waste at what the previous call held, so newly appended content in a growing conversation is never waste", () => {
    // Turn N held 1000 cached tokens; turn N+1 changed a timestamp at the start and appended a
    // 500-token turn, so it re-wrote 1500. Only the 1000 that could have been read are waste.
    const waste = computeWaste(usageOf({ cacheCreationInputTokens: tokenCount(1500) }), pricing, {
      previousUsage: usageOf({
        cacheReadInputTokens: tokenCount(800),
        cacheCreationInputTokens: tokenCount(200)
      })
    });
    expect(waste.wastedTokens).toBe(1000);
    expect(waste.wastedUsd).toBeCloseTo((1000 / 1_000_000) * 3 * (1.25 - 0.1), 9);
  });
  it("prices the reported 5m/1h split at 1.25x/2x respectively", () => {
    const waste = computeWaste(
      usageOf({
        cacheCreationInputTokens: tokenCount(248),
        cacheCreation5mInputTokens: tokenCount(148),
        cacheCreation1hInputTokens: tokenCount(100)
      }),
      pricing
    );
    const expected = (3 / 1_000_000) * (148 * (1.25 - 0.1) + 100 * (2 - 0.1));
    expect(waste.wastedTokens).toBe(248);
    expect(waste.wastedUsd).toBeCloseTo(expected, 12);
  });
  it("estimates OpenAI waste from the stable zone's share of the prompt, since OpenAI reports no cache writes", () => {
    const gpt4o = getModelPricing("gpt-4o");
    const waste = computeWaste(usageOf({ inputTokens: tokenCount(2000) }), gpt4o, {
      provider: "openai",
      stableBytes: 6000,
      totalBytes: 8000,
      previousUsage: usageOf({})
    });
    expect(waste.wastedEstimate).toBe(true);
    expect(waste.wastedTokens).toBe(1500);
    const expected = (1500 / 1_000_000) * gpt4o.inputPricePerMTok * (1 - gpt4o.cacheReadMultiplier);
    expect(waste.wastedUsd).toBeCloseTo(expected, 12);
    expect(waste.wastedUsd).toBeGreaterThan(0);
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
    const base = misplacementInputs(
      usageOf({ cacheReadInputTokens: tokenCount(60), cacheCreationInputTokens: tokenCount(40) })
    );
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
