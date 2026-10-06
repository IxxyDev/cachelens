import { describe, expect, it } from "vitest";
import type { LlmCall } from "../../core/model/call.js";
import { tokenCount } from "../../core/model/types.js";
import type { FetchLike, FetchResponseLike } from "../wrap/anthropic.js";
import { createAnthropicCorroborationAdapter } from "./anthropic-corroboration-adapter.js";

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): FetchResponseLike {
  return {
    ok,
    status,
    clone: () => jsonResponse(body, ok, status),
    json: async () => body
  };
}
function makeCall(): LlmCall {
  return {
    id: "call-1",
    sessionId: "s",
    stepName: "step",
    timestamp: 0,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: "{}" },
    usage: {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(0),
      cacheReadInputTokens: tokenCount(0)
    }
  };
}
describe("createAnthropicCorroborationAdapter", () => {
  it("posts the call id and cause, and maps a confirmed status", async () => {
    let seenUrl: string | URL | undefined;
    let seenBody: unknown;
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(
        (
          init as {
            body: string;
          }
        ).body
      );
      return jsonResponse({ status: "confirmed", note: "vendor agrees" });
    };
    const adapter = createAnthropicCorroborationAdapter({ apiKey: "key", fetch });
    const result = await adapter.corroborate(makeCall(), "dynamic-prefix-content");
    expect(result).toEqual({ status: "confirmed", note: "vendor agrees" });
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages/cache-diagnostics");
    expect(seenBody).toEqual({ call_id: "call-1", cause: "dynamic-prefix-content" });
  });
  it("respects a custom baseUrl and endpointPath override", async () => {
    let seenUrl: string | URL | undefined;
    const fetch: FetchLike = async (url) => {
      seenUrl = url;
      return jsonResponse({ status: "unavailable" });
    };
    const adapter = createAnthropicCorroborationAdapter({
      apiKey: "key",
      baseUrl: "https://custom.example.com",
      endpointPath: "/v1/beta/real-path",
      fetch
    });
    await adapter.corroborate(makeCall(), "ttl-expiry");
    expect(seenUrl).toBe("https://custom.example.com/v1/beta/real-path");
  });
  it("omits note when absent from the response", async () => {
    const fetch: FetchLike = async () => jsonResponse({ status: "contradicted" });
    const adapter = createAnthropicCorroborationAdapter({ apiKey: "key", fetch });
    const result = await adapter.corroborate(makeCall(), "ttl-expiry");
    expect(result).toEqual({ status: "contradicted" });
    expect(result && "note" in result).toBe(false);
  });
  it("returns undefined on a non-ok response", async () => {
    const fetch: FetchLike = async () => jsonResponse({ error: "boom" }, false);
    const adapter = createAnthropicCorroborationAdapter({ apiKey: "key", fetch });
    await expect(adapter.corroborate(makeCall(), "ttl-expiry")).resolves.toBeUndefined();
  });
  it("returns undefined when the status field is missing or unrecognized", async () => {
    const fetch: FetchLike = async () => jsonResponse({ status: "maybe" });
    const adapter = createAnthropicCorroborationAdapter({ apiKey: "key", fetch });
    await expect(adapter.corroborate(makeCall(), "ttl-expiry")).resolves.toBeUndefined();
  });
  it("returns undefined when the response body is unparseable", async () => {
    const broken: FetchResponseLike = {
      ok: true,
      status: 200,
      clone: () => broken,
      json: async () => {
        throw new Error("not json");
      }
    };
    const fetch: FetchLike = async () => broken;
    const adapter = createAnthropicCorroborationAdapter({ apiKey: "key", fetch });
    await expect(adapter.corroborate(makeCall(), "ttl-expiry")).resolves.toBeUndefined();
  });
  it("returns undefined on a network error rather than throwing", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("network down");
    };
    const adapter = createAnthropicCorroborationAdapter({ apiKey: "key", fetch });
    await expect(adapter.corroborate(makeCall(), "ttl-expiry")).resolves.toBeUndefined();
  });
});
