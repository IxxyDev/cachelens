import { randomUUID } from "node:crypto";
import type { LlmCall, RequestParams, Usage } from "../../core/model/call.js";
import { tokenCount } from "../../core/model/types.js";
import type { TraceStore } from "../../store/trace-store.js";
import { redactWireBody } from "../redact.js";
import type { CaptureContext, FetchLike, FetchResponseLike } from "./anthropic.js";
import { ZERO_USAGE } from "./anthropic.js";
export interface WrapOpenAiOptions extends CaptureContext {
  readonly store: TraceStore;
  readonly raw?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly onCaptureError?: (error: unknown) => void;
}
export function createOpenAiCaptureFetch(options: WrapOpenAiOptions): FetchLike {
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
  options: WrapOpenAiOptions,
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
    params: parseOpenAiRequestParams(wireBody),
    payload: { wireBody: redactWireBody(wireBody, { raw: options.raw ?? false }) },
    usage,
    durationMs,
    provider: "openai"
  };
  await options.store.append(call);
}
interface RawOpenAiUsage {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: unknown;
  };
}
interface RawOpenAiResponseBody {
  readonly usage?: unknown;
}
export function usageFromOpenAiBody(body: unknown): Usage {
  if (body === null || typeof body !== "object") {
    return ZERO_USAGE;
  }
  const usage = (body as RawOpenAiResponseBody).usage;
  if (usage === null || typeof usage !== "object") {
    return ZERO_USAGE;
  }
  const u = usage as RawOpenAiUsage;
  const promptTokens = readNumber(u.prompt_tokens);
  const cachedTokens = readNumber(u.prompt_tokens_details?.cached_tokens);
  const nonCachedInputTokens = Math.max(0, promptTokens - cachedTokens);
  return {
    inputTokens: tokenCount(nonCachedInputTokens),
    outputTokens: tokenCount(readNumber(u.completion_tokens)),
    cacheCreationInputTokens: tokenCount(0),
    cacheReadInputTokens: tokenCount(cachedTokens)
  };
}
export function parseOpenAiUsageFromJsonText(text: string): Usage {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return ZERO_USAGE;
  }
  return usageFromOpenAiBody(body);
}
async function extractUsage(response: FetchResponseLike): Promise<Usage> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return ZERO_USAGE;
  }
  return usageFromOpenAiBody(body);
}
function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
interface RawOpenAiRequestBody {
  readonly model?: unknown;
}
export function parseOpenAiRequestParams(wireBody: string): RequestParams {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireBody);
  } catch {
    return { model: "unknown" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { model: "unknown" };
  }
  const body = parsed as RawOpenAiRequestBody;
  const model = typeof body.model === "string" ? body.model : "unknown";
  return { model };
}
export function wrapOpenAi<TClient>(
  createClient: (fetch: FetchLike) => TClient,
  options: WrapOpenAiOptions
): TClient {
  return createClient(createOpenAiCaptureFetch(options));
}
