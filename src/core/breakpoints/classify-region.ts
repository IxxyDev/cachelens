import type { CacheBreakpoint } from "../model/breakpoint.js";
import type { CacheTier } from "../model/tier.js";
import type { ByteOffset } from "../model/types.js";
import { type Segment, structuralPathAt, tierAt } from "../serialize/segment-map.js";
export interface RegionClassification {
  readonly tier: CacheTier;
  readonly structuralPath: string;
  readonly nearestBreakpointBefore: CacheBreakpoint | undefined;
}
export function classifyRegion(
  divergenceByteOffset: ByteOffset,
  segments: readonly Segment[],
  breakpoints: readonly CacheBreakpoint[]
): RegionClassification {
  const tier = tierAt(segments, divergenceByteOffset) ?? "messages";
  const structuralPath = structuralPathAt(segments, divergenceByteOffset) ?? tier;
  const nearestBreakpointBefore = breakpoints
    .filter((bp) => bp.byteOffset <= divergenceByteOffset)
    .sort((a, b) => b.byteOffset - a.byteOffset)[0];
  return { tier, structuralPath, nearestBreakpointBefore };
}
