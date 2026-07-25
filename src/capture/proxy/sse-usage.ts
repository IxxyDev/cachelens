import type { Usage } from "../../core/model/call.js";
import { tokenCount } from "../../core/model/types.js";
import { ZERO_USAGE } from "../wrap/anthropic.js";
export interface SseUsageAccumulator {
  push(chunk: Buffer | string): void;
  finalize(): Usage;
}
interface SseEvent {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly usage?: unknown;
}
interface RawUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
}
export function createSseUsageAccumulator(): SseUsageAccumulator {
  let carry = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let sawMessageStart = false;
  function handleLine(rawLine: string): void {
    const line = rawLine.trimEnd();
    const prefix = "data:";
    if (!line.startsWith(prefix)) return;
    const jsonText = line.slice(prefix.length).trim();
    if (jsonText === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const event = parsed as SseEvent;
    if (event.type === "message_start") {
      const message = event.message;
      if (message === null || typeof message !== "object") return;
      const usage = (
        message as {
          usage?: unknown;
        }
      ).usage;
      if (usage === null || typeof usage !== "object") return;
      const u = usage as RawUsage;
      inputTokens = readNumber(u.input_tokens);
      outputTokens = readNumber(u.output_tokens);
      cacheCreationInputTokens = readNumber(u.cache_creation_input_tokens);
      cacheReadInputTokens = readNumber(u.cache_read_input_tokens);
      sawMessageStart = true;
      return;
    }
    if (event.type === "message_delta") {
      const usage = event.usage;
      if (usage === null || typeof usage !== "object") return;
      outputTokens = readNumber((usage as RawUsage).output_tokens);
    }
  }
  return {
    push(chunk) {
      carry += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line);
      }
    },
    finalize(): Usage {
      if (carry.length > 0) {
        handleLine(carry);
        carry = "";
      }
      if (!sawMessageStart) return ZERO_USAGE;
      return {
        inputTokens: tokenCount(inputTokens),
        outputTokens: tokenCount(outputTokens),
        cacheCreationInputTokens: tokenCount(cacheCreationInputTokens),
        cacheReadInputTokens: tokenCount(cacheReadInputTokens)
      };
    }
  };
}
function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
