import type { CacheTier } from "./tier.js";
import type { ByteOffset } from "./types.js";
export type CacheTtl = "5m" | "1h";
/**
 * "explicit": a block-level `cache_control` marker (tools[i], system[i], messages[i].content[j]).
 * "automatic": a top-level request `cache_control` (automatic caching) — the vendor places the
 * breakpoint at the last cacheable block, so it sits at the end of the canonical request.
 * Absent means "explicit".
 */
export type CacheBreakpointKind = "explicit" | "automatic";
export interface CacheBreakpoint {
  readonly byteOffset: ByteOffset;
  readonly index: number;
  readonly ttl: CacheTtl;
  readonly tier: CacheTier;
  readonly kind?: CacheBreakpointKind;
}
