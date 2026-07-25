import type { TokenCount } from "../model/types.js";
export interface CountTokensAdapter {
  countTokens(prefixText: string): Promise<TokenCount | undefined>;
}
export const offlineCountTokensAdapter: CountTokensAdapter = {
  async countTokens() {
    return undefined;
  }
};
export function hashPrefix(prefixText: string): string {
  let hash = 5381;
  for (let i = 0; i < prefixText.length; i++) {
    hash = (hash * 33) ^ prefixText.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
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
