import { describe, expect, it } from "vitest";
import type { PrefixDiffResult } from "../diff/prefix-diff.js";
import type { LlmCall, Usage } from "../model/call.js";
import { byteOffset, tokenCount } from "../model/types.js";
import { type UsageGateParams, evaluateUsageGate } from "./gate.js";
const ONE_HOUR_MS = 60 * 60 * 1000;
function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: tokenCount(0),
    outputTokens: tokenCount(0),
    cacheCreationInputTokens: tokenCount(0),
    cacheReadInputTokens: tokenCount(0),
    ...overrides
  };
}
function makeCall(timestamp: number, usage: Partial<Usage> = {}): LlmCall {
  return {
    id: "call",
    sessionId: "session",
    stepName: "step",
    timestamp,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: "{}" },
    usage: makeUsage(usage)
  };
}
function identicalPrefixDiff(): PrefixDiffResult {
  return {
    identical: true,
    previousIsPrefixOfCurrent: true,
    divergenceByteOffset: byteOffset(100)
  };
}
function extensionPrefixDiff(): PrefixDiffResult {
  return {
    identical: false,
    previousIsPrefixOfCurrent: true,
    divergenceByteOffset: byteOffset(100)
  };
}
function divergedPrefixDiff(offset = 5): PrefixDiffResult {
  return {
    identical: false,
    previousIsPrefixOfCurrent: false,
    divergenceByteOffset: byteOffset(offset)
  };
}
function baseParams(overrides: Partial<UsageGateParams> = {}): UsageGateParams {
  return {
    previous: makeCall(0),
    current: makeCall(1000),
    prefixDiff: identicalPrefixDiff(),
    breakpointDeclared: false,
    minCacheableBytesProxy: 50,
    maxTtlMs: ONE_HOUR_MS,
    ...overrides
  };
}
describe("evaluateUsageGate", () => {
  it("returns cold-start when there is no previous call", () => {
    const verdict = evaluateUsageGate(baseParams({ previous: undefined }));
    expect(verdict).toEqual({ kind: "cold-start" });
  });
  it("returns gap-exceeds-max-ttl when the gap to the last touch exceeds max TTL", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        previous: makeCall(0),
        current: makeCall(ONE_HOUR_MS + 1, { cacheCreationInputTokens: tokenCount(100) })
      })
    );
    expect(verdict).toEqual({ kind: "gap-exceeds-max-ttl" });
  });
  it("returns no-op for a sub-min-cacheable prefix with no breakpoint and no cache activity (A2 true no-op)", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        breakpointDeclared: false,
        prefixDiff: divergedPrefixDiff(5),
        minCacheableBytesProxy: 50
      })
    );
    expect(verdict).toEqual({ kind: "no-op" });
  });
  it("returns healthy-extension when a stable prefix is fully read and only a tail is created", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        prefixDiff: extensionPrefixDiff(),
        current: makeCall(1000, {
          cacheReadInputTokens: tokenCount(900),
          cacheCreationInputTokens: tokenCount(50)
        })
      })
    );
    expect(verdict).toEqual({ kind: "healthy-extension" });
  });
  it("does NOT return healthy-extension for a partial read + large re-creation on an extending prefix (regression)", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        previous: makeCall(0, { cacheReadInputTokens: tokenCount(1000) }),
        prefixDiff: extensionPrefixDiff(),
        current: makeCall(1000, {
          cacheReadInputTokens: tokenCount(200),
          cacheCreationInputTokens: tokenCount(5000)
        })
      })
    );
    expect(verdict).not.toEqual({ kind: "healthy-extension" });
    expect(verdict).toEqual({ kind: "miss", signature: "signature-1" });
  });
  it("returns concurrent-cold-fill when two near-simultaneous requests both create on an extending prefix", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        previous: makeCall(0, { cacheCreationInputTokens: tokenCount(500) }),
        current: makeCall(100, { cacheCreationInputTokens: tokenCount(500) }),
        prefixDiff: extensionPrefixDiff()
      })
    );
    expect(verdict).toEqual({ kind: "concurrent-cold-fill" });
  });
  it("returns a signature-1 miss when cache_creation > 0 on a paired, non-extending request", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        prefixDiff: divergedPrefixDiff(40),
        current: makeCall(1000, { cacheCreationInputTokens: tokenCount(200) })
      })
    );
    expect(verdict).toEqual({ kind: "miss", signature: "signature-1" });
  });
  it("returns a signature-2 miss when a breakpoint is declared but nothing was read or created on a stable prefix (A1)", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        breakpointDeclared: true,
        prefixDiff: identicalPrefixDiff(),
        current: makeCall(1000)
      })
    );
    expect(verdict).toEqual({ kind: "miss", signature: "signature-2" });
  });
});
describe("evaluateUsageGate (provider: openai)", () => {
  it("returns a signature-2 miss when the stable prefix meets the min-cacheable length but nothing was read, even with no declared breakpoint", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        provider: "openai",
        breakpointDeclared: false,
        prefixDiff: divergedPrefixDiff(80),
        current: makeCall(1000)
      })
    );
    expect(verdict).toEqual({ kind: "miss", signature: "signature-2" });
  });
  it("does not fire the openai miss signature when the stable prefix is below the min-cacheable length (true no-op)", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        provider: "openai",
        breakpointDeclared: false,
        prefixDiff: divergedPrefixDiff(10),
        current: makeCall(1000)
      })
    );
    expect(verdict).toEqual({ kind: "no-op" });
  });
  it("does not fire the openai signature when this is a default (anthropic) call — provider defaults to anthropic", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        breakpointDeclared: false,
        prefixDiff: divergedPrefixDiff(80),
        current: makeCall(1000)
      })
    );
    expect(verdict).toEqual({ kind: "no-op" });
  });
  it("still recognizes a signature-1 miss (cache_creation > 0) for openai, same as anthropic", () => {
    const verdict = evaluateUsageGate(
      baseParams({
        provider: "openai",
        prefixDiff: divergedPrefixDiff(80),
        current: makeCall(1000, { cacheCreationInputTokens: tokenCount(200) })
      })
    );
    expect(verdict).toEqual({ kind: "miss", signature: "signature-1" });
  });
});
