import { randomUUID } from "node:crypto";
import type { LlmCall, RequestParams, Usage } from "../../core/model/call.js";
import { tokenCount } from "../../core/model/types.js";
import type { TraceStore } from "../../store/trace-store.js";
import { redactWireBody } from "../redact.js";
export type FetchLike = (
  input: string | URL,
  init?: {
    readonly method?: string;
    readonly headers?: unknown;
    readonly body?: unknown;
    readonly signal?: unknown;
  }
) => Promise<FetchResponseLike>;
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  clone(): FetchResponseLike;
  json(): Promise<unknown>;
}
export interface CaptureContext {
  readonly sessionId: string;
  readonly stepName: string;
  readonly parentCallId?: string;
}
export interface WrapAnthropicOptions extends CaptureContext {
  readonly store: TraceStore;
  readonly raw?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly onCaptureError?: (error: unknown) => void;
}
export function createCaptureFetch(options: WrapAnthropicOptions): FetchLike {
  const underlyingFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? Date.now;
  const onCaptureError = options.onCaptureError ?? defaultCaptureErrorHandler;
  return async (input, init) => {
    const startedAt = now();
    const response = await underlyingFetch(input, init);
    const durationMs = now() - startedAt;
    if (response.ok) {
      try {
        await recordCall(options, init?.body, response.clone(), startedAt, durationMs);
      } catch (error) {
        onCaptureError(error);
      }
    }
    return response;
  };
}
function defaultCaptureErrorHandler(error: unknown): void {
  console.error("[cachelens capture] append failed:", error);
}
async function recordCall(
  options: WrapAnthropicOptions,
  requestBody: unknown,
  response: FetchResponseLike,
  startedAt: number,
  durationMs: number
): Promise<void> {
  const wireBody = typeof requestBody === "string" ? requestBody : "";
  const usage = await extractUsage(response);
  const call: LlmCall = {
    id: randomUUID(),
    sessionId: options.sessionId,
    stepName: options.stepName,
    ...(options.parentCallId !== undefined ? { parentCallId: options.parentCallId } : {}),
    timestamp: startedAt,
    params: parseRequestParams(wireBody),
    payload: { wireBody: redactWireBody(wireBody, { raw: options.raw ?? false }) },
    usage,
    durationMs
  };
  await options.store.append(call);
}
export const ZERO_USAGE: Usage = {
  inputTokens: tokenCount(0),
  outputTokens: tokenCount(0),
  cacheCreationInputTokens: tokenCount(0),
  cacheReadInputTokens: tokenCount(0)
};
interface RawUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
}
interface RawResponseBody {
  readonly usage?: unknown;
}
function usageFromParsedBody(body: unknown): Usage {
  if (body === null || typeof body !== "object") {
    return ZERO_USAGE;
  }
  const usage = (body as RawResponseBody).usage;
  if (usage === null || typeof usage !== "object") {
    return ZERO_USAGE;
  }
  const u = usage as RawUsage;
  return {
    inputTokens: tokenCount(readNumber(u.input_tokens)),
    outputTokens: tokenCount(readNumber(u.output_tokens)),
    cacheCreationInputTokens: tokenCount(readNumber(u.cache_creation_input_tokens)),
    cacheReadInputTokens: tokenCount(readNumber(u.cache_read_input_tokens))
  };
}
export function parseUsageFromJsonText(text: string): Usage {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return ZERO_USAGE;
  }
  return usageFromParsedBody(body);
}
async function extractUsage(response: FetchResponseLike): Promise<Usage> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return ZERO_USAGE;
  }
  return usageFromParsedBody(body);
}
function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
interface RawRequestBody {
  readonly model?: unknown;
  readonly tool_choice?: unknown;
  readonly thinking?: unknown;
  readonly speed?: unknown;
  readonly messages?: unknown;
  readonly system?: unknown;
}
export function parseRequestParams(wireBody: string): RequestParams {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireBody);
  } catch {
    return { model: "unknown" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { model: "unknown" };
  }
  const body = parsed as RawRequestBody;
  const model = typeof body.model === "string" ? body.model : "unknown";
  const toolChoice = describeToolChoice(body.tool_choice);
  const thinking = describeThinking(body.thinking);
  const thinkingBudgetTokens = describeThinkingBudget(body.thinking);
  const speed = typeof body.speed === "string" ? body.speed : undefined;
  const blocks = collectContentBlocks(body);
  const imagesPresent = blocks.some((block) => block.type === "image") || undefined;
  const citationsEnabled = blocks.some((block) => isCitationsEnabled(block.citations)) || undefined;
  return {
    model,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(imagesPresent !== undefined ? { imagesPresent } : {}),
    ...(citationsEnabled !== undefined ? { citationsEnabled } : {})
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
function describeToolChoice(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "type" in value) {
    const type = (
      value as {
        type: unknown;
      }
    ).type;
    return typeof type === "string" ? type : JSON.stringify(value);
  }
  return JSON.stringify(value);
}
interface RawThinking {
  readonly type?: unknown;
  readonly budget_tokens?: unknown;
}
function describeThinking(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return undefined;
  const type = (value as RawThinking).type;
  return type !== "disabled";
}
function describeThinkingBudget(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const budget = (value as RawThinking).budget_tokens;
  return typeof budget === "number" ? budget : undefined;
}
export function wrapAnthropic<TClient>(
  createClient: (fetch: FetchLike) => TClient,
  options: WrapAnthropicOptions
): TClient {
  return createClient(createCaptureFetch(options));
}
