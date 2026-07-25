import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTraceStore } from "../../store/memory-store.js";
import { startProxy } from "./start-proxy.js";
import type { StartedProxy } from "./start-proxy.js";
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
  headers: Record<string, string> = {}
): Promise<{
  status: number;
  body: string;
}> {
  const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
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
    const [call] = await store.list();
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
  });
  it("defaults session/step when headers are absent", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SUCCESS_BODY));
    });
    const store = new MemoryTraceStore();
    proxy = await startProxy({ store, upstreamBaseUrl: upstream.url });
    await postToProxy(proxy, requestBody());
    const [call] = await store.list();
    expect(call?.stepName).toBe("proxy");
    expect(typeof call?.sessionId).toBe("string");
    expect(call?.sessionId.length).toBeGreaterThan(0);
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
    const [call] = await store.list();
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
    const [call] = await store.list();
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
    await new Promise((r) => setTimeout(r, 10));
    expect(captureErrors).toHaveLength(1);
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
    const [call] = await store.list();
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
    const firstChunk = await new Promise<Buffer>((resolve, reject) => {
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
      setTimeout(() => reject(new Error("timed out waiting for first chunk")), 2000);
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
});
