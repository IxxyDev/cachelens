import { describe, expect, it } from "vitest";
import { diffParams } from "../../core/diff/params-diff.js";
import { MemoryTraceStore } from "../../store/memory-store.js";
import {
  createAnthropicCaptureFetch,
  type FetchLike,
  type FetchResponseLike,
  parseRequestParams,
  wrapAnthropic
} from "./anthropic.js";

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
  id: "msg_1",
  model: "claude-opus-4-8",
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 200
  }
};
function requestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    ...overrides
  });
}
describe("createAnthropicCaptureFetch", () => {
  it("forwards the call unchanged to the underlying fetch", async () => {
    let seenInput: string | URL | undefined;
    let seenInit: unknown;
    const underlying: FetchLike = async (input, init) => {
      seenInput = input;
      seenInit = init;
      return jsonResponse(SUCCESS_BODY);
    };
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    const body = requestBody();
    await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body });
    expect(seenInput).toBe("https://api.anthropic.com/v1/messages");
    expect(
      (
        seenInit as {
          body: string;
        }
      ).body
    ).toBe(body);
  });
  it("returns the response body intact to the caller", async () => {
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", { body: requestBody() });
    await expect(response.json()).resolves.toEqual(SUCCESS_BODY);
  });
  it("captures usage, session/step context, and duration on success", async () => {
    let tick = 1000;
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
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
    await fetch("https://api.anthropic.com/v1/messages", { body: requestBody() });
    await fetch.flush();
    const calls = await store.list();
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.sessionId).toBe("session-42");
    expect(call?.stepName).toBe("planner");
    expect(call?.parentCallId).toBe("call-parent");
    expect(call?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 200
    });
    expect(call?.durationMs).toBe(25);
    expect(call?.timestamp).toBe(1025);
    expect(call?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("records the call's timestamp as the request-send time, not the response-completion time", async () => {
    let tick = 1000;
    const underlying: FetchLike = async () => {
      tick += 500;
      return jsonResponse(SUCCESS_BODY);
    };
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying,
      now: () => tick
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: requestBody() });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.timestamp).toBe(1000);
    expect(call?.durationMs).toBe(500);
  });
  it("omits parentCallId when not provided", async () => {
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: requestBody() });
    await fetch.flush();
    const [call] = await store.list();
    expect(call && "parentCallId" in call).toBe(false);
  });
  it("does not capture on a non-ok response", async () => {
    const underlying: FetchLike = async () => jsonResponse({ error: "boom" }, false);
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: requestBody() });
    await fetch.flush();
    await expect(store.list()).resolves.toEqual([]);
  });
  it("propagates underlying fetch errors without capturing", async () => {
    const underlying: FetchLike = async () => {
      throw new Error("network down");
    };
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await expect(
      fetch("https://api.anthropic.com/v1/messages", { body: requestBody() })
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
    const fetch = createAnthropicCaptureFetch({
      store: failingStore,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying,
      onCaptureError: (error) => captured.push(error)
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      body: requestBody()
    });
    await expect(response.json()).resolves.toEqual(SUCCESS_BODY);
    await fetch.flush();
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe("disk full");
  });
  it("records zeroed usage instead of throwing when the response body is unparseable", async () => {
    const brokenResponse: FetchResponseLike = {
      ok: true,
      status: 200,
      clone: () => brokenResponse,
      json: async () => {
        throw new Error("not json");
      }
    };
    const underlying: FetchLike = async () => brokenResponse;
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await fetch("https://api.anthropic.com/v1/messages", { body: requestBody() });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });
  it("redacts the stored wire-body by default", async () => {
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying
    });
    await fetch("https://api.anthropic.com/v1/messages", {
      body: requestBody({
        messages: [{ role: "user", content: [{ type: "text", text: "secret" }] }]
      })
    });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.payload.wireBody).not.toContain("secret");
  });
  it("stores the raw wire-body when raw: true", async () => {
    const underlying: FetchLike = async () => jsonResponse(SUCCESS_BODY);
    const store = new MemoryTraceStore();
    const fetch = createAnthropicCaptureFetch({
      store,
      sessionId: "s1",
      stepName: "step1",
      fetch: underlying,
      raw: true
    });
    await fetch("https://api.anthropic.com/v1/messages", {
      body: requestBody({
        messages: [{ role: "user", content: [{ type: "text", text: "secret" }] }]
      })
    });
    await fetch.flush();
    const [call] = await store.list();
    expect(call?.payload.wireBody).toContain("secret");
  });
});
describe("parseRequestParams", () => {
  it("extracts model", () => {
    expect(parseRequestParams(requestBody())).toEqual({ model: "claude-opus-4-8" });
  });
  it("falls back to unknown model on unparseable body", () => {
    expect(parseRequestParams("not json")).toEqual({ model: "unknown" });
  });
  it("extracts a string tool_choice", () => {
    expect(parseRequestParams(requestBody({ tool_choice: "auto" }))).toEqual({
      model: "claude-opus-4-8",
      toolChoice: "auto"
    });
  });
  it("makes a switch of the forced tool visible to the params diff", () => {
    const forced = (name: string) =>
      parseRequestParams(requestBody({ tool_choice: { type: "tool", name } }));
    expect(diffParams(forced("get_weather"), forced("get_time"))).toBe("messages");
  });
  it("extracts an object tool_choice as type plus forced tool name", () => {
    expect(
      parseRequestParams(requestBody({ tool_choice: { type: "tool", name: "get_weather" } }))
    ).toEqual({ model: "claude-opus-4-8", toolChoice: "tool:get_weather" });
    expect(parseRequestParams(requestBody({ tool_choice: { type: "any" } }))).toEqual({
      model: "claude-opus-4-8",
      toolChoice: "any"
    });
  });
  it("extracts an adaptive thinking config", () => {
    expect(parseRequestParams(requestBody({ thinking: { type: "adaptive" } }))).toEqual({
      model: "claude-opus-4-8",
      thinking: { type: "adaptive" }
    });
  });
  it("extracts a disabled thinking config", () => {
    expect(parseRequestParams(requestBody({ thinking: { type: "disabled" } }))).toEqual({
      model: "claude-opus-4-8",
      thinking: { type: "disabled" }
    });
  });
  it("omits thinking when absent from the request", () => {
    const params = parseRequestParams(requestBody());
    expect("thinking" in params).toBe(false);
  });
  it("extracts thinking.budget_tokens for an enabled thinking config", () => {
    expect(
      parseRequestParams(requestBody({ thinking: { type: "enabled", budget_tokens: 8000 } }))
    ).toEqual({
      model: "claude-opus-4-8",
      thinking: { type: "enabled", budgetTokens: 8000 }
    });
  });
  it("omits budgetTokens when the thinking config has no budget_tokens", () => {
    const params = parseRequestParams(requestBody({ thinking: { type: "adaptive" } }));
    expect(params.thinking && "budgetTokens" in params.thinking).toBe(false);
  });
  it("extracts output_config.effort", () => {
    expect(parseRequestParams(requestBody({ output_config: { effort: "low" } }))).toEqual({
      model: "claude-opus-4-8",
      effort: "low"
    });
  });
  it("extracts context_management as key-order-independent JSON", () => {
    const a = parseRequestParams(
      requestBody({ context_management: { edits: [{ type: "clear_tool_uses", keep: 3 }] } })
    );
    const b = parseRequestParams(
      requestBody({ context_management: { edits: [{ keep: 3, type: "clear_tool_uses" }] } })
    );
    expect(a.contextManagement).toBe('{"edits":[{"keep":3,"type":"clear_tool_uses"}]}');
    expect(b.contextManagement).toBe(a.contextManagement);
  });
  it("extracts inference_geo", () => {
    expect(parseRequestParams(requestBody({ inference_geo: "us" })).inferenceGeo).toBe("us");
  });
  it("marks webSearchEnabled when a web_search server tool is present", () => {
    const params = parseRequestParams(
      requestBody({ tools: [{ type: "web_search_20250305", name: "web_search" }] })
    );
    expect(params.webSearchEnabled).toBe(true);
    expect("webSearchEnabled" in parseRequestParams(requestBody())).toBe(false);
  });
  it("extracts the top-level speed field", () => {
    expect(parseRequestParams(requestBody({ speed: "fast" }))).toEqual({
      model: "claude-opus-4-8",
      speed: "fast"
    });
  });
  it("omits speed when absent", () => {
    expect("speed" in parseRequestParams(requestBody())).toBe(false);
  });
  it("detects an image block in messages content", () => {
    const params = parseRequestParams(
      requestBody({
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "base64", data: "x" } }]
          }
        ]
      })
    );
    expect(params.imagesPresent).toBe(true);
  });
  it("omits imagesPresent when no content block is an image", () => {
    expect("imagesPresent" in parseRequestParams(requestBody())).toBe(false);
  });
  it("detects an image block inside array-form system content", () => {
    const params = parseRequestParams(
      requestBody({ system: [{ type: "image", source: { type: "base64", data: "x" } }] })
    );
    expect(params.imagesPresent).toBe(true);
  });
  it("detects citations enabled on a document block", () => {
    const params = parseRequestParams(
      requestBody({
        messages: [
          {
            role: "user",
            content: [{ type: "document", citations: { enabled: true } }]
          }
        ]
      })
    );
    expect(params.citationsEnabled).toBe(true);
  });
  it("does not flag citations when the block explicitly disables them", () => {
    const params = parseRequestParams(
      requestBody({
        messages: [{ role: "user", content: [{ type: "document", citations: { enabled: false } }] }]
      })
    );
    expect("citationsEnabled" in params).toBe(false);
  });
  it("omits citationsEnabled when absent from every block", () => {
    expect("citationsEnabled" in parseRequestParams(requestBody())).toBe(false);
  });
  it("ignores a plain-string system field (no blocks to scan)", () => {
    const params = parseRequestParams(requestBody({ system: "you are a helpful assistant" }));
    expect("imagesPresent" in params).toBe(false);
    expect("citationsEnabled" in params).toBe(false);
  });
});
describe("wrapAnthropic", () => {
  it("passes the capture fetch into the client factory and returns the factory's client", () => {
    const store = new MemoryTraceStore();
    const marker = { fetchWasCapturing: false };
    const client = wrapAnthropic(
      (fetch) => {
        marker.fetchWasCapturing = typeof fetch === "function";
        return { fetch, tag: "fake-client" };
      },
      { store, sessionId: "s1", stepName: "step1", fetch: async () => jsonResponse(SUCCESS_BODY) }
    );
    expect(marker.fetchWasCapturing).toBe(true);
    expect(client.tag).toBe("fake-client");
  });
});
