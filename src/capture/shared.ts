import type { Usage } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
/** The subset of a WHATWG `ReadableStream` the capture layer reads. */
export interface ByteStreamLike {
  getReader(): {
    read(): Promise<{
      readonly done: boolean;
      readonly value?: unknown;
    }>;
  };
}
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: {
    get(name: string): string | null;
  };
  readonly body?: ByteStreamLike | null;
  clone(): FetchResponseLike;
  json(): Promise<unknown>;
}
export type FetchLike = (
  input: string | URL,
  init?: {
    readonly method?: string;
    readonly headers?: unknown;
    readonly body?: unknown;
    readonly signal?: unknown;
  }
) => Promise<FetchResponseLike>;
export interface CaptureContext {
  readonly sessionId: string;
  readonly stepName: string;
  readonly parentCallId?: string;
}
export const ZERO_USAGE: Usage = {
  inputTokens: tokenCount(0),
  outputTokens: tokenCount(0),
  cacheCreationInputTokens: tokenCount(0),
  cacheReadInputTokens: tokenCount(0)
};
export interface SseUsageAccumulator {
  push(chunk: Uint8Array | string): void;
  finalize(): Usage;
}
export function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
export function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
export function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
/** True when a JSON request body sets `stream: true`. */
export function requestsStream(wireBody: string): boolean {
  const parsed = parseJsonText(wireBody);
  return isObject(parsed) && (parsed as { readonly stream?: unknown }).stream === true;
}
/** Longest SSE line (in UTF-16 code units, ~bytes for ASCII JSON) the parser keeps in memory. */
const DEFAULT_MAX_SSE_LINE_LENGTH = 1024 * 1024;
export interface SseParserOptions {
  /** Lines longer than this are dropped (with a warning) instead of buffered. Default 1 MiB. */
  readonly maxLineLength?: number;
  readonly onWarning?: (message: string) => void;
}
/**
 * Splits an SSE byte/text stream into `data:` lines and hands each parsed JSON
 * payload to `onData`. Non-JSON payloads (e.g. OpenAI's `[DONE]`) are skipped.
 * Multi-byte UTF-8 sequences split across chunks are decoded correctly. A line
 * longer than `maxLineLength` is dropped so an unterminated line cannot grow
 * the carry buffer without bound.
 */
export function createSseDataParser(
  onData: (data: unknown) => void,
  options: SseParserOptions = {}
): {
  push(chunk: Uint8Array | string): void;
  end(): void;
} {
  const decoder = new TextDecoder("utf-8");
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_SSE_LINE_LENGTH;
  let carry = "";
  /** The start of the current line was already dropped; skip through its end. */
  let discarding = false;
  function warnOversized(): void {
    options.onWarning?.(`SSE line longer than ${maxLineLength} characters dropped`);
  }
  function handleLine(rawLine: string): void {
    if (rawLine.length > maxLineLength) {
      warnOversized();
      return;
    }
    const line = rawLine.trimEnd();
    const prefix = "data:";
    if (!line.startsWith(prefix)) return;
    const jsonText = line.slice(prefix.length).trim();
    if (jsonText === "") return;
    const parsed = parseJsonText(jsonText);
    if (isObject(parsed)) onData(parsed);
  }
  function drain(text: string): void {
    carry += text;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (discarding) {
        discarding = false;
        continue;
      }
      handleLine(line);
    }
    if (carry.length > maxLineLength) {
      if (!discarding) warnOversized();
      discarding = true;
      carry = "";
    }
  }
  return {
    push(chunk) {
      drain(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    },
    end() {
      drain(decoder.decode());
      if (carry.length > 0 && !discarding) {
        handleLine(carry);
      }
      carry = "";
      discarding = false;
    }
  };
}
