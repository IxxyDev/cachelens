import { normalizedJsonEquals } from "../diff/normalize.js";
import { diffParams } from "../diff/params-diff.js";
import type { PrefixDiffResult } from "../diff/prefix-diff.js";
import type { CacheBreakpoint, CacheTtl } from "../model/breakpoint.js";
import type { LlmCall, RequestParams, Usage } from "../model/call.js";
import type { Provider } from "../model/provider.js";
import { CACHE_TIER_ORDER, type CacheTier } from "../model/tier.js";
import {
  type ByteOffset,
  byteOffset,
  type TokenCount,
  tokenCount,
  type Usd
} from "../model/types.js";
import {
  effectiveWriteMultiplier,
  splitWastedUsdByTier,
  wastedUsdAtMultiplier
} from "../pricing/cost.js";
import type { ModelPricing } from "../pricing/table.js";
import { buildCanonicalRequest } from "../serialize/canonical-request.js";
import {
  byteLengthUtf8,
  type Segment,
  sliceByBytes,
  structuralPathAt,
  tierAt,
  tierSegment
} from "../serialize/segment-map.js";
import { excerptAroundByteOffset } from "./recommend.js";
import type { PricedDiagnosis } from "./taxonomy.js";

const SINGLE_TIER_PLACEHOLDER_BYTES: Readonly<Record<CacheTier, number>> = {
  tools: 1,
  system: 1,
  messages: 1
};
/**
 * What pricing a miss needs beyond the current call's usage. `classifyMiss` builds it once per
 * call; every field is optional so a rule can be exercised on its own.
 */
export interface WasteBasis {
  /** The partner call's usage: its read + created tokens are all that a hit could have reused. */
  readonly previousUsage?: Usage;
  /** TTL the current call's writes are billed at when its usage carries no 5m/1h split. */
  readonly writeTtl?: CacheTtl;
  readonly provider?: Provider;
  /** Canonical bytes shared with the partner (the stable zone), for the OpenAI estimate. */
  readonly stableBytes?: number;
  /** Total canonical bytes of the current request, for the OpenAI estimate. */
  readonly totalBytes?: number;
}
interface Waste {
  readonly wastedTokens: TokenCount;
  readonly wastedUsd: Usd;
  readonly wastedEstimate?: true;
}
/**
 * Anthropic: the tokens written this call that a hit could have read instead, capped at what the
 * partner held (its read + created tokens), so newly appended content is never counted, priced
 * at the blended 5m/1h write multiplier minus the read multiplier.
 * OpenAI reports no cache writes, so the stable zone's share of the prompt tokens is estimated
 * (stableBytes / totalBytes) minus what was actually read, priced at 1x minus the read multiplier.
 */
