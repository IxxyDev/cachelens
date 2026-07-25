import type { RequestParams } from "../model/call.js";
export type ParamInvalidationScope = "none" | "all" | "system-and-messages";
export function diffParams(
  previous: RequestParams,
  current: RequestParams
): ParamInvalidationScope {
  if (previous.model !== current.model) {
    return "all";
  }
  if (
    previous.toolChoice !== current.toolChoice ||
    previous.thinking !== current.thinking ||
    previous.thinkingBudgetTokens !== current.thinkingBudgetTokens ||
    previous.speed !== current.speed ||
    previous.imagesPresent !== current.imagesPresent ||
    previous.citationsEnabled !== current.citationsEnabled
  ) {
    return "system-and-messages";
  }
  return "none";
}
