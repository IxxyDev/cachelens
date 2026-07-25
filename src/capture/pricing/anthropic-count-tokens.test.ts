import { describe, expect, it } from "vitest";
import type { FetchLike, FetchResponseLike } from "../wrap/anthropic.js";
import { createAnthropicCountTokensAdapter } from "./anthropic-count-tokens.js";
function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): FetchResponseLike {
  return {
    ok,
    status,
    clone: () => jsonResponse(body, ok, status),
    json: async () => body
  };
}
describe("createAnthropicCountTokensAdapter", () => {
  it("posts the prefix text as a single synthetic user message and returns input_tokens", async () => {
    let seenUrl: string | URL | undefined;
    let seenInit: unknown;
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse({ input_tokens: 42 });
    };
    const adapter = createAnthropicCountTokensAdapter({
      apiKey: "key",
      model: "claude-sonnet-4-5",
      fetch
    });
    const result = await adapter.countTokens("some stable prefix");
    expect(result).toBe(42);
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    const body = JSON.parse(
      (
        seenInit as {
          body: string;
        }
      ).body
    );
    expect(body).toEqual({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "some stable prefix" }]
    });
    expect(
      (
        seenInit as {
          headers: Record<string, string>;
        }
      ).headers["x-api-key"]
    ).toBe("key");
  });
  it("respects a custom baseUrl and anthropicVersion", async () => {
    let seenUrl: string | URL | undefined;
    let seenVersion: string | undefined;
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url;
      seenVersion = (
        init as {
          headers: Record<string, string>;
        }
      ).headers["anthropic-version"];
      return jsonResponse({ input_tokens: 1 });
    };
    const adapter = createAnthropicCountTokensAdapter({
      apiKey: "key",
      model: "claude-sonnet-4-5",
      baseUrl: "https://custom.example.com",
      anthropicVersion: "2099-01-01",
      fetch
    });
    await adapter.countTokens("x");
    expect(seenUrl).toBe("https://custom.example.com/v1/messages/count_tokens");
    expect(seenVersion).toBe("2099-01-01");
  });
  it("returns undefined on a non-ok response", async () => {
    const fetch: FetchLike = async () => jsonResponse({ error: "boom" }, false);
    const adapter = createAnthropicCountTokensAdapter({
      apiKey: "key",
      model: "claude-sonnet-4-5",
      fetch
    });
    await expect(adapter.countTokens("x")).resolves.toBeUndefined();
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
    const adapter = createAnthropicCountTokensAdapter({
      apiKey: "key",
      model: "claude-sonnet-4-5",
      fetch
    });
    await expect(adapter.countTokens("x")).resolves.toBeUndefined();
  });
  it("returns undefined when input_tokens is missing or not a number", async () => {
    const fetch: FetchLike = async () => jsonResponse({ input_tokens: "nope" });
    const adapter = createAnthropicCountTokensAdapter({
      apiKey: "key",
      model: "claude-sonnet-4-5",
      fetch
    });
    await expect(adapter.countTokens("x")).resolves.toBeUndefined();
  });
  it("returns undefined on a network error rather than throwing", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("network down");
    };
    const adapter = createAnthropicCountTokensAdapter({
      apiKey: "key",
      model: "claude-sonnet-4-5",
      fetch
    });
    await expect(adapter.countTokens("x")).resolves.toBeUndefined();
  });
});
