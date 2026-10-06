import type { RequestParams } from "../../core/model/call.js";
import {
  type CaptureAdapter,
  type CaptureFetch,
  type CaptureOptions,
  createCaptureFetch
} from "../capture-fetch.js";
import { type FetchLike, isObject, parseJsonText, requestsStream } from "../shared.js";
import {
  createOpenAiSseUsageAccumulator,
  openAiUsageFromBody,
  parseOpenAiUsageFromJsonText
} from "../usage/openai.js";

export type { CaptureFetch } from "../capture-fetch.js";
export type { CaptureContext, FetchLike, FetchResponseLike } from "../shared.js";
export { parseOpenAiUsageFromJsonText };
export const usageFromOpenAiBody = openAiUsageFromBody;
export interface WrapOpenAiOptions extends CaptureOptions {}
export const openAiCaptureAdapter: CaptureAdapter = {
  provider: "openai",
  parseRequest: (wireBody) => ({
    params: parseOpenAiRequestParams(wireBody),
    stream: requestsStream(wireBody)
  }),
  parseUsageJson: openAiUsageFromBody,
  createSseUsageAccumulator: createOpenAiSseUsageAccumulator
};
export function createOpenAiCaptureFetch(options: WrapOpenAiOptions): CaptureFetch {
  return createCaptureFetch(openAiCaptureAdapter, options);
}
/**
 * Extracts request params from a Chat Completions body (`messages`) or a
 * Responses API body (`input` / `instructions`); both carry a top-level
 * `model` and `tool_choice`.
 */
export function parseOpenAiRequestParams(wireBody: string): RequestParams {
  const body = parseJsonText(wireBody);
  if (!isObject(body)) {
    return { model: "unknown" };
  }
  const raw = body as { readonly model?: unknown; readonly tool_choice?: unknown };
  const model = typeof raw.model === "string" ? raw.model : "unknown";
  const toolChoice = describeToolChoice(raw.tool_choice);
  return { model, ...(toolChoice !== undefined ? { toolChoice } : {}) };
}
/**
 * `tool_choice` as one comparable string: the type, plus `:<name>` for a forced function
 * (Chat `{ type: "function", function: { name } }` or Responses `{ type: "function", name }`),
 * so switching the forced function is a param change.
 */
function describeToolChoice(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (!isObject(value)) return JSON.stringify(value);
  const {
    type,
    name,
    function: fn
  } = value as {
    readonly type?: unknown;
    readonly name?: unknown;
    readonly function?: unknown;
  };
  if (typeof type !== "string") return JSON.stringify(value);
  const fnName = isObject(fn) ? (fn as { readonly name?: unknown }).name : undefined;
  const forced = typeof name === "string" ? name : fnName;
  return typeof forced === "string" ? `${type}:${forced}` : type;
}
export function wrapOpenAi<TClient>(
  createClient: (fetch: FetchLike) => TClient,
  options: WrapOpenAiOptions
): TClient {
  return createClient(createOpenAiCaptureFetch(options));
}
