import type { RequestParams } from "../model/call.js";
/**
 * Which cache tiers a request-param change invalidates. Mapping (vendor prompt-caching
 * invalidation table, platform.claude.com, fetched 2026-10-06):
 *
 * | change                               | scope                     | tiers                                   |
 * |--------------------------------------|---------------------------|-----------------------------------------|
 * | model                                | "all"                     | tools + system + messages               |
 * | tool definitions                     | (not a param, see below)  | tools + system + messages               |
 * | inference_geo (not in vendor table)  | "all"                     | tools + system + messages (conservative)|
 * | web_search tool / citations toggled  | "system-and-messages"     | system + messages                       |
 * | speed (fast vs standard)             | "system-and-messages"     | system + messages                       |
 * | thinking (type, budget_tokens)       | "messages-maybe-upstream" | messages; tools + system model-specific |
 * | output_config.effort                 | "messages-maybe-upstream" | messages; tools + system model-specific |
 * | tool_choice                          | "messages"                | messages                                |
 * | images added/removed                 | "messages"                | messages                                |
 * | context_management (not in table)    | "messages"                | messages (edits apply to message turns) |
 *
 * Tool-definition changes are not request params: they show up as a byte divergence in the
 * canonical `tools` tier (prefix diff), which already invalidates everything after it.
 * When several params change at once, the broadest scope wins (all > system-and-messages >
 * messages-maybe-upstream > messages).
 */
export type ParamInvalidationScope =
  | "none"
  | "all"
  | "system-and-messages"
  | "messages-maybe-upstream"
  | "messages";
const SCOPE_RANK: Readonly<Record<ParamInvalidationScope, number>> = {
  none: 0,
  messages: 1,
  "messages-maybe-upstream": 2,
  "system-and-messages": 3,
  all: 4
};
/** Omitting `output_config.effort` equals the model default, which is "high". */
const DEFAULT_EFFORT = "high";
function thinkingChanged(previous: RequestParams, current: RequestParams): boolean {
  return (
    (previous.thinking?.type ?? "disabled") !== (current.thinking?.type ?? "disabled") ||
    previous.thinking?.budgetTokens !== current.thinking?.budgetTokens
  );
}
export function diffParams(
  previous: RequestParams,
  current: RequestParams
): ParamInvalidationScope {
  const changed: ParamInvalidationScope[] = [];
  if (previous.model !== current.model || previous.inferenceGeo !== current.inferenceGeo) {
    changed.push("all");
  }
  if (
    previous.speed !== current.speed ||
    previous.citationsEnabled !== current.citationsEnabled ||
    previous.webSearchEnabled !== current.webSearchEnabled
  ) {
    changed.push("system-and-messages");
  }
  if (
    thinkingChanged(previous, current) ||
    (previous.effort ?? DEFAULT_EFFORT) !== (current.effort ?? DEFAULT_EFFORT)
  ) {
    changed.push("messages-maybe-upstream");
  }
  if (
    previous.toolChoice !== current.toolChoice ||
    previous.imagesPresent !== current.imagesPresent ||
    previous.contextManagement !== current.contextManagement
  ) {
    changed.push("messages");
  }
  return changed.reduce<ParamInvalidationScope>(
    (broadest, scope) => (SCOPE_RANK[scope] > SCOPE_RANK[broadest] ? scope : broadest),
    "none"
  );
}
