import type { LlmCall } from "../model/call.js";
export function aggregateHitRate(calls: readonly LlmCall[]): number {
  let totalRead = 0;
  let totalRelevant = 0;
  for (const call of calls) {
    const { cacheReadInputTokens, cacheCreationInputTokens, inputTokens } = call.usage;
    totalRead += cacheReadInputTokens;
    totalRelevant += cacheReadInputTokens + cacheCreationInputTokens + inputTokens;
  }
  return totalRelevant === 0 ? 0 : totalRead / totalRelevant;
}
