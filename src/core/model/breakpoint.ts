import type { CacheTier } from "./tier.js";
import type { ByteOffset } from "./types.js";
export type CacheTtl = "5m" | "1h";
export interface CacheBreakpoint {
  readonly byteOffset: ByteOffset;
  readonly index: number;
  readonly ttl: CacheTtl;
  readonly tier: CacheTier;
}
