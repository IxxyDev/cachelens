import type { Usage } from "../../core/model/call.js";
import { tokenCount } from "../../core/model/types.js";
import {
  createSseDataParser,
  isObject,
  parseJsonText,
  readNumber,
  type SseParserOptions,
  type SseUsageAccumulator,
  ZERO_USAGE
} from "../shared.js";

interface RawOpenAiUsage {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly prompt_tokens_details?: { readonly cached_tokens?: unknown } | null;
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly input_tokens_details?: { readonly cached_tokens?: unknown } | null;
}
interface RawOpenAiEvent {
  readonly type?: unknown;
  readonly response?: { readonly usage?: unknown } | null;
  readonly usage?: unknown;
}
/**
 * Maps an OpenAI `usage` object to `Usage`. Handles both Chat Completions
 * (`prompt_tokens` / `prompt_tokens_details.cached_tokens`) and the Responses
 * API (`input_tokens` / `input_tokens_details.cached_tokens`). `inputTokens`
 * excludes cached tokens; cached tokens go to `cacheReadInputTokens`; OpenAI
 * has no cache-write charge, so `cacheCreationInputTokens` is always 0.
 */
function openAiUsageFromRaw(raw: unknown): Usage {
  if (!isObject(raw)) return ZERO_USAGE;
  const u = raw as RawOpenAiUsage;
  const isChat = u.prompt_tokens !== undefined || u.completion_tokens !== undefined;
  const totalInput = readNumber(isChat ? u.prompt_tokens : u.input_tokens);
  const cached = readNumber(
    isChat ? u.prompt_tokens_details?.cached_tokens : u.input_tokens_details?.cached_tokens
  );
  return {
    inputTokens: tokenCount(Math.max(0, totalInput - cached)),
    outputTokens: tokenCount(readNumber(isChat ? u.completion_tokens : u.output_tokens)),
    cacheCreationInputTokens: tokenCount(0),
    cacheReadInputTokens: tokenCount(cached)
  };
}
export function openAiUsageFromBody(body: unknown): Usage {
  return isObject(body) ? openAiUsageFromRaw((body as { usage?: unknown }).usage) : ZERO_USAGE;
}
export function parseOpenAiUsageFromJsonText(text: string): Usage {
  return openAiUsageFromBody(parseJsonText(text));
}
const RESPONSES_TERMINAL_EVENTS: ReadonlySet<unknown> = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed"
]);
/**
 * Accumulates usage from an OpenAI SSE stream: a Chat Completions chunk with a
 * top-level `usage` (sent last when `stream_options.include_usage` is set), or
 * a Responses API terminal event (`response.completed` etc.) whose
 * `response.usage` holds the totals.
 */
export function createOpenAiSseUsageAccumulator(options?: SseParserOptions): SseUsageAccumulator {
  let usage: Usage | undefined;
  const parser = createSseDataParser((data) => {
    const event = data as RawOpenAiEvent;
    if (RESPONSES_TERMINAL_EVENTS.has(event.type)) {
      if (isObject(event.response?.usage)) {
        usage = openAiUsageFromRaw(event.response.usage);
      }
      return;
    }
    if (isObject(event.usage)) {
      usage = openAiUsageFromRaw(event.usage);
    }
  }, options);
  return {
    push(chunk) {
      parser.push(chunk);
    },
    finalize() {
      parser.end();
      return usage ?? ZERO_USAGE;
    }
  };
}
