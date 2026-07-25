import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import { byteOffset, tokenCount } from "../model/types.js";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import { classifyMiss } from "./precedence.js";
function makeCall(wireBody: unknown, timestamp: number): LlmCall {
  return {
    id: `call-${timestamp}`,
    sessionId: "session",
    stepName: "step",
    timestamp,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: JSON.stringify(wireBody) },
    usage: {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(300),
      cacheReadInputTokens: tokenCount(0)
    }
  };
}
describe("classifyMiss", () => {
  it("falls back to the messages tier when the divergence offset lands beyond every known segment (defensive)", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const previous = makeCall(wireBody, 0);
    const current = makeCall(wireBody, 1000);
    const canonicalPrevious = buildCanonicalRequest(previous.payload.wireBody);
    const canonicalCurrent = buildCanonicalRequest(current.payload.wireBody);
    const forcedPrefixDiff = {
      identical: false,
      previousIsPrefixOfCurrent: false,
      divergenceByteOffset: byteOffset(canonicalCurrent.byteLength + 1000)
    };
    const diagnosis = classifyMiss({
      previous,
      current,
      canonicalPrevious,
      canonicalCurrent,
      prefixDiff: forcedPrefixDiff,
      previousBreakpoints: [],
      currentBreakpoints: [],
      minCacheableBytesProxy: 0
    });
    expect(diagnosis?.cause).toBe("dynamic-prefix-content");
    expect(diagnosis?.invalidatedTiers).toEqual(["messages"]);
    expect(diagnosis?.structuralPath).toBe("messages");
  });
});
