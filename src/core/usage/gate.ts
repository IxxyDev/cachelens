import type { PrefixDiffResult } from "../diff/prefix-diff.js";
import type { LlmCall, Usage } from "../model/call.js";
import { DEFAULT_PROVIDER, type Provider } from "../model/provider.js";
/**
 * signature-1: cache_creation > 0 on a request that should have hit.
 * signature-2: a breakpoint (or OpenAI's automatic cache) on a stable prefix, yet nothing read or written.
 * signature-3: a breakpoint placed too early — the prefix up to it was read, nothing was written,
 *   and the stable zone runs well past it (see `isEarlyBreakpoint`).
 */
export type MissSignature = "signature-1" | "signature-2" | "signature-3";
export type UsageGateVerdict =
  | {
      readonly kind: "cold-start";
    }
  | {
      readonly kind: "gap-exceeds-max-ttl";
    }
  | {
      readonly kind: "no-op";
    }
  | {
      readonly kind: "healthy-extension";
    }
  | {
      readonly kind: "concurrent-cold-fill";
    }
  | {
      readonly kind: "miss";
      readonly signature: MissSignature;
    };
const CONCURRENT_COLD_FILL_WINDOW_MS = 2000;
export interface UsageGateParams {
  readonly previous: LlmCall | undefined;
  readonly current: LlmCall;
  readonly prefixDiff: PrefixDiffResult;
  readonly breakpointDeclared: boolean;
  readonly minCacheableBytesProxy: number;
  readonly maxTtlMs: number;
  readonly provider?: Provider;
  /** Canonical byte offset of the current request's last cache breakpoint, when one is declared. */
  readonly lastBreakpointOffset?: number;
}
/**
 * A breakpoint placed too early. The vendor caches only up to a breakpoint: with read > 0 the
 * prefix up to it was served, and creation == 0 means nothing after it was cached. In a healthy
 * loop the appended turn sits before a (moving) breakpoint and is written, so creation > 0. When
 * creation is 0 yet the stable zone extends at least a min-cacheable stretch past the last
 * breakpoint, that stable content is re-billed as plain input on every call: misplacement.
 * Checked before healthy-extension, whose "read covers the previous stable tokens" test this
 * shape also passes (the previous call read the same early prefix).
 */
function isEarlyBreakpoint(params: {
  readonly usage: Usage;
  readonly breakpointDeclared: boolean;
  readonly lastBreakpointOffset: number | undefined;
  readonly stableBytes: number;
  readonly minCacheableBytesProxy: number;
}): boolean {
  const { usage, breakpointDeclared, lastBreakpointOffset, stableBytes } = params;
  return (
    breakpointDeclared &&
    lastBreakpointOffset !== undefined &&
    usage.cacheReadInputTokens > 0 &&
    usage.cacheCreationInputTokens === 0 &&
    stableBytes - lastBreakpointOffset >= params.minCacheableBytesProxy
  );
}
function detectMissSignature(params: {
  readonly usage: Usage;
  readonly breakpointDeclared: boolean;
  readonly prefixStable: boolean;
  readonly provider: Provider;
  readonly prefixMeetsMinCacheable: boolean;
}): MissSignature | undefined {
  const { usage, breakpointDeclared, prefixStable, provider, prefixMeetsMinCacheable } = params;
  if (usage.cacheCreationInputTokens > 0) {
    return "signature-1";
  }
  if (
    breakpointDeclared &&
    usage.cacheCreationInputTokens === 0 &&
    usage.cacheReadInputTokens === 0 &&
    prefixStable
  ) {
    return "signature-2";
  }
  if (
    provider === "openai" &&
    usage.cacheCreationInputTokens === 0 &&
    usage.cacheReadInputTokens === 0 &&
    prefixMeetsMinCacheable
  ) {
    return "signature-2";
  }
  return undefined;
}
export function evaluateUsageGate(params: UsageGateParams): UsageGateVerdict {
  const {
    previous,
    current,
    prefixDiff,
    breakpointDeclared,
    minCacheableBytesProxy,
    maxTtlMs,
    provider = DEFAULT_PROVIDER
  } = params;
  if (!previous) {
    return { kind: "cold-start" };
  }
  const gapMs = current.timestamp - previous.timestamp;
  if (gapMs > maxTtlMs) {
    return { kind: "gap-exceeds-max-ttl" };
  }
  const { cacheReadInputTokens, cacheCreationInputTokens } = current.usage;
  if (
    !breakpointDeclared &&
    cacheReadInputTokens === 0 &&
    cacheCreationInputTokens === 0 &&
    prefixDiff.divergenceByteOffset < minCacheableBytesProxy
  ) {
    return { kind: "no-op" };
  }
  if (
    isEarlyBreakpoint({
      usage: current.usage,
      breakpointDeclared,
      lastBreakpointOffset: params.lastBreakpointOffset,
      stableBytes: prefixDiff.divergenceByteOffset,
      minCacheableBytesProxy
    })
  ) {
    return { kind: "miss", signature: "signature-3" };
  }
  const previousStableTokens =
    previous.usage.cacheReadInputTokens + previous.usage.cacheCreationInputTokens;
  if (
    prefixDiff.previousIsPrefixOfCurrent &&
    cacheReadInputTokens > 0 &&
    cacheReadInputTokens >= previousStableTokens
  ) {
    return { kind: "healthy-extension" };
  }
  if (
    prefixDiff.previousIsPrefixOfCurrent &&
    cacheReadInputTokens === 0 &&
    cacheCreationInputTokens > 0 &&
    previous.usage.cacheCreationInputTokens > 0 &&
    gapMs < CONCURRENT_COLD_FILL_WINDOW_MS
  ) {
    return { kind: "concurrent-cold-fill" };
  }
  const signature = detectMissSignature({
    usage: current.usage,
    breakpointDeclared,
    // A multi-turn loop appends every call, so "stable" means the previous request survives
    // intact as a prefix (or a cacheable-length stretch of it does), not byte-identity.
    prefixStable:
      prefixDiff.previousIsPrefixOfCurrent ||
      prefixDiff.divergenceByteOffset >= minCacheableBytesProxy,
    provider,
    prefixMeetsMinCacheable: prefixDiff.divergenceByteOffset >= minCacheableBytesProxy
  });
  if (signature) {
    return { kind: "miss", signature };
  }
  return { kind: "no-op" };
}
