import { normalizedJsonEquals } from "../diff/normalize.js";
import { diffParams } from "../diff/params-diff.js";
import type { PrefixDiffResult } from "../diff/prefix-diff.js";
import type { CacheBreakpoint, CacheTtl } from "../model/breakpoint.js";
import type { LlmCall, RequestParams, Usage } from "../model/call.js";
import type { Provider } from "../model/provider.js";
import { CACHE_TIER_ORDER, type CacheTier } from "../model/tier.js";
import { type ByteOffset, type TokenCount, type Usd, byteOffset } from "../model/types.js";
import { computeTieredCounterfactual, computeWastedUsd } from "../pricing/cost.js";
import type { ModelPricing } from "../pricing/table.js";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import {
  type Segment,
  byteLengthUtf8,
  sliceByBytes,
  structuralPathAt,
  tierAt,
  tierSegment
} from "../serialize/segment-map.js";
import { excerptAroundByteOffset } from "./recommend.js";
import type { Diagnosis } from "./taxonomy.js";
const SINGLE_TIER_PLACEHOLDER_BYTES: Readonly<Record<CacheTier, number>> = {
  tools: 1,
  system: 1,
  messages: 1
};
function singleTierWastedUsdByTier(
  tier: CacheTier,
  wastedTokens: TokenCount,
  pricing: ModelPricing,
  ttl: CacheTtl
): ReadonlyMap<CacheTier, Usd> {
  return computeTieredCounterfactual({
    invalidatedTiers: [tier],
    tierByteLengths: SINGLE_TIER_PLACEHOLDER_BYTES,
    cacheCreationInputTokens: wastedTokens,
    pricing,
    ttl
  }).wastedUsdByTier;
}
function tierByteLength(segments: readonly Segment[], tier: CacheTier): number {
  const segment = tierSegment(segments, tier);
  return segment ? segment.end - segment.start : 0;
}
function tierByteLengthsFromWireBody(wireBody: string): Record<CacheTier, number> {
  try {
    const { segments } = buildCanonicalRequest(wireBody);
    return {
      tools: tierByteLength(segments, "tools"),
      system: tierByteLength(segments, "system"),
      messages: tierByteLength(segments, "messages")
    };
  } catch {
    return { tools: 1, system: 1, messages: 1 };
  }
}
function tierByteLengthsForToolsDrift(
  canonicalCurrentText: string,
  currentToolsText: string
): Record<CacheTier, number> {
  const totalBytes = byteLengthUtf8(canonicalCurrentText);
  const toolsBytes = byteLengthUtf8(currentToolsText);
  const remainingBytes = Math.max(0, totalBytes - toolsBytes);
  return { tools: toolsBytes, system: remainingBytes / 2, messages: remainingBytes / 2 };
}
export function checkRequestParamInvalidation(
  previous: LlmCall,
  current: LlmCall,
  pricing: ModelPricing
): Diagnosis | null {
  const scope = diffParams(previous.params, current.params);
  if (scope === "none") {
    return null;
  }
  const invalidatedTiers: CacheTier[] =
    scope === "all" ? ["tools", "system", "messages"] : ["system", "messages"];
  const tierByteLengths = tierByteLengthsFromWireBody(current.payload.wireBody);
  return {
    cause: "request-param-invalidation",
    invalidatedTiers,
    byteOffset: byteOffset(0),
    structuralPath: "params",
    excerpt: describeParamChange(previous.params, current.params),
    wastedTokens: current.usage.cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(current.usage.cacheCreationInputTokens, pricing, "5m"),
    wastedUsdByTier: computeTieredCounterfactual({
      invalidatedTiers,
      tierByteLengths,
      cacheCreationInputTokens: current.usage.cacheCreationInputTokens,
      pricing,
      ttl: "5m"
    }).wastedUsdByTier,
    recommendation:
      scope === "all"
        ? "Keep `model` (and tool definitions) fixed for this step — a model change invalidates the entire cache prefix, all tiers."
        : "Fix `tool_choice`/`thinking` for this step, or move whichever varies below the cache breakpoint — these invalidate system+messages, but tools can survive."
  };
}
function describeParamChange(previous: RequestParams, current: RequestParams): string {
  if (previous.model !== current.model) {
    return `model: "${previous.model}" -> "${current.model}"`;
  }
  if (previous.toolChoice !== current.toolChoice) {
    return `tool_choice: ${JSON.stringify(previous.toolChoice)} -> ${JSON.stringify(current.toolChoice)}`;
  }
  if (previous.thinking !== current.thinking) {
    return `thinking: ${String(previous.thinking)} -> ${String(current.thinking)}`;
  }
  if (previous.thinkingBudgetTokens !== current.thinkingBudgetTokens) {
    return `thinking.budget_tokens: ${String(previous.thinkingBudgetTokens)} -> ${String(current.thinkingBudgetTokens)}`;
  }
  if (previous.speed !== current.speed) {
    return `speed: ${String(previous.speed)} -> ${String(current.speed)}`;
  }
  if (previous.imagesPresent !== current.imagesPresent) {
    return `images present: ${String(previous.imagesPresent)} -> ${String(current.imagesPresent)}`;
  }
  if (previous.citationsEnabled !== current.citationsEnabled) {
    return `citations enabled: ${String(previous.citationsEnabled)} -> ${String(current.citationsEnabled)}`;
  }
  return "request params changed";
}
export function checkNondeterministicSerialization(params: {
  readonly tier: CacheTier;
  readonly structuralPath: string;
  readonly previousTierText: string;
  readonly currentTierText: string;
  readonly divergenceByteOffset: ByteOffset;
  readonly canonicalCurrentText: string;
  readonly currentUsage: Usage;
  readonly pricing: ModelPricing;
}): Diagnosis | null {
  if (!normalizedJsonEquals(params.previousTierText, params.currentTierText)) {
    return null;
  }
  return {
    cause: "nondeterministic-serialization",
    invalidatedTiers: [params.tier],
    byteOffset: params.divergenceByteOffset,
    structuralPath: params.structuralPath,
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, params.divergenceByteOffset),
    wastedTokens: params.currentUsage.cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(params.currentUsage.cacheCreationInputTokens, params.pricing, "5m"),
    wastedUsdByTier: singleTierWastedUsdByTier(
      params.tier,
      params.currentUsage.cacheCreationInputTokens,
      params.pricing,
      "5m"
    ),
    recommendation: `Canonicalize serialization of the ${params.tier} tier (e.g. sort object keys before sending) — the content is identical here, only key order differs.`
  };
}
export function checkTtlExpiry(params: {
  readonly previous: LlmCall;
  readonly current: LlmCall;
  readonly previousBreakpoints: readonly CacheBreakpoint[];
  readonly prefixDiff: PrefixDiffResult;
  readonly pricing: ModelPricing;
  readonly provider?: Provider;
}): Diagnosis | null {
  if ((params.provider ?? "anthropic") !== "anthropic") {
    return null;
  }
  if (params.current.usage.cacheCreationInputTokens <= 0) {
    return null;
  }
  if (!params.prefixDiff.identical) {
    return null;
  }
  if (diffParams(params.previous.params, params.current.params) !== "none") {
    return null;
  }
  const ttl = lastDeclaredTtl(params.previousBreakpoints) ?? "5m";
  const ttlMs = ttlToMs(ttl);
  const gapMs = params.current.timestamp - params.previous.timestamp;
  if (gapMs <= ttlMs) {
    return null;
  }
  const invalidatedTiers = [...CACHE_TIER_ORDER];
  const tierByteLengths = tierByteLengthsFromWireBody(params.current.payload.wireBody);
  return {
    cause: "ttl-expiry",
    invalidatedTiers,
    byteOffset: byteOffset(0),
    structuralPath: "prefix",
    excerpt: `prefix byte-identical to the previous call, but idle for ${gapMs}ms — past its ${ttl} TTL`,
    wastedTokens: params.current.usage.cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(params.current.usage.cacheCreationInputTokens, params.pricing, ttl),
    wastedUsdByTier: computeTieredCounterfactual({
      invalidatedTiers,
      tierByteLengths,
      cacheCreationInputTokens: params.current.usage.cacheCreationInputTokens,
      pricing: params.pricing,
      ttl
    }).wastedUsdByTier,
    recommendation: `Set cache_control ttl to "1h" (currently ${ttl}), or call this step more often than every ${ttl} — the prefix was unchanged but idle for ${gapMs}ms.`
  };
}
function lastDeclaredTtl(breakpoints: readonly CacheBreakpoint[]): CacheTtl | undefined {
  if (breakpoints.length === 0) {
    return undefined;
  }
  return breakpoints.reduce((latest, bp) => (bp.byteOffset > latest.byteOffset ? bp : latest)).ttl;
}
function ttlToMs(ttl: CacheTtl): number {
  return ttl === "1h" ? 60 * 60 * 1000 : 5 * 60 * 1000;
}
export function checkToolsTierDrift(params: {
  readonly tier: CacheTier;
  readonly previousToolsText: string;
  readonly currentToolsText: string;
  readonly divergenceByteOffset: ByteOffset;
  readonly canonicalCurrentText: string;
  readonly currentUsage: Usage;
  readonly pricing: ModelPricing;
}): Diagnosis | null {
  if (params.tier !== "tools") {
    return null;
  }
  if (normalizedJsonEquals(params.previousToolsText, params.currentToolsText)) {
    return null;
  }
  const invalidatedTiers = [...CACHE_TIER_ORDER];
  const tierByteLengths = tierByteLengthsForToolsDrift(
    params.canonicalCurrentText,
    params.currentToolsText
  );
  return {
    cause: "tools-tier-drift",
    invalidatedTiers,
    byteOffset: params.divergenceByteOffset,
    structuralPath: "tools",
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, params.divergenceByteOffset),
    wastedTokens: params.currentUsage.cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(params.currentUsage.cacheCreationInputTokens, params.pricing, "5m"),
    wastedUsdByTier: computeTieredCounterfactual({
      invalidatedTiers,
      tierByteLengths,
      cacheCreationInputTokens: params.currentUsage.cacheCreationInputTokens,
      pricing: params.pricing,
      ttl: "5m"
    }).wastedUsdByTier,
    recommendation:
      "Keep the tool set (names, order, schemas) stable for this step, and place any cache breakpoint after `tools` — a tool-definition change invalidates the entire prefix (tools+system+messages)."
  };
}
export function checkContentBlockChurn(params: {
  readonly tier: CacheTier;
  readonly structuralPath: string;
  readonly divergenceByteOffset: ByteOffset;
  readonly currentSegments: readonly Segment[];
  readonly canonicalCurrentText: string;
  readonly currentUsage: Usage;
  readonly pricing: ModelPricing;
}): Diagnosis | null {
  if (!/\.content\[\d+\]$/.test(params.structuralPath)) {
    return null;
  }
  const segment = params.currentSegments.find((s) => s.structuralPath === params.structuralPath);
  if (!segment) {
    return null;
  }
  const blockType = parseBlockType(
    sliceByBytes(params.canonicalCurrentText, segment.start, segment.end)
  );
  if (!blockType || blockType === "text") {
    return null;
  }
  return {
    cause: "content-block-churn",
    invalidatedTiers: [params.tier],
    byteOffset: params.divergenceByteOffset,
    structuralPath: params.structuralPath,
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, params.divergenceByteOffset),
    wastedTokens: params.currentUsage.cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(params.currentUsage.cacheCreationInputTokens, params.pricing, "5m"),
    wastedUsdByTier: singleTierWastedUsdByTier(
      params.tier,
      params.currentUsage.cacheCreationInputTokens,
      params.pricing,
      "5m"
    ),
    recommendation: `Move the "${blockType}" block at ${params.structuralPath} after the cache breakpoint, or keep it byte-stable across calls — non-text content blocks changing before the breakpoint invalidate everything after them.`
  };
}
function parseBlockType(blockText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blockText);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const type = (
    parsed as {
      type?: unknown;
    }
  ).type;
  return typeof type === "string" ? type : undefined;
}
const LOOKBACK_WINDOW_LIMIT = 20;
export function checkLookbackWindowExceeded(params: {
  readonly currentSegments: readonly Segment[];
  readonly currentBreakpoints: readonly CacheBreakpoint[];
  readonly stableByteOffset: ByteOffset;
  readonly canonicalCurrentText: string;
  readonly currentUsage: Usage;
  readonly pricing: ModelPricing;
  readonly provider?: Provider;
}): Diagnosis | null {
  if ((params.provider ?? "anthropic") !== "anthropic") {
    return null;
  }
  if (params.currentBreakpoints.length === 0) {
    return null;
  }
  const breakpointOffset = Math.max(...params.currentBreakpoints.map((bp) => bp.byteOffset));
  if (breakpointOffset <= params.stableByteOffset) {
    return null;
  }
  const blockCount = params.currentSegments.filter(
    (s) =>
      /content\[\d+\]$/.test(s.structuralPath) &&
      s.start >= params.stableByteOffset &&
      s.start < breakpointOffset
  ).length;
  if (blockCount <= LOOKBACK_WINDOW_LIMIT) {
    return null;
  }
  const tier = tierAt(params.currentSegments, byteOffset(breakpointOffset)) ?? "messages";
  const structuralPath =
    structuralPathAt(params.currentSegments, byteOffset(breakpointOffset)) ?? tier;
  return {
    cause: "lookback-window-exceeded",
    invalidatedTiers: [tier],
    byteOffset: byteOffset(breakpointOffset),
    structuralPath,
    excerpt: `${blockCount} content blocks between the last stable cache point and the declared breakpoint (limit ${LOOKBACK_WINDOW_LIMIT})`,
    wastedTokens: params.currentUsage.cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(params.currentUsage.cacheCreationInputTokens, params.pricing, "5m"),
    wastedUsdByTier: singleTierWastedUsdByTier(
      tier,
      params.currentUsage.cacheCreationInputTokens,
      params.pricing,
      "5m"
    ),
    recommendation: `Reduce the number of content blocks before the breakpoint (currently ${blockCount}, vendor lookback window is ${LOOKBACK_WINDOW_LIMIT}) — consolidate blocks, or move the breakpoint earlier.`
  };
}
export function checkBreakpointMisplacement(params: {
  readonly prefixDiff: PrefixDiffResult;
  readonly currentBreakpoints: readonly CacheBreakpoint[];
  readonly currentUsage: Usage;
  readonly minCacheableBytesProxy: number;
  readonly currentSegments: readonly Segment[];
  readonly canonicalCurrentText: string;
  readonly pricing: ModelPricing;
  readonly provider?: Provider;
}): Diagnosis | null {
  if ((params.provider ?? "anthropic") !== "anthropic") {
    return null;
  }
  if (params.currentBreakpoints.length === 0) {
    return null;
  }
  const stableBytes = params.prefixDiff.divergenceByteOffset;
  if (stableBytes < params.minCacheableBytesProxy) {
    return null;
  }
  const { cacheCreationInputTokens, cacheReadInputTokens } = params.currentUsage;
  const qualifyingSignature =
    (cacheCreationInputTokens === 0 && cacheReadInputTokens === 0) ||
    (cacheCreationInputTokens > 0 && cacheReadInputTokens === 0);
  if (!qualifyingSignature) {
    return null;
  }
  const lastBreakpointOffset = Math.max(...params.currentBreakpoints.map((bp) => bp.byteOffset));
  if (lastBreakpointOffset >= stableBytes) {
    return null;
  }
  const tier = tierAt(params.currentSegments, byteOffset(stableBytes)) ?? "messages";
  const structuralPath = structuralPathAt(params.currentSegments, byteOffset(stableBytes)) ?? tier;
  return {
    cause: "breakpoint-misplacement",
    invalidatedTiers: [tier],
    byteOffset: byteOffset(stableBytes),
    structuralPath,
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, byteOffset(stableBytes)),
    wastedTokens: cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(cacheCreationInputTokens, params.pricing, "5m"),
    wastedUsdByTier: singleTierWastedUsdByTier(
      tier,
      cacheCreationInputTokens,
      params.pricing,
      "5m"
    ),
    recommendation: `Move the cache breakpoint to wire-body offset ${stableBytes} (the end of the stable zone) — it's currently declared earlier, at offset ${lastBreakpointOffset}, leaving stable content outside the cached prefix.`
  };
}
export function checkPrefixTooShort(params: {
  readonly currentBreakpoints: readonly CacheBreakpoint[];
  readonly prefixDiff: PrefixDiffResult;
  readonly confirmedTokenCount: TokenCount | undefined;
  readonly minCacheableTokens: TokenCount;
  readonly canonicalCurrentText: string;
  readonly currentUsage: Usage;
  readonly pricing: ModelPricing;
  readonly provider?: Provider;
}): Diagnosis | null {
  if ((params.provider ?? "anthropic") !== "anthropic") {
    return null;
  }
  if (params.currentBreakpoints.length === 0) {
    return null;
  }
  if (params.confirmedTokenCount === undefined) {
    return null;
  }
  if (params.confirmedTokenCount >= params.minCacheableTokens) {
    return null;
  }
  const stableBytes = params.prefixDiff.divergenceByteOffset;
  const invalidatedTiers = [...CACHE_TIER_ORDER];
  const tierByteLengths = { tools: 1, system: 1, messages: 1 };
  return {
    cause: "prefix-too-short",
    invalidatedTiers,
    byteOffset: byteOffset(stableBytes),
    structuralPath: "prefix",
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, byteOffset(stableBytes)),
    wastedTokens: params.currentUsage.cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(params.currentUsage.cacheCreationInputTokens, params.pricing, "5m"),
    wastedUsdByTier: computeTieredCounterfactual({
      invalidatedTiers,
      tierByteLengths,
      cacheCreationInputTokens: params.currentUsage.cacheCreationInputTokens,
      pricing: params.pricing,
      ttl: "5m"
    }).wastedUsdByTier,
    recommendation: `The stable prefix is ${params.confirmedTokenCount} tokens, below this model's ${params.minCacheableTokens}-token minimum for caching — consolidate more static content above the threshold, or accept that this step won't cache.`
  };
}
export function buildDynamicPrefixContentDiagnosis(params: {
  readonly tier: CacheTier;
  readonly structuralPath: string;
  readonly divergenceByteOffset: ByteOffset;
  readonly canonicalCurrentText: string;
  readonly currentUsage: Usage;
  readonly pricing: ModelPricing;
}): Diagnosis {
  return {
    cause: "dynamic-prefix-content",
    invalidatedTiers: [params.tier],
    byteOffset: params.divergenceByteOffset,
    structuralPath: params.structuralPath,
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, params.divergenceByteOffset),
    wastedTokens: params.currentUsage.cacheCreationInputTokens,
    wastedUsd: computeWastedUsd(params.currentUsage.cacheCreationInputTokens, params.pricing, "5m"),
    wastedUsdByTier: singleTierWastedUsdByTier(
      params.tier,
      params.currentUsage.cacheCreationInputTokens,
      params.pricing,
      "5m"
    ),
    recommendation: `Move the dynamic content at ${params.structuralPath} (wire-body offset ${params.divergenceByteOffset}) after the last stable cache breakpoint, or exclude it from the cached prefix entirely.`
  };
}
