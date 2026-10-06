import { normalizeSortedKeys } from "../../core/diff/normalize.js";
import type { RequestParams, ThinkingParams, ThinkingType } from "../../core/model/call.js";
import {
  type CaptureAdapter,
  type CaptureFetch,
  type CaptureOptions,
  createCaptureFetch
} from "../capture-fetch.js";
import { type FetchLike, isObject, parseJsonText, requestsStream } from "../shared.js";
import {
  anthropicUsageFromBody,
  createAnthropicSseUsageAccumulator,
  parseAnthropicUsageFromJsonText
} from "../usage/anthropic.js";

export type { CaptureFetch } from "../capture-fetch.js";
export type { CaptureContext, FetchLike, FetchResponseLike } from "../shared.js";
export { ZERO_USAGE } from "../shared.js";
export interface WrapAnthropicOptions extends CaptureOptions {}
export const anthropicCaptureAdapter: CaptureAdapter = {
  provider: "anthropic",
  parseRequest: (wireBody) => ({
    params: parseRequestParams(wireBody),
    stream: requestsStream(wireBody)
  }),
  parseUsageJson: anthropicUsageFromBody,
  createSseUsageAccumulator: createAnthropicSseUsageAccumulator
};
export function createAnthropicCaptureFetch(options: WrapAnthropicOptions): CaptureFetch {
  return createCaptureFetch(anthropicCaptureAdapter, options);
}
export const parseUsageFromJsonText = parseAnthropicUsageFromJsonText;
interface RawRequestBody {
  readonly model?: unknown;
  readonly tool_choice?: unknown;
  readonly thinking?: unknown;
  readonly output_config?: unknown;
  readonly context_management?: unknown;
  readonly inference_geo?: unknown;
  readonly speed?: unknown;
  readonly tools?: unknown;
  readonly messages?: unknown;
  readonly system?: unknown;
}
export function parseRequestParams(wireBody: string): RequestParams {
  const parsed = parseJsonText(wireBody);
  if (!isObject(parsed)) {
    return { model: "unknown" };
  }
  const body = parsed as RawRequestBody;
  const model = typeof body.model === "string" ? body.model : "unknown";
  const toolChoice = describeToolChoice(body.tool_choice);
  const thinking = describeThinking(body.thinking);
  const effort = readString(
    (body.output_config as { readonly effort?: unknown } | null | undefined)?.effort
  );
  const contextManagement =
    body.context_management === undefined
      ? undefined
      : JSON.stringify(normalizeSortedKeys(body.context_management));
  const inferenceGeo = readString(body.inference_geo);
  const speed = readString(body.speed);
  const webSearchEnabled = isWebSearchPresent(body.tools) || undefined;
  const blocks = collectContentBlocks(body);
  const imagesPresent = blocks.some((block) => block.type === "image") || undefined;
  const citationsEnabled = blocks.some((block) => isCitationsEnabled(block.citations)) || undefined;
  return {
    model,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(contextManagement !== undefined ? { contextManagement } : {}),
    ...(inferenceGeo !== undefined ? { inferenceGeo } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(imagesPresent !== undefined ? { imagesPresent } : {}),
    ...(citationsEnabled !== undefined ? { citationsEnabled } : {}),
    ...(webSearchEnabled !== undefined ? { webSearchEnabled } : {})
  };
}
interface RawContentBlock {
  readonly type?: unknown;
  readonly citations?: unknown;
}
function collectContentBlocks(body: RawRequestBody): readonly RawContentBlock[] {
  const blocks: RawContentBlock[] = [];
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const content = (
        message as {
          content?: unknown;
        } | null
      )?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block !== null && typeof block === "object") {
            blocks.push(block as RawContentBlock);
          }
        }
      }
    }
  }
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block !== null && typeof block === "object") {
        blocks.push(block as RawContentBlock);
      }
    }
  }
  return blocks;
}
function isCitationsEnabled(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return (
    (
      value as {
        enabled?: unknown;
      }
    ).enabled === true
  );
}
/**
 * `tool_choice` as one comparable string: the type, plus `:<name>` for a forced tool
 * (`{ type: "tool", name: "x" }` -> `"tool:x"`), so switching the forced tool is a param change.
 */
function describeToolChoice(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "type" in value) {
    const { type, name } = value as { readonly type: unknown; readonly name?: unknown };
    if (typeof type !== "string") return JSON.stringify(value);
    return typeof name === "string" ? `${type}:${name}` : type;
  }
  return JSON.stringify(value);
}
interface RawThinking {
  readonly type?: unknown;
  readonly budget_tokens?: unknown;
}
function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function isWebSearchPresent(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    const type = (tool as { readonly type?: unknown } | null)?.type;
    return typeof type === "string" && type.startsWith("web_search");
  });
}
function describeThinking(value: unknown): ThinkingParams | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as RawThinking;
  const type: ThinkingType =
    raw.type === "adaptive" || raw.type === "disabled" ? raw.type : "enabled";
  const budgetTokens = typeof raw.budget_tokens === "number" ? raw.budget_tokens : undefined;
  return budgetTokens !== undefined ? { type, budgetTokens } : { type };
}
export function wrapAnthropic<TClient>(
  createClient: (fetch: FetchLike) => TClient,
  options: WrapAnthropicOptions
): TClient {
  return createClient(createAnthropicCaptureFetch(options));
}
