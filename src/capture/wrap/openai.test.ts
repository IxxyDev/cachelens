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
    await fetch.flush();
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
    await fetch.flush();
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
    await fetch.flush();
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
    await fetch.flush();
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
    await fetch.flush();
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
    await fetch.flush();
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
describe("createOpenAiCaptureFetch: redaction", () => {
  const secretBody = requestBody({
    messages: [
      { role: "system", content: "TOP-SECRET-SYSTEM-PROMPT" },
      { role: "user", content: [{ type: "text", text: "my password is hunter2" }] }
    ]
  });
  it("redacts the stored wire-body by default: placeholders, no secret text", async () => {
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: async () => jsonResponse(SUCCESS_BODY)
    });
    await fetch("https://api.openai.com/v1/chat/completions", { body: secretBody });
    await fetch.flush();
    const [call] = await store.list();
    const stored = call?.payload.wireBody ?? "";
    expect(stored).not.toContain("TOP-SECRET-SYSTEM-PROMPT");
    expect(stored).not.toContain("hunter2");
    expect(stored).toMatch(/\[R:[0-9a-f]{8}:\d+\]/);
    expect(JSON.parse(stored).model).toBe("gpt-4o");
  });
  it("redacts Responses API instructions/input by default", async () => {
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: async () => jsonResponse(SUCCESS_BODY)
    });
    await fetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({
        model: "gpt-5",
        instructions: "SECRET-INSTRUCTIONS",
        input: [{ role: "user", content: [{ type: "input_text", text: "SECRET-INPUT" }] }]
      })
    });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.payload.wireBody).not.toContain("SECRET-INSTRUCTIONS");
    expect(call?.payload.wireBody).not.toContain("SECRET-INPUT");
  });
  it("stores the raw wire-body when raw: true", async () => {
    const store = new MemoryTraceStore();
    const fetch = createOpenAiCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: async () => jsonResponse(SUCCESS_BODY),
      raw: true
    });
    await fetch("https://api.openai.com/v1/chat/completions", { body: secretBody });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.payload.wireBody).toBe(secretBody);
  });
});
describe("usageFromOpenAiBody: Responses API", () => {
  it("maps input_tokens / input_tokens_details.cached_tokens, excluding cached from input", () => {
    expect(
      usageFromOpenAiBody({
        object: "response",
        usage: {
          input_tokens: 900,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 600 }
        }
      })
    ).toEqual({
      inputTokens: 300,
      outputTokens: 12,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 600
    });
  });
});
describe("parseOpenAiRequestParams", () => {
  it("extracts the model", () => {
    expect(parseOpenAiRequestParams(requestBody())).toEqual({ model: "gpt-4o" });
  });
  it("parses a Responses API body (input/instructions) like a chat body", () => {
    expect(
      parseOpenAiRequestParams(
        JSON.stringify({
          model: "gpt-5",
          instructions: "be brief",
          input: "hello",
          tool_choice: { type: "function", name: "lookup" }
        })
      )
    ).toEqual({ model: "gpt-5", toolChoice: "function:lookup" });
  });
  it("names the forced function of a Chat Completions tool_choice", () => {
    expect(
      parseOpenAiRequestParams(
        requestBody({ tool_choice: { type: "function", function: { name: "search" } } })
      )
    ).toEqual({ model: "gpt-4o", toolChoice: "function:search" });
  });
  it("keeps a typed tool_choice without a forced name as just its type", () => {
    // Responses API built-in tool: no name, so only the type distinguishes it.
    expect(parseOpenAiRequestParams(requestBody({ tool_choice: { type: "file_search" } }))).toEqual(
      { model: "gpt-4o", toolChoice: "file_search" }
    );
    // A function choice whose `function` is not an object carries no name.
    expect(
      parseOpenAiRequestParams(requestBody({ tool_choice: { type: "function", function: "x" } }))
    ).toEqual({ model: "gpt-4o", toolChoice: "function" });
    // A non-string name is not a forced name.
    expect(
      parseOpenAiRequestParams(
        requestBody({ tool_choice: { type: "function", function: { name: 42 } } })
      )
    ).toEqual({ model: "gpt-4o", toolChoice: "function" });
  });
  it("falls back to the JSON of a tool_choice it cannot read", () => {
    expect(parseOpenAiRequestParams(requestBody({ tool_choice: { name: "lookup" } }))).toEqual({
      model: "gpt-4o",
      toolChoice: '{"name":"lookup"}'
    });
    expect(parseOpenAiRequestParams(requestBody({ tool_choice: ["auto"] }))).toEqual({
      model: "gpt-4o",
      toolChoice: '["auto"]'
    });
    expect(parseOpenAiRequestParams(requestBody({ tool_choice: null }))).toEqual({
      model: "gpt-4o",
      toolChoice: "null"
    });
  });
  it("distinguishes 'required' from 'auto' and omits a missing tool_choice", () => {
    const auto = parseOpenAiRequestParams(requestBody({ tool_choice: "auto" }));
    const required = parseOpenAiRequestParams(requestBody({ tool_choice: "required" }));
    expect(required).toEqual({ model: "gpt-4o", toolChoice: "required" });
    expect(auto.toolChoice).not.toBe(required.toolChoice);
    expect("toolChoice" in parseOpenAiRequestParams(requestBody())).toBe(false);
  });
  it("records model 'unknown' when model is not a string", () => {
    expect(parseOpenAiRequestParams(JSON.stringify({ model: 5, messages: [] }))).toEqual({
      model: "unknown"
    });
  });
  it("extracts a string tool_choice from a chat body", () => {
    expect(parseOpenAiRequestParams(requestBody({ tool_choice: "auto" }))).toEqual({
      model: "gpt-4o",
      toolChoice: "auto"
    });
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
