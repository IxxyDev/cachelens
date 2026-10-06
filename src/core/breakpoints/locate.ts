import type { CacheBreakpoint, CacheTtl } from "../model/breakpoint.js";
import type { Segment } from "../serialize/segment-map.js";

interface ParsedRequestBody {
  readonly tools?: unknown;
  readonly system?: unknown;
  readonly messages?: unknown;
}
interface ParsedMessage {
  readonly content?: unknown;
}
interface CacheControlBearer {
  readonly cache_control?: unknown;
}
function extractTtl(value: unknown): CacheTtl | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const cacheControl = (value as CacheControlBearer).cache_control;
  if (cacheControl === null || typeof cacheControl !== "object") return undefined;
  const ttl = (
    cacheControl as {
      readonly ttl?: unknown;
    }
  ).ttl;
  return ttl === "1h" ? "1h" : "5m";
}
const BLOCK_PATH = /^(tools|system|messages)\[(\d+)\](?:\.content\[(\d+)\])?$/;
/**
 * The automatic breakpoint sits on the last cacheable block: the block-level segment
 * (tools[i], system[i], messages[i] or messages[i].content[j]) that starts last in the
 * canonical text, so a message's last content block wins over the enclosing message.
 */
function locateAutomaticBreakpoint(
  ttl: CacheTtl,
  segments: readonly Segment[]
): CacheBreakpoint | undefined {
  let last: { segment: Segment; index: number } | undefined;
  for (const segment of segments) {
    const match = BLOCK_PATH.exec(segment.structuralPath);
    if (!match) continue;
    if (!last || segment.start > last.segment.start) {
      last = { segment, index: Number(match[3] ?? match[2]) };
    }
  }
  if (!last) return undefined;
  return {
    byteOffset: last.segment.end,
    index: last.index,
    ttl,
    tier: last.segment.tier,
    kind: "automatic"
  };
}
/**
 * Offsets refer to the canonical text, which has every `cache_control` marker stripped:
 * an explicit breakpoint's offset is the end of the block that carried the marker.
 */
export function locateBreakpoints(
  wireBody: string,
  segments: readonly Segment[]
): CacheBreakpoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireBody);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") {
    return [];
  }
  const body = parsed as ParsedRequestBody;
  const breakpoints: CacheBreakpoint[] = [];
  const pushExplicit = (block: unknown, structuralPath: string, index: number): void => {
    const ttl = extractTtl(block);
    if (!ttl) return;
    const segment = segments.find((s) => s.structuralPath === structuralPath);
    if (segment) {
      breakpoints.push({
        byteOffset: segment.end,
        index,
        ttl,
        tier: segment.tier,
        kind: "explicit"
      });
    }
  };
  if (Array.isArray(body.tools)) {
    for (const [index, tool] of body.tools.entries()) pushExplicit(tool, `tools[${index}]`, index);
  }
  if (Array.isArray(body.system)) {
    for (const [index, block] of body.system.entries())
      pushExplicit(block, `system[${index}]`, index);
  }
  if (Array.isArray(body.messages)) {
    body.messages.forEach((message, messageIndex) => {
      if (message === null || typeof message !== "object") return;
      const content = (message as ParsedMessage).content;
      if (!Array.isArray(content)) return;
      for (const [blockIndex, block] of content.entries()) {
        pushExplicit(block, `messages[${messageIndex}].content[${blockIndex}]`, blockIndex);
      }
    });
  }
  const automaticTtl = extractTtl(body);
  if (automaticTtl) {
    const automatic = locateAutomaticBreakpoint(automaticTtl, segments);
    if (automatic) breakpoints.push(automatic);
  }
  return breakpoints;
}
