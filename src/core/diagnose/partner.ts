import type { LlmCall } from "../model/call.js";
import { resolveProvider } from "../model/provider.js";
import {
  buildCanonicalRequest,
  type CanonicalRequest,
  CanonicalRequestParseError,
  canonicalPrefixComparisonText
} from "../serialize/canonical-request.js";

/** The longest prompt-cache TTL: nothing older can have been hit. */
const MAX_TTL_WINDOW_MS = 60 * 60 * 1000;
/** Only the most recent same-model candidates are compared, bounding the cost per call. */
export const MAX_PARTNER_CANDIDATES = 64;

/**
 * Per-run memo of each call's canonical comparison bytes, so no call is serialized twice.
 * `null` records a wire body that is not valid JSON, so it is not re-parsed either.
 */
export type PartnerCache = Map<LlmCall, Uint8Array | null>;

/** Optional work counter for selectPartner, so cost bounds can be asserted deterministically. */
export interface PartnerStats {
  /** Byte-prefix comparisons between the current call and a candidate. */
  comparisons: number;
}

const encoder = new TextEncoder();

function canonicalBytes(call: LlmCall, cache: PartnerCache): Uint8Array | null {
  const cached = cache.get(call);
  if (cached !== undefined) return cached;
  let canonical: CanonicalRequest;
  try {
    canonical = buildCanonicalRequest(call.payload.wireBody);
  } catch (error) {
    if (!(error instanceof CanonicalRequestParseError)) throw error;
    cache.set(call, null);
    return null;
  }
  const bytes = encoder.encode(canonicalPrefixComparisonText(canonical));
  cache.set(call, bytes);
  return bytes;
}

function commonPrefixLength(a: Uint8Array, b: Uint8Array): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * The prompt cache is content-addressed per model, so the call a request could have hit is the
 * earlier same-model, same-provider call within the last hour that shares the longest byte
 * prefix with it; ties go to the most recent. TTL expiry is not filtered here: it is judged
 * against the chosen partner by the ttl-expiry rule.
 *
 * `earlierCalls` must be in request order (ascending timestamp). Candidates are scanned newest
 * first; the scan stops at the first candidate whose whole canonical text is a prefix of the
 * current one (the common case of an agent loop extending its own previous turn) and after
 * MAX_PARTNER_CANDIDATES same-model candidates.
 *
 * Returns undefined when nothing qualifies (a cold start) or when `current` is not valid JSON;
 * unparseable candidates are skipped.
 */
export function selectPartner(
  current: LlmCall,
  earlierCalls: readonly LlmCall[],
  cache: PartnerCache = new Map(),
  stats?: PartnerStats
): LlmCall | undefined {
  const currentBytes = canonicalBytes(current, cache);
  if (!currentBytes) return undefined;
  const provider = resolveProvider(current);
  let best: LlmCall | undefined;
  let bestLength = -1;
  let compared = 0;
  for (let i = earlierCalls.length - 1; i >= 0 && compared < MAX_PARTNER_CANDIDATES; i--) {
    const candidate = earlierCalls[i];
    if (!candidate || candidate === current) continue;
    const gapMs = current.timestamp - candidate.timestamp;
    if (gapMs < 0) continue;
    if (gapMs > MAX_TTL_WINDOW_MS) break;
    if (candidate.params.model !== current.params.model) continue;
    if (resolveProvider(candidate) !== provider) continue;
    const bytes = canonicalBytes(candidate, cache);
    if (!bytes) continue;
    compared++;
    if (stats) stats.comparisons++;
    const length = commonPrefixLength(bytes, currentBytes);
    // Scanning newest-first, a strictly longer prefix is needed to displace a more recent candidate.
    if (length > bestLength) {
      best = candidate;
      bestLength = length;
    }
    if (length === bytes.length) break;
  }
  return best;
}
