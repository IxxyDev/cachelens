import { locateBreakpoints } from "../breakpoints/locate.js";
import { diffPrefix } from "../diff/prefix-diff.js";
import type { LlmCall } from "../model/call.js";
import { type Provider, resolveProvider } from "../model/provider.js";
import { type TokenCount, tokenCount, usd } from "../model/types.js";
import { type ModelPricing, tryGetModelPricing } from "../pricing/table.js";
import {
  buildCanonicalRequest,
  type CanonicalRequest,
  CanonicalRequestParseError,
  canonicalPrefixComparisonText
} from "../serialize/canonical-request.js";
import { evaluateUsageGate, type MissSignature } from "../usage/gate.js";
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
      /** The call's wire body is not a JSON object, so there is no prefix to compare. */
      readonly kind: "unparseable-request";
    }
  | {
      readonly kind: "diagnosis";
      readonly diagnosis: Diagnosis;
    }
  | {
      readonly kind: "unclassified-miss";
      readonly signature: MissSignature;
    };
/** Minimum cacheable prefix assumed for a model with no pricing entry (Anthropic and OpenAI). */
const UNPRICED_MIN_CACHEABLE_TOKENS = 1024;
/**
 * Zero-price stand-in for a model with no pricing entry, so its misses are still classified
 * structurally; the resulting dollar fields are replaced by null (unknown), never reported as $0.
 */
function unpricedStandIn(model: string, provider: Provider): ModelPricing {
  return {
    model,
    provider,
    inputPricePerMTok: usd(0),
    outputPricePerMTok: usd(0),
    minCacheableTokens: tokenCount(UNPRICED_MIN_CACHEABLE_TOKENS),
    cacheReadMultiplier: 0,
    cacheWrite5mMultiplier: 1,
    cacheWrite1hMultiplier: 1
  };
}
/** The warning for a miss the gate detected but no rule could explain. */
export function unclassifiedMissWarning(call: LlmCall, signature: MissSignature): string {
  return `call "${call.id}" (step "${call.stepName}"): cache miss with a stable prefix could not be classified (${signature}; breakpoint ignored? unsupported model?)`;
}
export interface DiagnoseOptions {
  readonly maxTtlMs?: number;
  readonly confirmedPrefixTokenCounts?: ReadonlyMap<string, TokenCount>;
  /** Called for every miss no rule classified, so callers can surface it as a warning. */
  readonly onUnclassifiedMiss?: (call: LlmCall, signature: MissSignature) => void;
}
function tryBuildCanonicalRequest(wireBody: string): CanonicalRequest | undefined {
  try {
    return buildCanonicalRequest(wireBody);
  } catch (error) {
    if (error instanceof CanonicalRequestParseError) return undefined;
    throw error;
  }
}
/** One warning per call whose wire body cannot be parsed; those calls are not diagnosed. */
export function unparseableRequestWarnings(calls: readonly LlmCall[]): string[] {
  return calls
    .filter((call) => tryBuildCanonicalRequest(call.payload.wireBody) === undefined)
    .map(
      (call) =>
        `call "${call.id}" (step "${call.stepName}") has a wire body that is not a JSON object; its cache misses are not diagnosed`
    );
}
export function diagnoseCall(
  previous: LlmCall | undefined,
  current: LlmCall,
  options: DiagnoseOptions = {}
): EngineResult {
  const canonicalCurrent = tryBuildCanonicalRequest(current.payload.wireBody);
  if (!canonicalCurrent) {
    return { kind: "unparseable-request" };
  }
  const breakpoints = locateBreakpoints(current.payload.wireBody, canonicalCurrent.segments);
  const breakpointDeclared = breakpoints.length > 0;
  if (!previous) {
    return { kind: "cold-start" };
  }
  // An unparseable partner leaves nothing to compare against: the call is as good as cold.
  const canonicalPrevious = tryBuildCanonicalRequest(previous.payload.wireBody);
  if (!canonicalPrevious) {
    return { kind: "cold-start" };
  }
  const previousBreakpoints = locateBreakpoints(
    previous.payload.wireBody,
    canonicalPrevious.segments
  );
  const prefixDiff = diffPrefix(
    canonicalPrefixComparisonText(canonicalPrevious),
    canonicalPrefixComparisonText(canonicalCurrent)
  );
  const provider = resolveProvider(current);
  const tablePricing = tryGetModelPricing(current.params.model);
  const pricing = tablePricing ?? unpricedStandIn(current.params.model, provider);
  const gateVerdict = evaluateUsageGate({
    previous,
    current,
    prefixDiff,
    breakpointDeclared,
    minCacheableBytesProxy: estimateMinCacheableBytes(pricing.minCacheableTokens),
    maxTtlMs: options.maxTtlMs ?? defaultMaxTtlMs(provider),
    provider,
    ...(breakpointDeclared
      ? { lastBreakpointOffset: Math.max(...breakpoints.map((bp) => bp.byteOffset)) }
      : {})
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
      signature: gateVerdict.signature,
      pricing,
      ...(options.confirmedPrefixTokenCounts
        ? { confirmedPrefixTokenCounts: options.confirmedPrefixTokenCounts }
        : {})
    });
    if (diagnosis) {
      return {
        kind: "diagnosis",
        diagnosis: tablePricing
          ? diagnosis
          : { ...diagnosis, wastedUsd: null, wastedUsdByTier: null }
      };
    }
    options.onUnclassifiedMiss?.(current, gateVerdict.signature);
    return { kind: "unclassified-miss", signature: gateVerdict.signature };
  }
  return { kind: gateVerdict.kind };
}
