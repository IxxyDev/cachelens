import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmCall } from "../../core/model/call.js";
import { MemoryTraceStore } from "../../store/memory-store.js";
import type { StartedProxy } from "./start-proxy.js";
import { startProxy } from "./start-proxy.js";

/** Capture is written after the response ends; wait for it instead of sleeping. */
async function waitForCalls(store: MemoryTraceStore, count = 1): Promise<readonly LlmCall[]> {
  await vi.waitFor(async () => expect(await store.list()).toHaveLength(count));
  return store.list();
}
function startFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void
): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
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
async function postToProxy(
  proxy: StartedProxy,
  body: string,
  headers: Record<string, string> = {},
  path = "/v1/messages"
): Promise<{
  status: number;
  body: string;
}> {
  const res = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  });
  return { status: res.status, body: await res.text() };
}
describe("startProxy", () => {
  let upstream:
    | {
        url: string;
        close(): Promise<void>;
      }
    | undefined;
  let proxy: StartedProxy | undefined;
  afterEach(async () => {
    if (proxy) await proxy.close();
    if (upstream) await upstream.close();
    proxy = undefined;
    upstream = undefined;
  });
  it("forwards the request unchanged and returns the upstream response body", async () => {
    let seenPath: string | undefined;
    let seenBody: string | undefined;
    upstream = await startFakeUpstream((req, res, body) => {
      seenPath = req.url;
      seenBody = body.toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const reqBody = requestBody();
    const { status, body } = await postToProxy(proxy, reqBody);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual(SUCCESS_BODY);
    expect(seenPath).toBe("/v1/messages");
    expect(seenBody).toBe(reqBody);
  });
  it("captures usage, session/step from headers, and duration", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    let tick = 1000;
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      now: () => {
        tick += 25;
        return tick;
      }
    });
    await postToProxy(
      proxy,
      requestBody({ messages: [{ role: "user", content: [{ type: "text", text: "secret" }] }] }),
      { "x-cachelens-session": "session-42", "x-cachelens-step": "planner" }
    );
    const [call] = await waitForCalls(store);
    expect(call?.sessionId).toBe("session-42");
    expect(call?.stepName).toBe("planner");
    expect(call?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 200
    });
    expect(call?.durationMs).toBe(25);
    expect(call?.payload.wireBody).not.toContain("secret");
    expect(call?.provider).toBe("anthropic");
  });
  it("defaults the step and shares one per-run session id across header-less requests", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    await postToProxy(proxy, requestBody());
    await postToProxy(proxy, requestBody());
    await postToProxy(proxy, requestBody(), { "x-cachelens-session": "explicit" });
    const [first, second, third] = await waitForCalls(store, 3);
    expect(first?.stepName).toBe("proxy");
    expect(first?.sessionId.length).toBeGreaterThan(0);
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(third?.sessionId).toBe("explicit");
  });
  it("uses the sessionId option for header-less requests", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url, sessionId: "run-7" });
    await postToProxy(proxy, requestBody());
    const [call] = await waitForCalls(store);
    expect(call?.sessionId).toBe("run-7");
  });
  it("strips the cachelens session/step headers before forwarding upstream", async () => {
    let seenHeaders: http.IncomingHttpHeaders | undefined;
    upstream = await startFakeUpstream((req, res) => {
      seenHeaders = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    await postToProxy(proxy, requestBody(), {
      "x-cachelens-session": "s1",
      "x-cachelens-step": "step1"
    });
    expect(seenHeaders?.["x-cachelens-session"]).toBeUndefined();
    expect(seenHeaders?.["x-cachelens-step"]).toBeUndefined();
  });
  it("propagates upstream error status and body intact", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "rate_limit_error" } }));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { status, body } = await postToProxy(proxy, requestBody());
    expect(status).toBe(429);
    expect(JSON.parse(body)).toEqual({ error: { type: "rate_limit_error" } });
  });
  describe("records only successful POSTs to completion endpoints", () => {
    /** Sends the excluded exchange, then a captured one; only the latter may be recorded. */
    async function expectNotCaptured(
      upstreamStatus: number,
      method: string,
      path: string
    ): Promise<void> {
      upstream = await startFakeUpstream((req, res) => {
        const ok = req.url === "/v1/messages" && req.headers["x-marker"] === "captured";
        res.writeHead(ok ? 200 : upstreamStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? SUCCESS_BODY : { data: [], input_tokens: 12 }));
      });
      const store = new MemoryTraceStore();
      proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
      const excluded = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-cachelens-step": "excluded" },
        ...(method === "GET" ? {} : { body: requestBody() })
      });
      expect(excluded.status).toBe(upstreamStatus);
      expect(await excluded.json()).toEqual({ data: [], input_tokens: 12 });
      await postToProxy(proxy, requestBody(), {
        "x-marker": "captured",
        "x-cachelens-step": "captured"
      });
      const calls = await waitForCalls(store, 1);
      expect(calls.map((c) => c.stepName)).toEqual(["captured"]);
    }
    it("does not capture GET /v1/models", async () => {
      await expectNotCaptured(200, "GET", "/v1/models");
    });
    it("does not capture POST /v1/messages/count_tokens", async () => {
      await expectNotCaptured(200, "POST", "/v1/messages/count_tokens");
    });
    it("does not capture POST /v1/embeddings", async () => {
      await expectNotCaptured(200, "POST", "/v1/embeddings");
    });
    it("does not capture a 429 from a completion endpoint", async () => {
      await expectNotCaptured(429, "POST", "/v1/messages");
    });
    it("does not capture a 404", async () => {
      await expectNotCaptured(404, "POST", "/v1/messages");
    });
    it("classifies exchanges", async () => {
      const { isCapturedExchange } = await import("./start-proxy.js");
      expect(isCapturedExchange("POST", "/v1/messages", 200)).toBe(true);
      expect(isCapturedExchange("POST", "/v1/messages?beta=true", 200)).toBe(true);
      expect(isCapturedExchange("POST", "/v1/chat/completions", 201)).toBe(true);
      expect(isCapturedExchange("POST", "/v1/responses", 200)).toBe(true);
      expect(isCapturedExchange("POST", "/v1/completions", 200)).toBe(true);
      expect(isCapturedExchange("POST", "/v1/responses/resp_1/cancel", 200)).toBe(false);
      expect(isCapturedExchange("GET", "/v1/messages", 200)).toBe(false);
      expect(isCapturedExchange("POST", "/v1/messages", 302)).toBe(false);
      expect(isCapturedExchange("POST", "/anthropic/v1/messages", 200)).toBe(true);
      expect(isCapturedExchange("POST", "/proxy/openai/v1/chat/completions?x=1", 200)).toBe(true);
      expect(isCapturedExchange("POST", "/anthropic/v1/messages/count_tokens", 200)).toBe(false);
      expect(isCapturedExchange("POST", "/anthropic/v1/messages/batches", 200)).toBe(false);
      expect(isCapturedExchange("POST", "/v1/messages/batches", 200)).toBe(false);
    });
  });
  it("returns 502 without capturing when upstream is unreachable", async () => {
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: "http://127.0.0.1:1" });
    const { status } = await postToProxy(proxy, requestBody());
    expect(status).toBe(502);
    await expect(store.list()).resolves.toEqual([]);
  });
  it("captures usage from a streamed SSE response without buffering it for the client", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 30,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0
            }
          }
        })}\n\n`
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 12 } })}\n\n`
      );
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { status, body } = await postToProxy(proxy, requestBody());
    expect(status).toBe(200);
    expect(body).toContain("message_stop");
    const [call] = await waitForCalls(store);
    expect(call?.usage).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });
  it("stores the raw wire-body when raw: true", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url, raw: true });
    await postToProxy(
      proxy,
      requestBody({ messages: [{ role: "user", content: [{ type: "text", text: "secret" }] }] })
    );
    const [call] = await waitForCalls(store);
    expect(call?.payload.wireBody).toContain("secret");
  });
  it("never breaks the proxied response when capture (store.append) fails", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    store.append = () => Promise.reject(new Error("disk full"));
    const captureErrors: unknown[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      onCaptureError: (error) => captureErrors.push(error)
    });
    const { status, body } = await postToProxy(proxy, requestBody());
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual(SUCCESS_BODY);
    await vi.waitFor(() => expect(captureErrors).toHaveLength(1));
  });
  it("listens on an OS-assigned port by default and closes cleanly", async () => {
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: "http://127.0.0.1:1" });
    expect(proxy.port).toBeGreaterThan(0);
    await proxy.close();
    proxy = undefined;
  });
  it("forces accept-encoding: identity on the upstream request regardless of what the client sent", async () => {
    let seenAcceptEncoding: string | string[] | undefined;
    upstream = await startFakeUpstream((req, res) => {
      seenAcceptEncoding = req.headers["accept-encoding"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    await postToProxy(proxy, requestBody(), { "accept-encoding": "gzip, deflate, br" });
    expect(seenAcceptEncoding).toBe("identity");
  });
  function rawRequest(
    proxyPort: number,
    headers: Record<string, string>
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const clientReq = http.request(
        { hostname: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks)
            })
          );
          res.on("error", reject);
        }
      );
      clientReq.on("error", reject);
      clientReq.end(requestBody());
    });
  }
  it("decompresses a gzip response for usage parsing even if upstream ignores accept-encoding, without altering the bytes forwarded to the client", async () => {
    const compressed = gzipSync(Buffer.from(JSON.stringify(SUCCESS_BODY), "utf8"));
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(compressed);
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { body: rawClientBytes } = await rawRequest(proxy.port, {
      "content-type": "application/json"
    });
    expect(rawClientBytes.equals(compressed)).toBe(true);
    const [call] = await waitForCalls(store);
    expect(call?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 200
    });
  });
  it("strips hop-by-hop headers in both directions", async () => {
    let seenConnectionHeader: string | string[] | undefined;
    let seenKeepAliveHeader: string | string[] | undefined;
    upstream = await startFakeUpstream((req, res) => {
      seenConnectionHeader = req.headers.connection;
      seenKeepAliveHeader = req.headers["keep-alive"];
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "keep-alive",
        "keep-alive": "timeout=99999-from-upstream"
      });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { headers: responseHeaders } = await rawRequest(proxy.port, {
      "content-type": "application/json",
      connection: "client-marker-should-not-reach-upstream",
      "keep-alive": "timeout=99"
    });
    expect(seenConnectionHeader).not.toBe("client-marker-should-not-reach-upstream");
    expect(seenKeepAliveHeader).toBeUndefined();
    expect(responseHeaders["keep-alive"]).not.toBe("timeout=99999-from-upstream");
  });
  it("responds 504 and never captures when upstream stalls past the configured timeout", async () => {
    upstream = await startFakeUpstream(() => {});
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url, upstreamTimeoutMs: 50 });
    const { status } = await postToProxy(proxy, requestBody());
    expect(status).toBe(504);
    await expect(store.list()).resolves.toEqual([]);
  });
  it("responds 413 and never contacts upstream when the request body exceeds the configured limit", async () => {
    let upstreamCallCount = 0;
    upstream = await startFakeUpstream((_req, res) => {
      upstreamCallCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url, maxRequestBodyBytes: 10 });
    const { status } = await postToProxy(proxy, requestBody());
    expect(status).toBe(413);
    expect(upstreamCallCount).toBe(0);
    await expect(store.list()).resolves.toEqual([]);
  });
  it("aborts the upstream connection and survives when the client disconnects mid-SSE-stream", async () => {
    let upstreamSawClientAbort = false;
    let requestCount = 0;
    upstream = await startFakeUpstream((req, res) => {
      requestCount++;
      if (requestCount === 1) {
        req.on("close", () => {
          if (!res.writableEnded) {
            upstreamSawClientAbort = true;
          }
        });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { usage: { input_tokens: 30, output_tokens: 0 } }
          })}\n\n`
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const firstChunk = await new Promise<Buffer>((resolve) => {
      const clientReq = http.request(
        { hostname: "127.0.0.1", port: proxy?.port, path: "/v1/messages", method: "POST" },
        (res) => {
          res.once("data", (chunk: Buffer) => {
            clientReq.destroy();
            resolve(chunk);
          });
          res.once("error", () => {});
        }
      );
      clientReq.on("error", () => {});
      clientReq.end(requestBody());
    });
    expect(firstChunk.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(upstreamSawClientAbort).toBe(true), { timeout: 2000 });
    const followUp = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody()
    });
    expect(followUp.status).toBe(200);
  });
  it("binds loopback (127.0.0.1) by default and reports the bound address", async () => {
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: "http://127.0.0.1:1",
      onWarning: (m) => warnings.push(m)
    });
    expect(proxy.host).toBe("127.0.0.1");
    expect(warnings).toEqual([]);
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
  });
  it("binds the given host instead of loopback", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      host: "0.0.0.0",
      onWarning: (m) => warnings.push(m)
    });
    expect(proxy.host).toBe("0.0.0.0");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("non-loopback address 0.0.0.0");
    expect(proxy.url).toBe(`http://0.0.0.0:${proxy.port}`);
    const { status } = await postToProxy(proxy, requestBody());
    expect(status).toBe(200);
  });
  it("warns at startup when the upstream is cleartext http:// on a non-loopback host", async () => {
    const warnings: string[] = [];
    const store = new MemoryTraceStore();
    proxy = await startProxy({
      store,
      upstreamBaseUrl: "http://api.example.com",
      onWarning: (m) => warnings.push(m)
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("http://api.example.com");
    expect(warnings[0]).toContain("cleartext");
    await proxy.close();
    proxy = undefined;
    for (const url of ["http://127.0.0.1:1", "http://localhost:1", "http://[::1]:1"]) {
      const quiet: string[] = [];
      const local = await startProxy({
        store,
        upstreamBaseUrl: url,
        onWarning: (m) => quiet.push(m)
      });
      await local.close();
      expect(quiet).toEqual([]);
    }
  });
  it("records an OpenAI Chat Completions JSON response with provider openai and cached tokens split out", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 1000 }
          }
        })
      );
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { status } = await postToProxy(
      proxy,
      JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
      {},
      "/v1/chat/completions"
    );
    expect(status).toBe(200);
    const [call] = await waitForCalls(store);
    expect(call?.provider).toBe("openai");
    expect(call?.params.model).toBe("gpt-5");
    expect(call?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1000
    });
  });
  it("records OpenAI SSE usage (Chat Completions include_usage chunk and Responses terminal event)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (req.url === "/v1/responses") {
        res.write(
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hé" })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 500,
                output_tokens: 9,
                input_tokens_details: { cached_tokens: 300 }
              }
            }
          })}\n\n`
        );
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 80,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: 64 }
            }
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
      }
      res.end();
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const body = JSON.stringify({ model: "gpt-5", stream: true, input: "hi" });
    const chat = await postToProxy(
      proxy,
      body,
      { "x-cachelens-step": "chat" },
      "/v1/chat/completions"
    );
    expect(chat.body).toContain("[DONE]");
    await postToProxy(proxy, body, { "x-cachelens-step": "responses" }, "/v1/responses");
    const calls = await waitForCalls(store, 2);
    const byStep = new Map(calls.map((c) => [c.stepName, c]));
    expect(byStep.get("chat")?.provider).toBe("openai");
    expect(byStep.get("chat")?.usage).toEqual({
      inputTokens: 16,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 64
    });
    expect(byStep.get("responses")?.provider).toBe("openai");
    expect(byStep.get("responses")?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 9,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 300
    });
  });
  it("detects the provider from the request path", async () => {
    const { detectProvider } = await import("./start-proxy.js");
    expect(detectProvider("/v1/chat/completions")).toBe("openai");
    expect(detectProvider("/v1/responses")).toBe("openai");
    expect(detectProvider("/v1/responses/resp_1?x=1")).toBe("openai");
    expect(detectProvider("/v1/completions")).toBe("openai");
    expect(detectProvider("/v1/embeddings")).toBe("openai");
    expect(detectProvider("/v1/messages")).toBe("anthropic");
    expect(detectProvider("/v1/messages/count_tokens")).toBe("anthropic");
    expect(detectProvider("/v1/chat/completions-x")).toBe("anthropic");
    expect(detectProvider(undefined)).toBe("anthropic");
  });
  it("answers 413 with connection: close and closes the socket after the response", async () => {
    let upstreamCalls = 0;
    upstream = await startFakeUpstream((_req, res) => {
      upstreamCalls++;
      res.end();
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url, maxRequestBodyBytes: 10 });
    const port = proxy.port;
    const { response, closed } = await new Promise<{ response: string; closed: boolean }>(
      (resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (d: string) => {
          response += d;
        });
        socket.on("error", () => {});
        socket.on("close", () => resolve({ response, closed: true }));
        const body = "x".repeat(4096);
        socket.write(
          `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\nContent-Length: ${body.length}\r\n\r\n${body}`
        );
      }
    );
    expect(closed).toBe(true);
    expect(response).toMatch(/^HTTP\/1\.1 413/);
    expect(response.toLowerCase()).toContain("connection: close");
    expect(upstreamCalls).toBe(0);
  });
  it("caps capture buffering: streams an oversized body to the client unchanged, records zero usage and warns", async () => {
    const huge = JSON.stringify({ ...SUCCESS_BODY, padding: "p".repeat(64 * 1024) });
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(huge);
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      maxCaptureBytes: 1024,
      onWarning: (m) => warnings.push(m)
    });
    const { status, body } = await postToProxy(proxy, requestBody());
    expect(status).toBe(200);
    expect(body).toBe(huge);
    const [call] = await waitForCalls(store);
    expect(call?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
    expect(warnings.some((w) => w.includes("exceeded 1024 bytes"))).toBe(true);
  });
  it("bounds decompression with maxOutputLength: a small gzip that inflates past the cap records zero usage and warns", async () => {
    const bomb = gzipSync(
      Buffer.from(JSON.stringify({ ...SUCCESS_BODY, padding: "0".repeat(2 * 1024 * 1024) }))
    );
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(bomb);
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      maxCaptureBytes: 64 * 1024,
      onWarning: (m) => warnings.push(m)
    });
    expect(bomb.length).toBeLessThan(64 * 1024);
    const { body: clientBytes } = await rawRequest(proxy.port, {
      "content-type": "application/json"
    });
    expect(clientBytes.equals(bomb)).toBe(true);
    const [call] = await waitForCalls(store);
    expect(call?.usage.inputTokens).toBe(0);
    expect(warnings.some((w) => w.includes("could not decode gzip"))).toBe(true);
  });
  it("strips headers named in Connection, in both directions", async () => {
    let seenRequestHeaders: http.IncomingHttpHeaders | undefined;
    upstream = await startFakeUpstream((req, res) => {
      seenRequestHeaders = req.headers;
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "x-upstream-hop",
        "x-upstream-hop": "secret",
        "x-upstream-kept": "yes"
      });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { headers } = await rawRequest(proxy.port, {
      "content-type": "application/json",
      connection: "x-client-hop, keep-alive",
      "x-client-hop": "secret",
      "x-client-kept": "yes"
    });
    expect(seenRequestHeaders?.["x-client-hop"]).toBeUndefined();
    expect(seenRequestHeaders?.["x-client-kept"]).toBe("yes");
    expect(headers["x-upstream-hop"]).toBeUndefined();
    expect(headers["x-upstream-kept"]).toBe("yes");
  });
  it("replaces an upstream 5xx body with a generic JSON error, logs the real body, and does not capture", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(503, { "content-type": "application/json", "x-internal": "1" });
      res.end(JSON.stringify({ error: { message: "db-host-17 stack trace" } }));
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      onWarning: (m) => warnings.push(m)
    });
    const { status, body } = await postToProxy(proxy, requestBody());
    expect(status).toBe(503);
    expect(JSON.parse(body)).toEqual({ error: "upstream error" });
    expect(body).not.toContain("db-host-17");
    expect(warnings.some((w) => w.includes("503") && w.includes("db-host-17"))).toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });
  it("does not forward the upstream connection error text to the client", async () => {
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: "http://127.0.0.1:1",
      onWarning: (m) => warnings.push(m)
    });
    const { status, body } = await postToProxy(proxy, requestBody());
    expect(status).toBe(502);
    expect(body).not.toContain("ECONNREFUSED");
    expect(warnings.some((w) => w.includes("ECONNREFUSED"))).toBe(true);
  });
  it("close() waits for in-flight captures to be written", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const originalAppend = store.append.bind(store);
    store.append = async (call) => {
      await gate;
      await originalAppend(call);
    };
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    await postToProxy(proxy, requestBody());
    let closed = false;
    const closing = proxy.close().then(() => {
      closed = true;
    });
    proxy = undefined;
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(false);
    release();
    await closing;
    await expect(store.list()).resolves.toHaveLength(1);
  });
  it.each([
    ["x-gzip", (b: Buffer) => gzipSync(b)],
    ["deflate", (b: Buffer) => deflateSync(b)],
    ["br", (b: Buffer) => brotliCompressSync(b)]
  ] as const)("decodes a %s response body to read usage", async (encoding, encode) => {
    const compressed = encode(Buffer.from(JSON.stringify(SUCCESS_BODY), "utf8"));
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": encoding });
      res.end(compressed);
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { body } = await rawRequest(proxy.port, { "content-type": "application/json" });
    expect(body.equals(compressed)).toBe(true);
    const [call] = await waitForCalls(store);
    expect(call?.usage.inputTokens).toBe(100);
    expect(call?.usage.cacheReadInputTokens).toBe(200);
  });
  it("reads usage from a response that carries no content-type header", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { status } = await postToProxy(proxy, requestBody());
    expect(status).toBe(200);
    const [call] = await waitForCalls(store);
    expect(call?.usage.outputTokens).toBe(50);
  });
  it("brackets an IPv6 bound address in the reported url", async () => {
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, host: "::1", upstreamBaseUrl: "http://127.0.0.1:1" });
    expect(proxy.host).toBe("::1");
    expect(proxy.url).toBe(`http://[::1]:${proxy.port}`);
  });
  it("rejects a second close() because the server is no longer running", async () => {
    const store = new MemoryTraceStore();
    const started = await startProxy({ store, upstreamBaseUrl: "http://127.0.0.1:1" });
    await started.close();
    await expect(started.close()).rejects.toThrow(/not running/i);
  });
  it("logs capture failures to stderr when no onCaptureError handler is given", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      upstream = await startFakeUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(SUCCESS_BODY));
      });
      const store = new MemoryTraceStore();
      store.append = () => Promise.reject(new Error("disk full"));
      proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
      const { status } = await postToProxy(proxy, requestBody());
      expect(status).toBe(200);
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          "[cachelens proxy] capture failed:",
          expect.objectContaining({ message: "disk full" })
        )
      );
    } finally {
      consoleError.mockRestore();
    }
  });
  it("destroys the client response and captures nothing when upstream dies mid-body", async () => {
    let requestCount = 0;
    upstream = await startFakeUpstream((_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      if (requestCount > 1) {
        res.end(JSON.stringify(SUCCESS_BODY).padEnd(1000, " "));
        return;
      }
      // Flush the headers and a partial body, then hang up short of content-length.
      res.write('{"usage":', () => setImmediate(() => res.socket?.destroy()));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    await expect(rawRequest(proxy.port, { "content-type": "application/json" })).rejects.toThrow();
    const followUp = await postToProxy(proxy, requestBody());
    expect(followUp.status).toBe(200);
    const [call] = await waitForCalls(store);
    expect(call?.usage.inputTokens).toBe(100);
    await expect(store.list()).resolves.toHaveLength(1);
  });
  it("keeps only the first 4 KiB of an upstream 5xx body in the warning", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.write("a".repeat(4000));
      res.write("b".repeat(4000));
      res.end("c".repeat(4000));
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      onWarning: (m) => warnings.push(m)
    });
    const { status } = await postToProxy(proxy, requestBody());
    expect(status).toBe(500);
    const [warning] = warnings;
    expect(warning).toBe(`upstream responded 500: ${"a".repeat(4000)}${"b".repeat(96)}`);
  });
  it("ignores request chunks that arrive after the body limit was exceeded", async () => {
    let upstreamCalls = 0;
    upstream = await startFakeUpstream((_req, res) => {
      upstreamCalls++;
      res.end();
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url, maxRequestBodyBytes: 10 });
    const port = proxy.port;
    const status = await new Promise<number>((resolve, reject) => {
      const clientReq = http.request(
        { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      clientReq.on("error", reject);
      clientReq.write("x".repeat(64));
      clientReq.write("y".repeat(64));
      clientReq.end("z".repeat(64));
    });
    expect(status).toBe(413);
    expect(upstreamCalls).toBe(0);
  });
  it("aborts the upstream request and captures nothing when the client leaves before upstream answers", async () => {
    let signalReceived: () => void = () => {};
    const upstreamReceived = new Promise<void>((resolve) => {
      signalReceived = resolve;
    });
    let upstreamSawAbort = false;
    upstream = await startFakeUpstream((_req, res) => {
      res.on("close", () => {
        if (!res.writableEnded) upstreamSawAbort = true;
      });
      signalReceived();
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const clientReq = http.request({
      hostname: "127.0.0.1",
      port: proxy.port,
      path: "/v1/messages",
      method: "POST"
    });
    clientReq.on("error", () => {});
    clientReq.end(requestBody());
    await upstreamReceived;
    clientReq.destroy();
    await vi.waitFor(() => expect(upstreamSawAbort).toBe(true), { timeout: 2000 });
    await proxy.close();
    proxy = undefined;
    await expect(store.list()).resolves.toEqual([]);
  });
  it("ignores empty tokens in the Connection header", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "x-upstream-hop, , keep-alive",
        "x-upstream-hop": "secret"
      });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const { status, headers } = await rawRequest(proxy.port, {
      "content-type": "application/json"
    });
    expect(status).toBe(200);
    expect(headers["x-upstream-hop"]).toBeUndefined();
  });
  it("never contacts upstream when the client aborts while still sending the body", async () => {
    let upstreamCalls = 0;
    upstream = await startFakeUpstream((_req, res) => {
      upstreamCalls++;
      res.end();
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const port = proxy.port;
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          'POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\n{"model":',
          () => socket.destroy()
        );
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve());
    });
    const followUp = await postToProxy(proxy, requestBody());
    expect(followUp.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });
  it("cuts the client response and captures nothing when upstream stalls after sending headers", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"usage":');
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url, upstreamTimeoutMs: 50 });
    await expect(rawRequest(proxy.port, { "content-type": "application/json" })).rejects.toThrow();
    await expect(store.list()).resolves.toEqual([]);
  });
  it("answers 504 and logs the partial body when a 5xx response stalls mid-body", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain", "content-length": "1000" });
      res.write("partial upstream failure");
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      upstreamTimeoutMs: 50,
      onWarning: (m) => warnings.push(m)
    });
    const { status, body } = await postToProxy(proxy, requestBody());
    expect(status).toBe(504);
    expect(body).toBe("cachelens proxy: upstream timed out\n");
    await vi.waitFor(() =>
      expect(warnings).toContain("upstream responded 503: partial upstream failure")
    );
    await expect(store.list()).resolves.toEqual([]);
  });
  it("answers 502 when an https upstream without an explicit port (443) refuses the connection", async () => {
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: "https://localhost",
      onWarning: (m) => warnings.push(m)
    });
    const { status } = await postToProxy(proxy, requestBody());
    expect(status).toBe(502);
    expect(warnings.some((w) => w.startsWith("upstream request failed:"))).toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });
  it("keeps upstream headers such as retry-after on a replaced 5xx body", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(529, {
        "content-type": "application/json",
        "retry-after": "17",
        "x-should-retry": "true",
        "request-id": "req_abc",
        connection: "x-hop",
        "x-hop": "drop-me"
      });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url, onWarning: () => {} });
    const { status, headers, body } = await rawRequest(proxy.port, {
      "content-type": "application/json"
    });
    expect(status).toBe(529);
    expect(headers["retry-after"]).toBe("17");
    expect(headers["x-should-retry"]).toBe("true");
    expect(headers["request-id"]).toBe("req_abc");
    expect(headers["x-hop"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(body.toString("utf8"))).toEqual({ error: "upstream error" });
  });
  it("defaults to the https Anthropic upstream without a cleartext warning", async () => {
    const warnings: string[] = [];
    proxy = await startProxy({ store: new MemoryTraceStore(), onWarning: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
  it("warns when bound to the IPv6 any-address", async () => {
    const warnings: string[] = [];
    try {
      proxy = await startProxy({
        store: new MemoryTraceStore(),
        upstreamBaseUrl: "http://127.0.0.1:1",
        host: "::",
        onWarning: (m) => warnings.push(m)
      });
    } catch (error) {
      // Platform guard: hosts without IPv6 cannot bind "::".
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") return;
      throw error;
    }
    expect(proxy.host).toBe("::");
    expect(proxy.url).toBe(`http://[::]:${proxy.port}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("non-loopback address ::");
  });
  it("captures a request sent without any Connection header", async () => {
    let seenConnection: string | undefined;
    upstream = await startFakeUpstream((req, res) => {
      seenConnection = req.headers.connection;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const port = proxy.port;
    const body = requestBody();
    const response = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (d: string) => {
        text += d;
        if (text.includes('"msg_1"')) socket.end();
      });
      socket.on("close", () => resolve(text));
      socket.write(
        `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
    });
    expect(response).toMatch(/^HTTP\/1\.1 200/);
    expect(seenConnection).not.toBe("close");
    const [call] = await waitForCalls(store);
    expect(call?.usage.inputTokens).toBe(100);
  });
  it("relays a multi-megabyte response byte-for-byte under client backpressure", async () => {
    const big = JSON.stringify({ ...SUCCESS_BODY, padding: "b".repeat(4 * 1024 * 1024) });
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(big);
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const port = proxy.port;
    const received = await new Promise<Buffer>((resolve, reject) => {
      const clientReq = http.request(
        { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST" },
        (res) => {
          // Read slowly at first so the proxy's writes hit backpressure.
          res.pause();
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
          setImmediate(() => res.resume());
        }
      );
      clientReq.on("error", reject);
      clientReq.end(requestBody());
    });
    expect(received.toString("utf8")).toBe(big);
    const [call] = await waitForCalls(store);
    expect(call?.usage.inputTokens).toBe(100);
  });
  it("aborts the client response and stays up when upstream dies mid-body", async () => {
    let requests = 0;
    upstream = await startFakeUpstream((_req, res) => {
      requests++;
      if (requests === 1) {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write('{"partial":');
        setImmediate(() => res.socket?.destroy());
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    await expect(
      fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cachelens-step": "broken" },
        body: requestBody()
      }).then((r) => r.text())
    ).rejects.toThrow();
    const { status } = await postToProxy(proxy, requestBody(), { "x-cachelens-step": "ok" });
    expect(status).toBe(200);
    const calls = await waitForCalls(store, 1);
    expect(calls.map((c) => c.stepName)).toEqual(["ok"]);
  });
  it("replaces a 5xx that has no content-type and keeps its other headers", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(500, { "x-request-id": "r1" });
      res.end("plain text failure");
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      onWarning: (m) => warnings.push(m)
    });
    const { status, headers, body } = await rawRequest(proxy.port, {});
    expect(status).toBe(500);
    expect(headers["x-request-id"]).toBe("r1");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(body.toString("utf8"))).toEqual({ error: "upstream error" });
    expect(warnings.some((w) => w.includes("plain text failure"))).toBe(true);
  });
  it("captures a completion call under a base-URL path prefix, with the provider detected", async () => {
    upstream = await startFakeUpstream((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url?.includes("/chat/completions")
            ? {
                usage: {
                  prompt_tokens: 50,
                  completion_tokens: 5,
                  prompt_tokens_details: { cached_tokens: 20 }
                }
              }
            : SUCCESS_BODY
        )
      );
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    await postToProxy(proxy, requestBody(), { "x-cachelens-step": "a" }, "/anthropic/v1/messages");
    await postToProxy(
      proxy,
      JSON.stringify({ model: "gpt-5", messages: [] }),
      { "x-cachelens-step": "o" },
      "/openai/v1/chat/completions"
    );
    const calls = await waitForCalls(store, 2);
    const byStep = new Map(calls.map((c) => [c.stepName, c]));
    expect(byStep.get("a")?.provider).toBe("anthropic");
    expect(byStep.get("a")?.usage.inputTokens).toBe(100);
    expect(byStep.get("o")?.provider).toBe("openai");
    expect(byStep.get("o")?.usage.cacheReadInputTokens).toBe(20);
  });
  it("does not capture count_tokens under a base-URL path prefix", async () => {
    upstream = await startFakeUpstream((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(req.url?.endsWith("count_tokens") ? { input_tokens: 12 } : SUCCESS_BODY)
      );
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    const counted = await postToProxy(
      proxy,
      requestBody(),
      { "x-cachelens-step": "count" },
      "/anthropic/v1/messages/count_tokens"
    );
    expect(JSON.parse(counted.body)).toEqual({ input_tokens: 12 });
    await postToProxy(
      proxy,
      requestBody(),
      { "x-cachelens-step": "real" },
      "/anthropic/v1/messages"
    );
    const calls = await waitForCalls(store, 1);
    expect(calls.map((c) => c.stepName)).toEqual(["real"]);
  });
  it("warns once when the first 10 proxied requests captured nothing", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      onWarning: (m) => warnings.push(m)
    });
    for (let i = 0; i < 9; i++) {
      await postToProxy(proxy, requestBody(), {}, "/wrong/messages");
    }
    expect(warnings).toEqual([]);
    for (let i = 0; i < 5; i++) {
      await postToProxy(proxy, requestBody(), {}, "/wrong/messages");
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("proxied 10 requests, captured 0: check the base URL path");
    await expect(store.list()).resolves.toEqual([]);
  });
  it("does not warn about zero captures once something was captured", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    const warnings: string[] = [];
    proxy = await startProxy({
      store,
      upstreamBaseUrl: upstream.url,
      onWarning: (m) => warnings.push(m)
    });
    await postToProxy(proxy, requestBody());
    for (let i = 0; i < 12; i++) {
      await postToProxy(proxy, requestBody(), {}, "/v1/messages/count_tokens");
    }
    expect(warnings).toEqual([]);
  });
});
