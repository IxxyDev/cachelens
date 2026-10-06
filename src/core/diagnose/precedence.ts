import type { PrefixDiffResult } from "../diff/prefix-diff.js";
import type { CacheBreakpoint } from "../model/breakpoint.js";
import type { LlmCall } from "../model/call.js";
import { DEFAULT_PROVIDER, type Provider } from "../model/provider.js";
import type { ByteOffset, TokenCount } from "../model/types.js";
import { writeTtlFromBreakpoints } from "../pricing/cost.js";
import { hashPrefix } from "../pricing/count-tokens.js";
import { getModelPricing, type ModelPricing } from "../pricing/table.js";
import type { CanonicalRequest } from "../serialize/canonical-request.js";
import { sliceByBytes, structuralPathAt, tierAt, tierSegment } from "../serialize/segment-map.js";
import type { MissSignature } from "../usage/gate.js";
import {
  buildDynamicPrefixContentDiagnosis,
  checkBreakpointMisplacement,
  checkContentBlockChurn,
  checkLookbackWindowExceeded,
  checkNondeterministicSerialization,
  checkPrefixTooShort,
  checkPrefixTooShortByBytes,
  checkRequestParamInvalidation,
  checkToolsTierDrift,
  checkTtlExpiry,
  type WasteBasis
} from "./rules.js";
import type { Diagnosis } from "./taxonomy.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/**
 * The first `end` bytes of `text`, cut back to a UTF-8 character boundary: the divergence offset
 * can fall inside a multibyte character shared by both requests only in its leading bytes.
 */
