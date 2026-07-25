import { locateBreakpoints } from "../breakpoints/locate.js";
import { diffPrefix } from "../diff/prefix-diff.js";
import type { LlmCall } from "../model/call.js";
import { type Provider, resolveProvider } from "../model/provider.js";
import type { TokenCount } from "../model/types.js";
import { getModelPricing } from "../pricing/table.js";
import {
  buildCanonicalRequest,
  canonicalPrefixComparisonText
} from "../serialize/canonical-request.js";
import { type MissSignature, evaluateUsageGate } from "../usage/gate.js";
import { classifyMiss } from "./precedence.js";
import type { Diagnosis } from "./taxonomy.js";
const DEFAULT_MAX_TTL_MS_ANTHROPIC = 60 * 60 * 1000;
const DEFAULT_MAX_TTL_MS_OPENAI = 10 * 60 * 1000;
function defaultMaxTtlMs(provider: Provider): number {
  return provider === "openai" ? DEFAULT_MAX_TTL_MS_OPENAI : DEFAULT_MAX_TTL_MS_ANTHROPIC;
}
const BYTES_PER_TOKEN_ESTIMATE = 4;
function estimateMinCacheableBytes(minCacheableTokens: TokenCount): number {
  return minCacheableTokens * BYTES_PER_TOKEN_ESTIMATE;
}
export type EngineResult =
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
      readonly kind: "diagnosis";
      readonly diagnosis: Diagnosis;
    }
  | {
      readonly kind: "unclassified-miss";
      readonly signature: MissSignature;
    };
export interface DiagnoseOptions {
  readonly maxTtlMs?: number;
  readonly confirmedPrefixTokenCounts?: ReadonlyMap<string, TokenCount>;
}
export function diagnoseCall(
  previous: LlmCall | undefined,
  current: LlmCall,
  options: DiagnoseOptions = {}
): EngineResult {
  const canonicalCurrent = buildCanonicalRequest(current.payload.wireBody);
  const breakpoints = locateBreakpoints(current.payload.wireBody, canonicalCurrent.segments);
  const breakpointDeclared = breakpoints.length > 0;
  if (!previous) {
    return { kind: "cold-start" };
  }
  const canonicalPrevious = buildCanonicalRequest(previous.payload.wireBody);
  const previousBreakpoints = locateBreakpoints(
    previous.payload.wireBody,
    canonicalPrevious.segments
  );
  const prefixDiff = diffPrefix(
    canonicalPrefixComparisonText(canonicalPrevious),
    canonicalPrefixComparisonText(canonicalCurrent)
  );
  const pricing = getModelPricing(current.params.model);
  const provider = resolveProvider(current);
  const gateVerdict = evaluateUsageGate({
    previous,
    current,
    prefixDiff,
    breakpointDeclared,
    minCacheableBytesProxy: estimateMinCacheableBytes(pricing.minCacheableTokens),
    maxTtlMs: options.maxTtlMs ?? defaultMaxTtlMs(provider),
    provider
  });
  if (gateVerdict.kind === "miss") {
    const diagnosis = classifyMiss({
      previous,
      current,
      canonicalPrevious,
      canonicalCurrent,
      prefixDiff,
      previousBreakpoints,
      currentBreakpoints: breakpoints,
      minCacheableBytesProxy: estimateMinCacheableBytes(pricing.minCacheableTokens),
      provider,
      ...(options.confirmedPrefixTokenCounts
        ? { confirmedPrefixTokenCounts: options.confirmedPrefixTokenCounts }
        : {})
    });
    if (diagnosis) {
      return { kind: "diagnosis", diagnosis };
    }
    return { kind: "unclassified-miss", signature: gateVerdict.signature };
  }
  return { kind: gateVerdict.kind };
}
