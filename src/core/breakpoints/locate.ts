import type { CacheBreakpoint, CacheTtl } from "../model/breakpoint.js";
import { type Segment, tierSegment } from "../serialize/segment-map.js";
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
  if (Array.isArray(body.system)) {
    body.system.forEach((block, index) => {
      const ttl = extractTtl(block);
      if (!ttl) return;
      const segment = segments.find((s) => s.structuralPath === `system[${index}]`);
      if (segment) {
        breakpoints.push({ byteOffset: segment.end, index, ttl, tier: "system" });
      }
    });
  }
  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, index) => {
      const ttl = extractTtl(tool);
      if (!ttl) return;
      const segment = tierSegment(segments, "tools");
      if (segment) {
        breakpoints.push({ byteOffset: segment.end, index, ttl, tier: "tools" });
      }
    });
  }
  if (Array.isArray(body.messages)) {
    body.messages.forEach((message, messageIndex) => {
      if (message === null || typeof message !== "object") return;
      const content = (message as ParsedMessage).content;
      if (!Array.isArray(content)) return;
      content.forEach((block, blockIndex) => {
        const ttl = extractTtl(block);
        if (!ttl) return;
        const structuralPath = `messages[${messageIndex}].content[${blockIndex}]`;
        const segment = segments.find((s) => s.structuralPath === structuralPath);
        if (segment) {
          breakpoints.push({ byteOffset: segment.end, index: blockIndex, ttl, tier: "messages" });
        }
      });
    });
  }
  return breakpoints;
}
