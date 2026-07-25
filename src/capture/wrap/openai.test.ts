import { describe, expect, it } from "vitest";
import { MemoryTraceStore } from "../../store/memory-store.js";
import type { FetchLike, FetchResponseLike } from "./anthropic.js";
import {
  createOpenAiCaptureFetch,
  parseOpenAiRequestParams,
  parseOpenAiUsageFromJsonText,
  usageFromOpenAiBody,
  wrapOpenAi
} from "./openai.js";
function jsonResponse(body: unknown, ok = true): FetchResponseLike {
  const payload = JSON.stringify(body);
  const response: FetchResponseLike = {
    ok,
    status: ok ? 200 : 500,
    clone: () => jsonResponse(body, ok),
    json: async () => JSON.parse(payload)
  };
  return response;
}
const SUCCESS_BODY = {
  id: "chatcmpl-1",
  model: "gpt-4o",
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 800 }
  }
};
function requestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    ...overrides
  });
}
describe("createOpenAiCaptureFetch", () => {
  it("forwards the call unchanged to the underlying fetch", async () => {
    let seenInput: string | URL | undefined;
    let seenInit: unknown;
    const underlying: FetchLike = async (input, init) => {
      seenInput = input;
      seenInit = init;
      return jsonResponse(SUCCESS_BODY);
    };
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    const body = requestBody();
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body });
    expect(seenInput).toBe("https://api.openai.com/v1/chat/completions");
    expect(
      (
        seenInit as {
          body: string;
        }
      ).body
    ).toBe(body);
  });
  it("maps prompt_tokens_details.cached_tokens to cacheReadInputTokens, the remainder to inputTokens, and cacheCreationInputTokens stays 0", async () => {
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await fetch("https://api.openai.com/v1/chat/completions", { body: requestBody() });
    const [call] = await store.list();
    expect(call?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 800
    });
  });
  it("stamps provider: openai on every captured call", async () => {
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await fetch("https://api.openai.com/v1/chat/completions", { body: requestBody() });
    const [call] = await store.list();
    expect(call?.provider).toBe("openai");
  });
  it("captures session/step context and duration on success", async () => {
    let tick = 1000;
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "session-42",
      stepName: "planner",
      parentCallId: "call-parent",
      fetch: underlying,
      now: () => {
        tick += 25;
        return tick;
      }
    });
    await fetch("https://api.openai.com/v1/chat/completions", { body: requestBody() });
    const [call] = await store.list();
    expect(call?.sessionId).toBe("session-42");
    expect(call?.stepName).toBe("planner");
    expect(call?.parentCallId).toBe("call-parent");
    expect(call?.durationMs).toBe(25);
    expect(call?.timestamp).toBe(1025);
  });
  it("does not capture on a non-ok response", async () => {
    const underlying: FetchLike = async () => jsonResponse({ error: "boom" }, false);
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await fetch("https://api.openai.com/v1/chat/completions", { body: requestBody() });
    await expect(store.list()).resolves.toEqual([]);
  });
  it("propagates underlying fetch errors without capturing", async () => {
    const underlying: FetchLike = async () => {
      throw new Error("network down");
    };
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await expect(
      fetch("https://api.openai.com/v1/chat/completions", { body: requestBody() })
    ).rejects.toThrow("network down");
    await expect(store.list()).resolves.toEqual([]);
  });
  it("never breaks the real response when store.append fails; reports via onCaptureError", async () => {
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const failingStore = {
      append: async () => {
        throw new Error("disk full");
      },
      list: async () => []
    };
    const captured: unknown[] = [];
    const fetch = createOpenAiCaptureFetch({
      store: failingStore,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying,
      onCaptureError: (error) => captured.push(error)
    });
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      body: requestBody()
    });
    await expect(response.json()).resolves.toEqual(SUCCESS_BODY);
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe("disk full");
  });
});
describe("usageFromOpenAiBody / parseOpenAiUsageFromJsonText", () => {
  it("returns zeroed usage for a body with no usage block", () => {
    expect(usageFromOpenAiBody({ id: "x" })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });
  it("treats a missing prompt_tokens_details as zero cached tokens", () => {
    const usage = usageFromOpenAiBody({ usage: { prompt_tokens: 500, completion_tokens: 20 } });
    expect(usage).toEqual({
      inputTokens: 500,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });
  it("parses usage from raw JSON text, and degrades to zeroed usage on unparseable text", () => {
    expect(parseOpenAiUsageFromJsonText(JSON.stringify(SUCCESS_BODY))).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 800
    });
    expect(parseOpenAiUsageFromJsonText("not json")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });
});
describe("parseOpenAiRequestParams", () => {
  it("extracts the model", () => {
    expect(parseOpenAiRequestParams(requestBody())).toEqual({ model: "gpt-4o" });
  });
  it("falls back to unknown on a malformed body rather than throwing", () => {
    expect(parseOpenAiRequestParams("not json")).toEqual({ model: "unknown" });
    expect(parseOpenAiRequestParams("null")).toEqual({ model: "unknown" });
  });
});
describe("wrapOpenAi", () => {
  it("passes a capturing fetch to the client factory", () => {
    const store = new MemoryTraceStore();
    let receivedFetch: FetchLike | undefined;
    const client = wrapOpenAi(
      (fetch) => {
        receivedFetch = fetch;
        return { marker: "client" };
      },
      { store, sessionId: "s1", stepName: "step1" }
    );
    expect(client).toEqual({ marker: "client" });
    expect(typeof receivedFetch).toBe("function");
  });
});
