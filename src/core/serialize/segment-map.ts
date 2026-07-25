import type { CacheTier } from "../model/tier.js";
import type { ByteOffset } from "../model/types.js";
export interface Segment {
  readonly start: ByteOffset;
  readonly end: ByteOffset;
  readonly tier: CacheTier;
  readonly structuralPath: string;
}
function matching(segments: readonly Segment[], offset: ByteOffset): Segment[] {
  return segments.filter((segment) => offset >= segment.start && offset < segment.end);
}
function mostSpecific(candidates: readonly Segment[]): Segment | undefined {
  return candidates.reduce<Segment | undefined>((best, candidate) => {
    if (!best) return candidate;
    return candidate.end - candidate.start < best.end - best.start ? candidate : best;
  }, undefined);
}
export function tierAt(segments: readonly Segment[], offset: ByteOffset): CacheTier | undefined {
  return mostSpecific(matching(segments, offset))?.tier;
}
export function structuralPathAt(
  segments: readonly Segment[],
  offset: ByteOffset
): string | undefined {
  return mostSpecific(matching(segments, offset))?.structuralPath;
}
export function tierSegment(segments: readonly Segment[], tier: CacheTier): Segment | undefined {
  return segments.find((segment) => segment.structuralPath === tier);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function byteLengthUtf8(text: string): number {
  return encoder.encode(text).length;
}
export function sliceByBytes(text: string, start: ByteOffset, end: ByteOffset): string {
  return decoder.decode(encoder.encode(text).slice(start, end));
}