export function computeWaste(
  currentUsage: Usage,
  pricing: ModelPricing,
  basis: WasteBasis = {}
): Waste {
  if (basis.provider === "openai") {
    const { stableBytes, totalBytes } = basis;
    if (stableBytes !== undefined && totalBytes !== undefined && totalBytes > 0) {
      const promptTokens =
        currentUsage.inputTokens +
        currentUsage.cacheReadInputTokens +
        currentUsage.cacheCreationInputTokens;
      const stableTokens = Math.round(
        (Math.min(stableBytes, totalBytes) / totalBytes) * promptTokens
      );
      const missedTokens = Math.max(0, stableTokens - currentUsage.cacheReadInputTokens);
      return {
        wastedTokens: tokenCount(missedTokens),
        wastedUsd: wastedUsdAtMultiplier(missedTokens, pricing, 1),
        wastedEstimate: true
      };
    }
  }
  const reusable = basis.previousUsage
    ? basis.previousUsage.cacheReadInputTokens + basis.previousUsage.cacheCreationInputTokens
    : Number.POSITIVE_INFINITY;
  const wastedTokens = Math.min(currentUsage.cacheCreationInputTokens, reusable);
  const writeMultiplier = effectiveWriteMultiplier(currentUsage, pricing, basis.writeTtl ?? "5m");
  return {
    wastedTokens: tokenCount(wastedTokens),
    wastedUsd: wastedUsdAtMultiplier(wastedTokens, pricing, writeMultiplier)
  };
}
/** The Diagnosis waste fields for a miss invalidating `invalidatedTiers`. */
function wasteFields(
  waste: Waste,
  invalidatedTiers: readonly CacheTier[],
  tierByteLengths: Readonly<Record<CacheTier, number>> = SINGLE_TIER_PLACEHOLDER_BYTES
): Pick<PricedDiagnosis, "wastedTokens" | "wastedUsd" | "wastedUsdByTier" | "wastedEstimate"> {
  return {
    wastedTokens: waste.wastedTokens,
    wastedUsd: waste.wastedUsd,
    wastedUsdByTier: splitWastedUsdByTier(invalidatedTiers, tierByteLengths, waste.wastedUsd),
    ...(waste.wastedEstimate ? { wastedEstimate: true } : {})
  };
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
  pricing: ModelPricing,
  waste: WasteBasis = {}
): PricedDiagnosis | null {
  const scope = diffParams(previous.params, current.params);
  if (scope === "none") {
    return null;
  }
  const invalidatedTiers: CacheTier[] =
    scope === "all"
      ? ["tools", "system", "messages"]
      : scope === "system-and-messages"
        ? ["system", "messages"]
        : ["messages"];
  const tierByteLengths = tierByteLengthsFromWireBody(current.payload.wireBody);
  return {
    cause: "request-param-invalidation",
    invalidatedTiers,
    byteOffset: byteOffset(0),
    structuralPath: "params",
    excerpt: describeParamChange(previous.params, current.params),
    ...wasteFields(
      computeWaste(current.usage, pricing, { previousUsage: previous.usage, ...waste }),
      invalidatedTiers,
      tierByteLengths
    ),
    recommendation: PARAM_SCOPE_RECOMMENDATION[scope]
  };
}
const PARAM_SCOPE_RECOMMENDATION: Readonly<
  Record<Exclude<ReturnType<typeof diffParams>, "none">, string>
