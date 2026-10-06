import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import { byteOffset, tokenCount } from "../model/types.js";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import { classifyMiss, stablePrefixText } from "./precedence.js";

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
describe("stablePrefixText", () => {
  it("snaps a divergence offset inside a multibyte character back to its start, so the slice has no U+FFFD", () => {
    // "é" (C3 A9) and "è" (C3 A8) share their lead byte, so the byte-level divergence lands
    // between the two bytes of the character.
    const previous = "prefix é";
    const current = "prefix è";
    const a = new TextEncoder().encode(previous);
    const b = new TextEncoder().encode(current);
    let divergence = 0;
    while (a[divergence] === b[divergence]) divergence++;
    expect(divergence).toBe(8);
    const slice = stablePrefixText(current, byteOffset(divergence));
    expect(slice).not.toContain("\uFFFD");
    expect(slice).toBe("prefix ");
  });
  it("keeps an offset that already sits on a character boundary", () => {
    expect(stablePrefixText("☕☕x", byteOffset(6))).toBe("☕☕");
    expect(stablePrefixText("abc", byteOffset(99))).toBe("abc");
  });
});
