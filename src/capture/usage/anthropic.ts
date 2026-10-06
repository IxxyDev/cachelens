import type { Usage } from "../../core/model/call.js";
import { tokenCount } from "../../core/model/types.js";
import {
  createSseDataParser,
  isObject,
  parseJsonText,
  readNumber,
  readOptionalNumber,
  type SseParserOptions,
  type SseUsageAccumulator,
  ZERO_USAGE
} from "../shared.js";

interface RawAnthropicUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: unknown;
    readonly ephemeral_1h_input_tokens?: unknown;
  } | null;
}
interface RawAnthropicEvent {
  readonly type?: unknown;
  readonly message?: { readonly usage?: unknown } | null;
  readonly usage?: unknown;
}
/** Maps an Anthropic `usage` object (JSON body or SSE event) to `Usage`. */
function anthropicUsageFromRaw(raw: unknown): Usage {
  if (!isObject(raw)) return ZERO_USAGE;
  const u = raw as RawAnthropicUsage;
  const split = isObject(u.cache_creation) ? u.cache_creation : undefined;
  const fiveMinute = readOptionalNumber(split?.ephemeral_5m_input_tokens);
  const oneHour = readOptionalNumber(split?.ephemeral_1h_input_tokens);
  return {
    inputTokens: tokenCount(readNumber(u.input_tokens)),
    outputTokens: tokenCount(readNumber(u.output_tokens)),
    cacheCreationInputTokens: tokenCount(readNumber(u.cache_creation_input_tokens)),
    cacheReadInputTokens: tokenCount(readNumber(u.cache_read_input_tokens)),
    ...(fiveMinute !== undefined ? { cacheCreation5mInputTokens: tokenCount(fiveMinute) } : {}),
    ...(oneHour !== undefined ? { cacheCreation1hInputTokens: tokenCount(oneHour) } : {})
  };
}
export function anthropicUsageFromBody(body: unknown): Usage {
  return isObject(body) ? anthropicUsageFromRaw((body as { usage?: unknown }).usage) : ZERO_USAGE;
}
export function parseAnthropicUsageFromJsonText(text: string): Usage {
  return anthropicUsageFromBody(parseJsonText(text));
}
/**
 * Accumulates usage from an Anthropic Messages SSE stream: `message_start`
 * carries input/cache usage, each `message_delta` carries cumulative usage
 * (always `output_tokens`, newer API versions also input/cache counts).
 */
export function createAnthropicSseUsageAccumulator(
  options?: SseParserOptions
): SseUsageAccumulator {
  let usage: Usage | undefined;
  const parser = createSseDataParser((data) => {
    const event = data as RawAnthropicEvent;
    if (event.type === "message_start") {
      if (isObject(event.message?.usage)) {
        usage = anthropicUsageFromRaw(event.message.usage);
      }
      return;
    }
    if (event.type === "message_delta" && usage !== undefined && isObject(event.usage)) {
      usage = mergeDelta(usage, event.usage as RawAnthropicUsage);
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
function mergeDelta(current: Usage, delta: RawAnthropicUsage): Usage {
  const pick = (value: unknown, fallback: number): number => readOptionalNumber(value) ?? fallback;
  return {
    ...current,
    inputTokens: tokenCount(pick(delta.input_tokens, current.inputTokens)),
    outputTokens: tokenCount(pick(delta.output_tokens, current.outputTokens)),
    cacheCreationInputTokens: tokenCount(
      pick(delta.cache_creation_input_tokens, current.cacheCreationInputTokens)
    ),
    cacheReadInputTokens: tokenCount(
      pick(delta.cache_read_input_tokens, current.cacheReadInputTokens)
    )
  };
}
