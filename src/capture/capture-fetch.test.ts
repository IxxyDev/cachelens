import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmCall } from "../core/model/call.js";
import { MemoryTraceStore } from "../store/memory-store.js";
import type { TraceStore } from "../store/trace-store.js";
import {
  type CaptureAdapter,
  createCaptureFetch,
  createSuppressedErrorReporter
} from "./capture-fetch.js";
import type { FetchLike, FetchResponseLike } from "./shared.js";
import { anthropicCaptureAdapter } from "./wrap/anthropic.js";
import { openAiCaptureAdapter } from "./wrap/openai.js";

function jsonResponse(body: unknown): FetchResponseLike {
  const response: FetchResponseLike = {
    ok: true,
    status: 200,
    clone: () => jsonResponse(body),
    json: async () => body
  };
  return response;
}
function sse(data: unknown, event?: string): string {
  return `${event !== undefined ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}
interface StreamState {
  ended: boolean;
  /** Settles once `release()` is called. */
  readonly released: Promise<void>;
  /** Lets the stream emit everything after its first chunk. */
  release(): void;
}
function streamState(): StreamState {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ended: false, released, release: () => release() };
}
/**
 * A real `Response` that emits its first chunk at once and holds the rest until
 * `state.release()`, so "the caller saw the first chunk before the stream ended"
 * is an ordering guarantee rather than a timing race.
 */
function streamingResponse(
  chunks: readonly string[],
  state: StreamState,
  contentType: string | undefined = "text/event-stream"
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index > 0) await state.released;
      const chunk = chunks[index];
      if (chunk === undefined) {
        state.ended = true;
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    }
  });
  return new Response(stream, {
    status: 200,
    headers: contentType !== undefined ? { "content-type": contentType } : {}
  });
}
async function readFirstThenDrain(
  response: FetchResponseLike,
  state: StreamState
): Promise<{
  readonly first: string;
  readonly endedBeforeFirstRead: boolean;
  readonly full: string;
}> {
  const body = (response as Response).body;
  if (body === null) throw new Error("expected a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const firstRead = await reader.read();
  const endedBeforeFirstRead = state.ended;
  state.release();
  const first = decoder.decode(firstRead.value, { stream: true });
  let full = first;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
  }
  return { first, endedBeforeFirstRead, full };
}
const CONTEXT = { sessionId: "s1", stepName: "step1" } as const;
describe("createCaptureFetch: non-blocking recording", () => {
  it("resolves the response before a slow store append completes", async () => {
    const appended: LlmCall[] = [];
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const slowStore: TraceStore = {
      append: async (call) => {
        await gate;
        appended.push(call);
      },
      list: async () => appended
    };
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store: slowStore,
      fetch: async () => jsonResponse({ usage: { input_tokens: 3, output_tokens: 1 } })
    });
    // The store is blocked until the gate opens, so resolving here proves the
    // caller never waits on the append.
    await fetch("https://api.anthropic.com/v1/messages", { body: '{"model":"m"}' });
    expect(appended).toHaveLength(0);
    openGate();
    await fetch.flush();
    expect(appended).toHaveLength(1);
    expect(appended[0]?.usage.inputTokens).toBe(3);
  });
  it("routes store errors to onError and never throws them to the caller", async () => {
    const errors: unknown[] = [];
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store: {
        append: async () => {
          throw new Error("disk full");
        },
        list: async () => []
      },
      fetch: async () => jsonResponse({ usage: {} }),
      onError: (error) => errors.push(error)
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    expect(response.ok).toBe(true);
    await fetch.flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("disk full");
  });
  describe("default error handling", () => {
    afterEach(() => vi.restoreAllMocks());
    it("never throws to the caller and writes at most one stderr line for many errors", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const throwingAdapter: CaptureAdapter = {
        ...anthropicCaptureAdapter,
        parseRequest: () => {
          throw new Error("parse exploded");
        }
      };
      const fetch = createCaptureFetch(throwingAdapter, {
        ...CONTEXT,
        store: new MemoryTraceStore(),
        fetch: async () => jsonResponse({})
      });
      for (let i = 0; i < 3; i++) {
        await expect(
          fetch("https://api.anthropic.com/v1/messages", { body: "{}" })
        ).resolves.toBeDefined();
      }
      await expect(fetch.flush()).resolves.toBeUndefined();
      // The reporter is per process: the first error anywhere prints, later ones only count.
      expect(stderr.mock.calls.length).toBeLessThanOrEqual(1);
    });
    it("reporter prints the first error verbatim, then the suppressed count at exit", () => {
      const lines: string[] = [];
      const exitListeners: (() => void)[] = [];
      const report = createSuppressedErrorReporter(
        (text) => lines.push(text),
        (listener) => exitListeners.push(listener)
      );
      report(new Error("disk full"));
      report(new Error("disk full again"));
      report("third");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("disk full");
      expect(lines[0]).toContain("pass onError");
      for (const listener of exitListeners) listener();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("2 further capture errors suppressed");
    });
    it("reporter prints nothing at exit after a single error", () => {
      const lines: string[] = [];
      const exitListeners: (() => void)[] = [];
      const report = createSuppressedErrorReporter(
        (text) => lines.push(text),
        (listener) => exitListeners.push(listener)
      );
      report(new Error("once"));
      for (const listener of exitListeners) listener();
      expect(lines).toHaveLength(1);
    });
  });
  it("does not surface an onError handler that itself throws", async () => {
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store: {
        append: async () => {
          throw new Error("disk full");
        },
        list: async () => []
      },
      fetch: async () => jsonResponse({}),
      onError: () => {
        throw new Error("handler broke");
      }
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    await expect(fetch.flush()).resolves.toBeUndefined();
  });
});
describe("createCaptureFetch: streaming responses", () => {
  it("Anthropic SSE: first chunk reaches the caller before the stream ends; usage incl. 5m/1h split is recorded", async () => {
    const state = streamState();
    const chunks = [
      sse(
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 12,
              output_tokens: 1,
              cache_creation_input_tokens: 300,
              cache_read_input_tokens: 4000,
              cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }
            }
          }
        },
        "message_start"
      ),
      sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }),
      sse({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }),
      sse({ type: "message_delta", usage: { output_tokens: 57 } }, "message_delta"),
      sse({ type: "message_stop" }, "message_stop")
    ];
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => streamingResponse(chunks, state)
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      body: JSON.stringify({ model: "claude-opus-4-8", stream: true, messages: [] })
    });
    expect(state.ended).toBe(false);
    const { first, endedBeforeFirstRead, full } = await readFirstThenDrain(response, state);
    expect(endedBeforeFirstRead).toBe(false);
    expect(first).toContain("message_start");
    expect(full).toBe(chunks.join(""));
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage).toEqual({
      inputTokens: 12,
      outputTokens: 57,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 4000,
      cacheCreation5mInputTokens: 100,
      cacheCreation1hInputTokens: 200
    });
    expect(call?.provider).toBe("anthropic");
    expect(call?.params.model).toBe("claude-opus-4-8");
  });
  it("delivers the first chunk to the caller before the stream ends (ordering)", async () => {
    const state = streamState();
    const events: string[] = [];
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () =>
        streamingResponse(
          [
            sse({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
            sse({ type: "message_delta", usage: { output_tokens: 2 } })
          ],
          state
        )
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    const body = (response as Response).body;
    if (body === null) throw new Error("expected a body");
    const reader = body.getReader();
    await reader.read();
    events.push(state.ended ? "first-chunk-after-end" : "first-chunk-before-end");
    state.release();
    while (!(await reader.read()).done) {
      // drain
    }
    events.push("stream-ended");
    expect(events).toEqual(["first-chunk-before-end", "stream-ended"]);
  });
  it("OpenAI Chat Completions SSE: usage from the final include_usage chunk", async () => {
    const state = streamState();
    const chunks = [
      sse({ id: "c1", object: "chat.completion.chunk", choices: [{ delta: { content: "Hi" } }] }),
      sse({ id: "c1", object: "chat.completion.chunk", choices: [{ delta: { content: "!" } }] }),
      sse({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 768 }
        }
      }),
      "data: [DONE]\n\n"
    ];
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(openAiCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => streamingResponse(chunks, state)
    });
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      body: JSON.stringify({
        model: "gpt-4o",
        stream: true,
        stream_options: { include_usage: true },
        messages: []
      })
    });
    const { first } = await readFirstThenDrain(response, state);
    expect(first).toContain('"Hi"');
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage).toEqual({
      inputTokens: 232,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 768
    });
    expect(call?.provider).toBe("openai");
  });
  it("OpenAI Responses API SSE: usage from the response.completed event", async () => {
    const state = streamState();
    const chunks = [
      sse({ type: "response.created", response: { id: "r1" } }, "response.created"),
      sse({ type: "response.output_text.delta", delta: "Hello" }, "response.output_text.delta"),
      sse(
        {
          type: "response.completed",
          response: {
            id: "r1",
            usage: {
              input_tokens: 2048,
              output_tokens: 33,
              input_tokens_details: { cached_tokens: 1024 },
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 2081
            }
          }
        },
        "response.completed"
      )
    ];
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(openAiCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => streamingResponse(chunks, state)
    });
    const response = await fetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ model: "gpt-5", stream: true, instructions: "be brief", input: "hi" })
    });
    expect(state.ended).toBe(false);
    const { first } = await readFirstThenDrain(response, state);
    expect(first).toContain("response.created");
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage).toEqual({
      inputTokens: 1024,
      outputTokens: 33,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1024
    });
    expect(call?.params.model).toBe("gpt-5");
  });
  it("treats a body as SSE when the request set stream: true and no content-type is sent", async () => {
    const state = streamState();
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () =>
        streamingResponse(
          [sse({ type: "message_start", message: { usage: { input_tokens: 9 } } })],
          state,
          undefined
        )
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      body: JSON.stringify({ model: "m", stream: true })
    });
    await readFirstThenDrain(response, state);
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage.inputTokens).toBe(9);
  });
  it("still parses a non-streaming real Response as JSON", async () => {
    const store = new MemoryTraceStore();
    const underlying: FetchLike = async () =>
      new Response(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 6 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: underlying
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    await expect(response.json()).resolves.toEqual({
      usage: { input_tokens: 5, output_tokens: 6 }
    });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage.outputTokens).toBe(6);
  });
});
describe("anthropic adapter: JSON cache_creation split", () => {
  it("records ephemeral_5m / ephemeral_1h input tokens from a JSON body", async () => {
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () =>
        jsonResponse({
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 70,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 40 }
          }
        })
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationInputTokens: 70,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 30,
      cacheCreation1hInputTokens: 40
    });
  });
  it("omits the split fields when the response has no cache_creation object", async () => {
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => jsonResponse({ usage: { input_tokens: 1 } })
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    await fetch.flush();
    const [call] = await store.list();
    expect(call && "cacheCreation5mInputTokens" in call.usage).toBe(false);
    expect(call && "cacheCreation1hInputTokens" in call.usage).toBe(false);
  });
});
describe("createCaptureFetch: response shapes and failure paths", () => {
  it("returns the response untouched and reports the error when cloning fails", async () => {
    const errors: unknown[] = [];
    const store = new MemoryTraceStore();
    const original: FetchResponseLike = {
      ok: true,
      status: 200,
      clone: () => {
        throw new TypeError("body already used");
      },
      json: async () => ({})
    };
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => original,
      onError: (error) => errors.push(error)
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    await fetch.flush();
    expect(response).toBe(original);
    expect((errors[0] as Error).message).toBe("body already used");
    expect(await store.list()).toEqual([]);
  });
  it("stores a non-string request body as the unparseable-body marker, never its bytes", async () => {
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => jsonResponse({ usage: { input_tokens: 3, output_tokens: 1 } })
    });
    await fetch("https://api.anthropic.com/v1/messages", {
      body: new TextEncoder().encode('{"model":"m"}')
    });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.payload.wireBody).toBe('{"redacted":"unparseable-body"}');
    expect(call?.usage.inputTokens).toBe(3);
  });
  it("reads a body-bearing response without headers as JSON for a non-streaming request", async () => {
    const store = new MemoryTraceStore();
    const body = new Response("ignored").body;
    const response: FetchResponseLike = {
      ok: true,
      status: 200,
      body,
      clone: () => response,
      json: async () => ({ usage: { input_tokens: 11, output_tokens: 2 } })
    };
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => response
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: '{"model":"m"}' });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage.inputTokens).toBe(11);
  });
  it("parses JSON when the request asked to stream but the server answered application/json", async () => {
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () =>
        new Response(JSON.stringify({ usage: { input_tokens: 4, output_tokens: 8 } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });
    await fetch("https://api.anthropic.com/v1/messages", {
      body: JSON.stringify({ model: "m", stream: true })
    });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage.outputTokens).toBe(8);
  });
  it("keeps the usage seen before a stream errors and ignores non-byte chunks", async () => {
    const store = new MemoryTraceStore();
    const encoder = new TextEncoder();
    let step = 0;
    const body = {
      getReader: () => ({
        read: async (): Promise<{ done: boolean; value?: unknown }> => {
          step += 1;
          if (step === 1) {
            return {
              done: false,
              value: encoder.encode(
                sse({ type: "message_start", message: { usage: { input_tokens: 21 } } })
              )
            };
          }
          if (step === 2) return { done: false, value: { not: "bytes" } };
          throw new Error("socket reset");
        },
        releaseLock: () => {},
        cancel: async () => {}
      })
    };
    const response: FetchResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body,
      clone: () => response,
      json: async () => ({})
    };
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => response
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: '{"model":"m"}' });
    await fetch.flush();
    const [call] = await store.list();
    expect(step).toBe(3);
    expect(call?.usage.inputTokens).toBe(21);
  });
  it("does not record non-2xx responses", async () => {
    const store = new MemoryTraceStore();
    const fetch = createCaptureFetch(anthropicCaptureAdapter, {
      ...CONTEXT,
      store,
      fetch: async () => ({ ...jsonResponse({}), ok: false, status: 529 })
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", { body: "{}" });
    await fetch.flush();
    expect(response.status).toBe(529);
    expect(await store.list()).toEqual([]);
  });
});