> = {
  all: "Keep `model` (and tool definitions) fixed for this step — a model change invalidates the entire cache prefix, all tiers.",
  "system-and-messages":
    "Keep `speed`, web search and citations fixed for this step — toggling them invalidates system+messages, but tools can survive.",
  "messages-maybe-upstream":
    "Keep `thinking` and `output_config.effort` fixed for this step — changing them invalidates the messages cache, and on some models tools+system too.",
  messages:
    "Keep `tool_choice`, images and `context_management` stable for this step — changing them invalidates the messages cache; tools and system survive."
};
function describeThinking(params: RequestParams): string {
  if (!params.thinking) return "undefined";
  const budget = params.thinking.budgetTokens;
  return budget === undefined ? params.thinking.type : `${params.thinking.type}/${budget}`;
}
function describeParamChange(previous: RequestParams, current: RequestParams): string {
  if (previous.model !== current.model) {
    return `model: "${previous.model}" -> "${current.model}"`;
  }
  if (previous.toolChoice !== current.toolChoice) {
    return `tool_choice: ${JSON.stringify(previous.toolChoice)} -> ${JSON.stringify(current.toolChoice)}`;
  }
  if (previous.inferenceGeo !== current.inferenceGeo) {
    return `inference_geo: ${String(previous.inferenceGeo)} -> ${String(current.inferenceGeo)}`;
  }
  if (previous.thinking?.type !== current.thinking?.type) {
    return `thinking: ${describeThinking(previous)} -> ${describeThinking(current)}`;
  }
  if (previous.thinking?.budgetTokens !== current.thinking?.budgetTokens) {
    return `thinking.budget_tokens: ${String(previous.thinking?.budgetTokens)} -> ${String(current.thinking?.budgetTokens)}`;
  }
  if (previous.effort !== current.effort) {
    return `output_config.effort: ${String(previous.effort)} -> ${String(current.effort)}`;
  }
  if (previous.contextManagement !== current.contextManagement) {
    return `context_management: ${String(previous.contextManagement)} -> ${String(current.contextManagement)}`;
  }
  if (previous.webSearchEnabled !== current.webSearchEnabled) {
    return `web search enabled: ${String(previous.webSearchEnabled)} -> ${String(current.webSearchEnabled)}`;
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
  readonly waste?: WasteBasis;
}): PricedDiagnosis | null {
  if (!normalizedJsonEquals(params.previousTierText, params.currentTierText)) {
    return null;
  }
  return {
    cause: "nondeterministic-serialization",
    invalidatedTiers: [params.tier],
    byteOffset: params.divergenceByteOffset,
    structuralPath: params.structuralPath,
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, params.divergenceByteOffset),
    ...wasteFields(computeWaste(params.currentUsage, params.pricing, params.waste), [params.tier]),
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
  readonly waste?: WasteBasis;
}): PricedDiagnosis | null {
  if ((params.provider ?? "anthropic") !== "anthropic") {
    return null;
  }
  if (params.current.usage.cacheCreationInputTokens <= 0) {
    return null;
  }
  // An agent loop appends a turn every call, so an expired entry shows up as "previous is a
  // prefix of current", not only as a byte-identical request.
  if (!params.prefixDiff.previousIsPrefixOfCurrent) {
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
    excerpt: `prefix ${params.prefixDiff.identical ? "byte-identical to" : "extends"} the previous call, but idle for ${gapMs}ms — past its ${ttl} TTL`,
    ...wasteFields(
      // The expired entry was written at the previous call's TTL, which overrides the basis.
      computeWaste(params.current.usage, params.pricing, {
        previousUsage: params.previous.usage,
        ...params.waste,
        writeTtl: ttl
      }),
      invalidatedTiers,
      tierByteLengths
    ),
    recommendation: `Set cache_control ttl to "1h" (currently ${ttl}), or call this step more often than every ${ttl} — the previous prefix was unchanged but idle for ${gapMs}ms.`
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
  readonly waste?: WasteBasis;
}): PricedDiagnosis | null {
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
    ...wasteFields(
      computeWaste(params.currentUsage, params.pricing, params.waste),
      invalidatedTiers,
      tierByteLengths
    ),
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
  readonly waste?: WasteBasis;
}): PricedDiagnosis | null {
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
    ...wasteFields(computeWaste(params.currentUsage, params.pricing, params.waste), [params.tier]),
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
  readonly waste?: WasteBasis;
}): PricedDiagnosis | null {
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
    ...wasteFields(computeWaste(params.currentUsage, params.pricing, params.waste), [tier]),
    recommendation: `Reduce the number of content blocks before the breakpoint (currently ${blockCount}, vendor lookback window is ${LOOKBACK_WINDOW_LIMIT}) — consolidate blocks, or move the breakpoint earlier.`
  };
}
/**
 * An early breakpoint writes nothing (creation == 0): the stable blocks after it are billed as
 * plain input instead of cache reads. Their tokens are estimated from their byte share of the
 * prompt, capped at the uncached input actually billed.
 */
