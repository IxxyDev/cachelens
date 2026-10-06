import { createHash } from "node:crypto";
import type { TokenCount } from "../model/types.js";
export interface CountTokensAdapter {
  countTokens(prefixText: string): Promise<TokenCount | undefined>;
}
export const offlineCountTokensAdapter: CountTokensAdapter = {
  async countTokens() {
    return undefined;
  }
};
/** Collision-resistant cache key for a prefix text (SHA-256 hex digest). */
export function hashPrefix(prefixText: string): string {
  return createHash("sha256").update(prefixText, "utf8").digest("hex");
}
export function cachingCountTokensAdapter(adapter: CountTokensAdapter): CountTokensAdapter {
  const cache = new Map<string, TokenCount | undefined>();
  return {
    async countTokens(prefixText: string) {
      const key = hashPrefix(prefixText);
      if (cache.has(key)) {
        return cache.get(key);
      }
      const result = await adapter.countTokens(prefixText);
      cache.set(key, result);
      return result;
    }
  };
}
