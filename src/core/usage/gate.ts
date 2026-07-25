import type { PrefixDiffResult } from "../diff/prefix-diff.js";
import type { LlmCall, Usage } from "../model/call.js";
import { DEFAULT_PROVIDER, type Provider } from "../model/provider.js";
export type MissSignature = "signature-1" | "signature-2";
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
    prefixStable: prefixDiff.identical,
    provider,
    prefixMeetsMinCacheable: prefixDiff.divergenceByteOffset >= minCacheableBytesProxy
  });
  if (signature) {
    return { kind: "miss", signature };
  }
  return { kind: "no-op" };
}