function misplacedStableInputWaste(
  currentUsage: Usage,
  pricing: ModelPricing,
  misplacedBytes: number,
  totalBytes: number
): Waste {
  const promptTokens =
    currentUsage.inputTokens +
    currentUsage.cacheReadInputTokens +
    currentUsage.cacheCreationInputTokens;
  const estimated = totalBytes > 0 ? Math.round((misplacedBytes / totalBytes) * promptTokens) : 0;
  const tokens = Math.min(estimated, currentUsage.inputTokens);
  return {
    wastedTokens: tokenCount(tokens),
    wastedUsd: wastedUsdAtMultiplier(tokens, pricing, 1),
    wastedEstimate: true
  };
}
/** Block levels that accept a `cache_control` marker, i.e. where a breakpoint can sit. */
const BREAKPOINT_BLOCK_PATH = /^(?:tools|system)\[\d+\]$|^messages\[\d+\]\.content\[\d+\]$/;
/**
 * The vendor caches the prefix up to a breakpoint, and breakpoints only sit at block ends. A
 * breakpoint is misplaced when some prefix WAS served from cache (cache_read > 0: the content up
 * to the breakpoint hit) yet at least one whole block after it was stable too and is re-billed on
 * every call. With cache_read == 0 the content before the breakpoint also missed, which moving the
 * breakpoint cannot explain, so this rule does not fire.
 */
export function checkBreakpointMisplacement(params: {
  readonly prefixDiff: PrefixDiffResult;
  readonly currentBreakpoints: readonly CacheBreakpoint[];
  readonly currentUsage: Usage;
  readonly minCacheableBytesProxy: number;
  readonly currentSegments: readonly Segment[];
  readonly canonicalCurrentText: string;
  readonly pricing: ModelPricing;
  readonly provider?: Provider;
  readonly waste?: WasteBasis;
}): PricedDiagnosis | null {
  if ((params.provider ?? "anthropic") !== "anthropic") {
    return null;
  }
  if (params.currentBreakpoints.length === 0) {
    return null;
  }
  if (params.currentUsage.cacheReadInputTokens <= 0) {
    return null;
  }
  const stableBytes = params.prefixDiff.divergenceByteOffset;
  if (stableBytes < params.minCacheableBytesProxy) {
    return null;
  }
  const lastBreakpointOffset = Math.max(...params.currentBreakpoints.map((bp) => bp.byteOffset));
  const stableBlocksAfterBreakpoint = params.currentSegments.filter(
    (s) =>
      BREAKPOINT_BLOCK_PATH.test(s.structuralPath) &&
      s.start >= lastBreakpointOffset &&
      s.end <= stableBytes
  );
  const target = stableBlocksAfterBreakpoint.reduce<Segment | undefined>(
    (latest, s) => (!latest || s.end > latest.end ? s : latest),
    undefined
  );
  if (!target) {
    return null;
  }
  const suggestedOffset = target.end;
  const waste =
    params.currentUsage.cacheCreationInputTokens === 0
      ? misplacedStableInputWaste(
          params.currentUsage,
          params.pricing,
          suggestedOffset - lastBreakpointOffset,
          params.waste?.totalBytes ?? byteLengthUtf8(params.canonicalCurrentText)
        )
      : computeWaste(params.currentUsage, params.pricing, params.waste);
  return {
    cause: "breakpoint-misplacement",
    invalidatedTiers: [target.tier],
    byteOffset: suggestedOffset,
    structuralPath: target.structuralPath,
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, suggestedOffset),
    ...wasteFields(waste, [target.tier]),
    recommendation: `Move the cache breakpoint to the end of ${target.structuralPath} (canonical offset ${suggestedOffset}) — the last breakpoint is at offset ${lastBreakpointOffset}, leaving ${stableBlocksAfterBreakpoint.length} stable block${stableBlocksAfterBreakpoint.length === 1 ? "" : "s"} outside the cached prefix.`
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
  readonly waste?: WasteBasis;
}): PricedDiagnosis | null {
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
  return {
    cause: "prefix-too-short",
    invalidatedTiers,
    byteOffset: byteOffset(stableBytes),
    structuralPath: "prefix",
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, byteOffset(stableBytes)),
    ...wasteFields(
      computeWaste(params.currentUsage, params.pricing, params.waste),
      invalidatedTiers
    ),
    recommendation: `The stable prefix is ${params.confirmedTokenCount} tokens, below this model's ${params.minCacheableTokens}-token minimum for caching — consolidate more static content above the threshold, or accept that this step won't cache.`
  };
}
/** Rough bytes-per-token ratio for English-like text, used only when no token count is known. */
const BYTES_PER_TOKEN_ESTIMATE = 4;
/**
 * prefix-too-short without a count_tokens result: a breakpoint is declared on an unchanged or
 * extended prefix, yet the API read and wrote nothing (gate signature-2). When the canonical
 * bytes up to the last breakpoint are below the min-cacheable byte proxy, the likeliest cause
 * is that the vendor silently ignored a breakpoint on a too-short prefix. The token figure is a
 * byte-based estimate and the diagnosis is flagged `wastedEstimate`.
 */