export function stablePrefixText(text: string, end: ByteOffset): string {
  const bytes = encoder.encode(text);
  let cut = Math.min(end, bytes.length);
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return decoder.decode(bytes.subarray(0, cut));
}
export interface ClassifyMissParams {
  readonly previous: LlmCall;
  readonly current: LlmCall;
  readonly canonicalPrevious: CanonicalRequest;
  readonly canonicalCurrent: CanonicalRequest;
  readonly prefixDiff: PrefixDiffResult;
  readonly previousBreakpoints: readonly CacheBreakpoint[];
  readonly currentBreakpoints: readonly CacheBreakpoint[];
  readonly minCacheableBytesProxy: number;
  readonly confirmedPrefixTokenCounts?: ReadonlyMap<string, TokenCount>;
  readonly provider?: Provider;
  /** The gate's miss signature; signature-3 (early breakpoint) is classified by misplacement only. */
  readonly signature?: MissSignature;
  /**
   * Pricing to classify with; defaults to the model's table entry. The engine passes a zero-price
   * stand-in for an unpriced model so the miss is still classified structurally.
   */
  readonly pricing?: ModelPricing;
}
export function classifyMiss(params: ClassifyMissParams): Diagnosis | undefined {
  const pricing = params.pricing ?? getModelPricing(params.current.params.model);
  const cmp = params.prefixDiff;
  const provider = params.provider ?? DEFAULT_PROVIDER;
  const waste: WasteBasis = {
    previousUsage: params.previous.usage,
    writeTtl: writeTtlFromBreakpoints(params.currentBreakpoints),
    provider,
    stableBytes: cmp.divergenceByteOffset,
    totalBytes: params.canonicalCurrent.byteLength
  };
  const checkMisplacement = () =>
    checkBreakpointMisplacement({
      prefixDiff: cmp,
      currentBreakpoints: params.currentBreakpoints,
      currentUsage: params.current.usage,
      minCacheableBytesProxy: params.minCacheableBytesProxy,
      currentSegments: params.canonicalCurrent.segments,
      canonicalCurrentText: params.canonicalCurrent.text,
      pricing,
      provider,
      waste
    });
  if (params.signature === "signature-3") {
    return checkMisplacement() ?? undefined;
  }
  const paramDiagnosis = checkRequestParamInvalidation(
    params.previous,
    params.current,
    pricing,
    waste
  );
  if (paramDiagnosis) {
    return paramDiagnosis;
  }
  const ttlDiagnosis = checkTtlExpiry({
    previous: params.previous,
    current: params.current,
    previousBreakpoints: params.previousBreakpoints,
    prefixDiff: cmp,
    pricing,
    provider,
    waste
  });
  if (ttlDiagnosis) {
    return ttlDiagnosis;
  }
  const tier = tierAt(params.canonicalCurrent.segments, cmp.divergenceByteOffset) ?? "messages";
  const structuralPath =
    structuralPathAt(params.canonicalCurrent.segments, cmp.divergenceByteOffset) ?? tier;
  const previousTierSegment = tierSegment(params.canonicalPrevious.segments, tier);
  const currentTierSegment = tierSegment(params.canonicalCurrent.segments, tier);
  if (previousTierSegment && currentTierSegment) {
    const previousTierText = sliceByBytes(
      params.canonicalPrevious.text,
      previousTierSegment.start,
      previousTierSegment.end
    );
    const currentTierText = sliceByBytes(
      params.canonicalCurrent.text,
      currentTierSegment.start,
      currentTierSegment.end
    );
    if (previousTierText !== currentTierText) {
      const toolsDrift = checkToolsTierDrift({
        tier,
        previousToolsText: previousTierText,
        currentToolsText: currentTierText,
        divergenceByteOffset: cmp.divergenceByteOffset,
        canonicalCurrentText: params.canonicalCurrent.text,
        currentUsage: params.current.usage,
        pricing,
        waste
      });
      if (toolsDrift) {
        return toolsDrift;
      }
      const nondeterministic = checkNondeterministicSerialization({
        tier,
        structuralPath,
        previousTierText,
        currentTierText,
        divergenceByteOffset: cmp.divergenceByteOffset,
        canonicalCurrentText: params.canonicalCurrent.text,
        currentUsage: params.current.usage,
        pricing,
        waste
      });
      if (nondeterministic) {
        return nondeterministic;
      }
    }
  }
  const misplacement = checkMisplacement();
  if (misplacement) {
    return misplacement;
  }
  const prefixText = stablePrefixText(params.canonicalCurrent.text, cmp.divergenceByteOffset);
  const tooShort = checkPrefixTooShort({
    currentBreakpoints: params.currentBreakpoints,
    prefixDiff: cmp,
    confirmedTokenCount: params.confirmedPrefixTokenCounts?.get(hashPrefix(prefixText)),
    minCacheableTokens: pricing.minCacheableTokens,
    canonicalCurrentText: params.canonicalCurrent.text,
    currentUsage: params.current.usage,
    pricing,
    provider,
    waste
  });
  if (tooShort) {
    return tooShort;
  }
  if (params.signature === "signature-2") {
    const tooShortByBytes = checkPrefixTooShortByBytes({
      currentBreakpoints: params.currentBreakpoints,
      prefixDiff: cmp,
      minCacheableBytesProxy: params.minCacheableBytesProxy,
      minCacheableTokens: pricing.minCacheableTokens,
      canonicalCurrentText: params.canonicalCurrent.text,
      currentUsage: params.current.usage,
      pricing,
      provider,
      waste
    });
    if (tooShortByBytes) {
      return tooShortByBytes;
    }
  }
  if (cmp.identical || cmp.previousIsPrefixOfCurrent) {
    return undefined;
  }
  const churn = checkContentBlockChurn({
    tier,
    structuralPath,
    divergenceByteOffset: cmp.divergenceByteOffset,
    currentSegments: params.canonicalCurrent.segments,
    canonicalCurrentText: params.canonicalCurrent.text,
    currentUsage: params.current.usage,
    pricing,
    waste
  });
  if (churn) {
    return churn;
  }
  const lookback = checkLookbackWindowExceeded({
    currentSegments: params.canonicalCurrent.segments,
    currentBreakpoints: params.currentBreakpoints,
    stableByteOffset: cmp.divergenceByteOffset,
    canonicalCurrentText: params.canonicalCurrent.text,
    currentUsage: params.current.usage,
    pricing,
    provider,
    waste
  });
  if (lookback) {
    return lookback;
  }
  return buildDynamicPrefixContentDiagnosis({
    tier,
    structuralPath,
    divergenceByteOffset: cmp.divergenceByteOffset,
    canonicalCurrentText: params.canonicalCurrent.text,
    currentUsage: params.current.usage,
    pricing,
    waste
  });
}
