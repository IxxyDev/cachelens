import { randomUUID } from "node:crypto";
import type { LlmCall, RequestParams, Usage } from "../core/model/call.js";
import type { Provider } from "../core/model/provider.js";
import type { TraceStore } from "../store/trace-store.js";
import { redactWireBody } from "./redact.js";
import type {
  CaptureContext,
  FetchLike,
  FetchResponseLike,
  SseUsageAccumulator
} from "./shared.js";
import { ZERO_USAGE } from "./shared.js";
export interface ParsedRequest {
  readonly params: RequestParams;
  /** The request asked for a streamed (SSE) response, e.g. `stream: true`. */
  readonly stream: boolean;
}
/** Provider-specific parsing plugged into `createCaptureFetch`. */
export interface CaptureAdapter {
  readonly provider: Provider;
  parseRequest(wireBody: string): ParsedRequest;
  parseUsageJson(responseJson: unknown): Usage;
  createSseUsageAccumulator(): SseUsageAccumulator;
}
export interface CaptureOptions extends CaptureContext {
  readonly store: TraceStore;
  readonly raw?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  /**
   * Receives any error raised while recording a call (body parsing, store
   * append). Recording runs after the response is handed back, so errors are
   * never thrown to the caller. Default: the first error in the process is printed to stderr
   * once, and the number of further suppressed errors is printed at process exit.
   */
  readonly onError?: (error: unknown) => void;
  /** @deprecated Alias of `onError`, kept for backward compatibility. */
  readonly onCaptureError?: (error: unknown) => void;
}
/** A capturing fetch; `flush()` resolves once every in-flight recording settled. */
export type CaptureFetch = FetchLike & {
  flush(): Promise<void>;
};
/**
 * Wraps a fetch so each successful LLM call is recorded to `options.store`.
 * The response is returned as soon as the underlying fetch resolves; usage is
 * read from a clone (a tee of the body) in the background, so streaming
 * callers receive chunks immediately and recording never delays or breaks the
 * real response.
 */
export function createCaptureFetch(adapter: CaptureAdapter, options: CaptureOptions): CaptureFetch {
  const underlyingFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? Date.now;
  const onError = options.onError ?? options.onCaptureError ?? defaultCaptureErrorReporter;
  const pending = new Set<Promise<void>>();
  const captureFetch: FetchLike = async (input, init) => {
    const startedAt = now();
    const response = await underlyingFetch(input, init);
    if (!response.ok) return response;
    let copy: FetchResponseLike;
    try {
      copy = response.clone();
    } catch (error) {
      reportSafely(onError, error);
      return response;
    }
    const recording = recordCall(adapter, options, now, init?.body, copy, startedAt).catch(
      (error: unknown) => reportSafely(onError, error)
    );
    pending.add(recording);
    void recording.finally(() => pending.delete(recording));
    return response;
  };
  return Object.assign(captureFetch, {
    async flush(): Promise<void> {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    }
  });
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/**
 * Builds the reporter used when no `onError` is passed: it never throws to the caller, prints
 * the first error verbatim, then only counts. At most one more line (the count) is printed when
 * `onExit` fires, so a broken store cannot flood stderr.
 */
export function createSuppressedErrorReporter(
  write: (text: string) => void,
  onExit: (listener: () => void) => void
): (error: unknown) => void {
  let count = 0;
  return (error) => {
    count++;
    if (count > 1) return;
    write(
      `cachelens: capture error (recording skipped; pass onError to handle capture errors): ${errorText(error)}\n`
    );
    onExit(() => {
      if (count > 1) {
        write(
          `cachelens: ${count - 1} further capture errors suppressed; pass onError to see them\n`
        );
      }
    });
  };
}
/** One reporter per process, shared by every capturing fetch without its own `onError`. */
const defaultCaptureErrorReporter = createSuppressedErrorReporter(
  (text) => process.stderr.write(text),
  (listener) => process.once("exit", listener)
);
function reportSafely(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch {
    // A throwing error handler must not surface to the caller either.
  }
}
async function recordCall(
  adapter: CaptureAdapter,
  options: CaptureOptions,
  now: () => number,
  requestBody: unknown,
  response: FetchResponseLike,
  startedAt: number
): Promise<void> {
  const wireBody = typeof requestBody === "string" ? requestBody : "";
  const request = adapter.parseRequest(wireBody);
  const usage = isEventStream(response, request)
    ? await readSseUsage(adapter, response)
    : await readJsonUsage(adapter, response);
  const durationMs = now() - startedAt;
  const call: LlmCall = {
    id: randomUUID(),
    sessionId: options.sessionId,
    stepName: options.stepName,
    ...(options.parentCallId !== undefined ? { parentCallId: options.parentCallId } : {}),
    timestamp: startedAt,
    params: request.params,
    payload: { wireBody: redactWireBody(wireBody, { raw: options.raw ?? false }) },
    usage,
    durationMs,
    provider: adapter.provider
  };
  await options.store.append(call);
}
function isEventStream(response: FetchResponseLike, request: ParsedRequest): boolean {
  if (response.body === undefined || response.body === null) return false;
  const contentType = response.headers?.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) return true;
  return request.stream && !contentType.includes("application/json");
}
async function readSseUsage(adapter: CaptureAdapter, response: FetchResponseLike): Promise<Usage> {
  const accumulator = adapter.createSseUsageAccumulator();
  const body = response.body;
  if (body === undefined || body === null) return ZERO_USAGE;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value instanceof Uint8Array || typeof value === "string") accumulator.push(value);
    }
  } catch {
    // Stream aborted or errored mid-way: record whatever usage was seen.
  }
  return accumulator.finalize();
}
async function readJsonUsage(adapter: CaptureAdapter, response: FetchResponseLike): Promise<Usage> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return ZERO_USAGE;
  }
  return adapter.parseUsageJson(body);
}