export function checkPrefixTooShortByBytes(params: {
  readonly currentBreakpoints: readonly CacheBreakpoint[];
  readonly prefixDiff: PrefixDiffResult;
  readonly minCacheableBytesProxy: number;
  readonly minCacheableTokens: TokenCount;
  readonly canonicalCurrentText: string;
  readonly currentUsage: Usage;
  readonly pricing: ModelPricing;
  readonly provider?: Provider;
  readonly waste?: WasteBasis;
}): PricedDiagnosis | null {
  if ((params.provider ?? "anthropic") !== "anthropic") {
    return null;
  }
  if (params.currentBreakpoints.length === 0 || !params.prefixDiff.previousIsPrefixOfCurrent) {
    return null;
  }
  const { cacheReadInputTokens, cacheCreationInputTokens } = params.currentUsage;
  if (cacheReadInputTokens !== 0 || cacheCreationInputTokens !== 0) {
    return null;
  }
  const cachedBytes = Math.max(...params.currentBreakpoints.map((bp) => bp.byteOffset));
  if (cachedBytes >= params.minCacheableBytesProxy) {
    return null;
  }
  const estimatedTokens = Math.round(cachedBytes / BYTES_PER_TOKEN_ESTIMATE);
  const invalidatedTiers = [...CACHE_TIER_ORDER];
  const waste = computeWaste(params.currentUsage, params.pricing, params.waste);
  return {
    cause: "prefix-too-short",
    invalidatedTiers,
    byteOffset: byteOffset(cachedBytes),
    structuralPath: "prefix",
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, byteOffset(cachedBytes)),
    ...wasteFields({ ...waste, wastedEstimate: true }, invalidatedTiers),
    recommendation: `The prefix up to the last cache breakpoint is ~${estimatedTokens} tokens (estimated from bytes: ${cachedBytes} bytes at ~${BYTES_PER_TOKEN_ESTIMATE} bytes/token), below this model's ${params.minCacheableTokens}-token minimum, and nothing was read or written — the breakpoint was likely ignored. Confirm with count_tokens, then put more static content before the breakpoint, or accept that this step won't cache.`
  };
}
export function buildDynamicPrefixContentDiagnosis(params: {
  readonly tier: CacheTier;
  readonly structuralPath: string;
  readonly divergenceByteOffset: ByteOffset;
  readonly canonicalCurrentText: string;
  readonly currentUsage: Usage;
  readonly pricing: ModelPricing;
  readonly waste?: WasteBasis;
}): PricedDiagnosis {
  return {
    cause: "dynamic-prefix-content",
    invalidatedTiers: [params.tier],
    byteOffset: params.divergenceByteOffset,
    structuralPath: params.structuralPath,
    excerpt: excerptAroundByteOffset(params.canonicalCurrentText, params.divergenceByteOffset),
    ...wasteFields(computeWaste(params.currentUsage, params.pricing, params.waste), [params.tier]),
    recommendation: `Move the dynamic content at ${params.structuralPath} (canonical offset ${params.divergenceByteOffset}) after the last stable cache breakpoint, or exclude it from the cached prefix entirely.`
  };
}
