import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import { type AddressInfo, isIP } from "node:net";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import type { LlmCall, Usage } from "../../core/model/call.js";
import type { Provider } from "../../core/model/provider.js";
import type { TraceStore } from "../../store/trace-store.js";
import type { CaptureAdapter } from "../capture-fetch.js";
import { redactWireBody } from "../redact.js";
import {
  parseJsonText,
  type SseParserOptions,
  type SseUsageAccumulator,
  ZERO_USAGE
} from "../shared.js";
import { createAnthropicSseUsageAccumulator } from "../usage/anthropic.js";
import { createOpenAiSseUsageAccumulator } from "../usage/openai.js";
import { anthropicCaptureAdapter } from "../wrap/anthropic.js";
import { openAiCaptureAdapter } from "../wrap/openai.js";

const SESSION_HEADER = "x-cachelens-session";
const STEP_HEADER = "x-cachelens-step";
export const DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_STEP_NAME = "proxy";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60000;
/** How much of an upstream 5xx body is kept for the warning log. */
const MAX_LOGGED_ERROR_BODY_BYTES = 4096;
const UPSTREAM_ERROR_BODY = JSON.stringify({ error: "upstream error" });
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization"
]);
/** OpenAI API paths; every other path is treated as Anthropic. */
const OPENAI_PATH = /\/v1\/(?:chat\/completions|responses|completions|embeddings)(?:[/?]|$)/;
/** Completion endpoints whose successful POST responses are recorded as LLM calls. */
const CAPTURED_PATH = /\/v1\/(?:messages|chat\/completions|responses|completions)(?:\?|$)/;
/** After this many proxied exchanges with nothing captured, warn once about the base URL path. */
const ZERO_CAPTURE_WARNING_AFTER = 10;
interface ProviderCapture {
  readonly adapter: CaptureAdapter;
  createSseUsageAccumulator(options: SseParserOptions): SseUsageAccumulator;
}
const PROVIDER_CAPTURE: Readonly<Record<Provider, ProviderCapture>> = {
  anthropic: {
    adapter: anthropicCaptureAdapter,
    createSseUsageAccumulator: createAnthropicSseUsageAccumulator
  },
  openai: {
    adapter: openAiCaptureAdapter,
    createSseUsageAccumulator: createOpenAiSseUsageAccumulator
  }
};
export interface StartProxyOptions {
  readonly store: TraceStore;
  readonly port?: number;
  /** Interface to bind. Default `127.0.0.1` (loopback only). */
  readonly host?: string;
  readonly upstreamBaseUrl?: string;
  readonly raw?: boolean;
  readonly now?: () => number;
  /**
   * Session id recorded for requests without an `x-cachelens-session` header.
   * Default: one random id generated when the proxy starts, shared by all such requests.
   */
  readonly sessionId?: string;
  readonly onCaptureError?: (error: unknown) => void;
  /** Non-fatal operational warnings (capture skipped, upstream 5xx body, insecure upstream). */
  readonly onWarning?: (message: string) => void;
  readonly upstreamTimeoutMs?: number;
  readonly maxRequestBodyBytes?: number;
  /**
   * Cap on how much of a non-SSE response body is buffered (and decompressed)
   * to read usage. The client always receives the full body; past the cap the
   * call is recorded with zero usage and a warning. Default 10 MiB.
   */
  readonly maxCaptureBytes?: number;
}
export interface StartedProxy {
  /** Bound address as reported by `server.address()`. */
  readonly host: string;
  readonly port: number;
  /** `http://<host>:<port>` for the bound address (IPv6 hosts bracketed). */
  readonly url: string;
  /** Stops accepting connections and waits for in-flight captures to be written. */
  close(): Promise<void>;
}
export function startProxy(options: StartProxyOptions): Promise<StartedProxy> {
  const upstream = new URL(options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL);
  const requestUpstream = upstream.protocol === "http:" ? http.request : https.request;
  const onWarning = options.onWarning ?? defaultWarningHandler;
  const context: ProxyContext = {
    options,
    upstream,
    requestUpstream,
    now: options.now ?? Date.now,
    onCaptureError: options.onCaptureError ?? defaultCaptureErrorHandler,
    onWarning,
    defaultSessionId: options.sessionId ?? randomUUID(),
    maxCaptureBytes: options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES,
    pendingCaptures: new Set(),
    stats: { proxied: 0, captured: 0 }
  };
  if (upstream.protocol === "http:" && !isLoopbackHost(upstream.hostname)) {
    onWarning(
      `upstream ${upstream.origin} uses cleartext http:// on a non-loopback host; API keys and prompts are sent unencrypted`
    );
  }
  const server = http.createServer((req, res) => {
    handleRequest(req, res, context).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (error instanceof PayloadTooLargeError) {
        // The unread request body is still on the socket: close it once the
        // 413 is flushed instead of keeping the connection alive.
        res.once("finish", () => req.destroy());
        res.writeHead(413, { "content-type": "text/plain", connection: "close" });
        res.end(`cachelens proxy: ${error.message}\n`);
        return;
      }
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("cachelens proxy error");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? DEFAULT_PROXY_HOST, () => {
      // A TCP listen always reports an AddressInfo (strings are for pipes/sockets).
      const { address: host, port } = server.address() as AddressInfo;
      if (!isLoopbackHost(host)) {
        onWarning(
          `listening on non-loopback address ${host}: anyone who can reach it can send requests upstream with your API credentials`
        );
      }
      resolve({
        host,
        port,
        url: `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
        close: async () => {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          });
          while (context.pendingCaptures.size > 0) {
            await Promise.allSettled([...context.pendingCaptures]);
          }
        }
      });
    });
  });
}
type RequestUpstreamFn = typeof http.request | typeof https.request;
interface ProxyContext {
  readonly options: StartProxyOptions;
  readonly upstream: URL;
  readonly requestUpstream: RequestUpstreamFn;
  readonly now: () => number;
  readonly onCaptureError: (error: unknown) => void;
  readonly onWarning: (message: string) => void;
  readonly defaultSessionId: string;
  readonly maxCaptureBytes: number;
  readonly pendingCaptures: Set<Promise<void>>;
  readonly stats: { proxied: number; captured: number };
}
/**
 * Only successful (2xx) POSTs to a completion endpoint are recorded, matching
 * the path by suffix so a base-URL prefix (`/anthropic/v1/messages`) works,
 * also
 * the SDK wrappers; count_tokens, model listings, embeddings and error
 * responses are proxied untouched without capture.
 */
export function isCapturedExchange(
  method: string | undefined,
  path: string | undefined,
  status: number
): boolean {
  return (
    method === "POST" &&
    status >= 200 &&
    status < 300 &&
    path !== undefined &&
    CAPTURED_PATH.test(path)
  );
}
/** Counts exchanges and warns once when the first ones captured nothing. */
function countExchange(context: ProxyContext, captured: boolean): void {
  const { stats } = context;
  stats.proxied++;
  if (captured) stats.captured++;
  if (stats.proxied === ZERO_CAPTURE_WARNING_AFTER && stats.captured === 0) {
    context.onWarning(
      `proxied ${stats.proxied} requests, captured 0: check the base URL path (only successful POSTs to .../v1/messages, /v1/chat/completions, /v1/responses or /v1/completions are recorded)`
    );
  }
}
/** Picks the provider from the request path (`/v1/chat/completions` etc. are OpenAI). */
export function detectProvider(path: string | undefined): Provider {
  return path !== undefined && OPENAI_PATH.test(path) ? "openai" : "anthropic";
}
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: ProxyContext
): Promise<void> {
  const { options, upstream, now, onWarning } = context;
  const startedAt = now();
  const sessionId = firstHeader(req.headers[SESSION_HEADER]) ?? context.defaultSessionId;
  const stepName = firstHeader(req.headers[STEP_HEADER]) ?? DEFAULT_STEP_NAME;
  const provider = detectProvider(req.url);
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const requestBody = await collectBody(req, maxRequestBodyBytes);
  await new Promise<void>((resolve, reject) => {
    let clientDisconnected = false;
    let upstreamTimedOut = false;
    const upstreamReq = context.requestUpstream(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: buildForwardHeaders(req.headers, upstream, requestBody.length)
      },
      (upstreamRes) => {
        if (clientDisconnected) {
          upstreamRes.resume();
          resolve();
          return;
        }
        const status = upstreamRes.statusCode ?? 502;
        const captured = isCapturedExchange(req.method, req.url, status);
        countExchange(context, captured);
        if (status >= 500) {
          relayUpstreamServerError(upstreamRes, res, status, onWarning, resolve);
          return;
        }
        res.writeHead(status, stripHopByHopHeaders(upstreamRes.headers));
        // Exchanges that are not captured are only piped through: no buffering or parsing.
        const contentType = firstHeader(upstreamRes.headers["content-type"]) ?? "";
        const capture = PROVIDER_CAPTURE[provider];
        const sse =
          captured && contentType.includes("text/event-stream")
            ? capture.createSseUsageAccumulator({ onWarning })
            : undefined;
        const bodyChunks: Buffer[] = [];
        let bufferedBytes = 0;
        let captureOverflow = false;
        upstreamRes.on("data", (chunk: Buffer) => {
          if (clientDisconnected) return;
          if (!res.write(chunk)) {
            upstreamRes.pause();
            res.once("drain", () => upstreamRes.resume());
          }
          if (!captured) return;
          if (sse) {
            sse.push(chunk);
            return;
          }
          if (captureOverflow) return;
          bufferedBytes += chunk.length;
          if (bufferedBytes > context.maxCaptureBytes) {
            captureOverflow = true;
            bodyChunks.length = 0;
            return;
          }
          bodyChunks.push(chunk);
        });
        upstreamRes.on("end", () => {
          if (!clientDisconnected) {
            res.end();
          }
          if (!captured) {
            resolve();
            return;
          }
          const durationMs = now() - startedAt;
          const recording = (async () => {
            let usage: Usage;
            if (sse) {
              usage = sse.finalize();
            } else if (captureOverflow) {
              onWarning(
                `${req.method} ${req.url}: response body exceeded ${context.maxCaptureBytes} bytes; recorded with zero usage`
              );
              usage = ZERO_USAGE;
            } else {
              usage = await readJsonUsage(
                capture.adapter,
                Buffer.concat(bodyChunks),
                firstHeader(upstreamRes.headers["content-encoding"]),
                context.maxCaptureBytes,
                onWarning
              );
            }
            await captureCall(options, capture.adapter, {
              sessionId,
              stepName,
              startedAt,
              durationMs,
              wireBody: requestBody.toString("utf8"),
              usage
            });
          })().catch(context.onCaptureError);
          context.pendingCaptures.add(recording);
          void recording.finally(() => context.pendingCaptures.delete(recording));
          resolve();
        });
        upstreamRes.on("error", (error) => {
          if (!clientDisconnected) {
            res.destroy(error);
          }
          reject(error);
        });
      }
    );
    upstreamReq.setTimeout(options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS, () => {
      upstreamTimedOut = true;
      upstreamReq.destroy(new Error("upstream timeout"));
    });
    upstreamReq.on("error", (error) => {
      if (clientDisconnected) {
        resolve();
        return;
      }
      if (!res.headersSent) {
        const status = upstreamTimedOut ? 504 : 502;
        if (!upstreamTimedOut) {
          onWarning(`upstream request failed: ${error.message}`);
        }
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(
          upstreamTimedOut
            ? "cachelens proxy: upstream timed out\n"
            : "cachelens proxy: upstream error\n"
        );
        resolve();
      } else {
        res.destroy(error);
        reject(error);
      }
    });
    res.on("close", () => {
      if (clientDisconnected) return;
      clientDisconnected = true;
      if (!upstreamReq.destroyed) {
        upstreamReq.destroy();
      }
      resolve();
    });
    res.on("error", () => {});
    upstreamReq.end(requestBody);
  });
}
/**
 * Upstream 5xx bodies can echo internal details: the client gets the status
 * and upstream headers (retry-after, request-id, ...) with a generic JSON body, the (truncated) real body goes to `onWarning`.
 * Nothing is captured for a call the provider failed.
 */
function relayUpstreamServerError(
  upstreamRes: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  onWarning: (message: string) => void,
  done: () => void
): void {
  const chunks: Buffer[] = [];
  let kept = 0;
  upstreamRes.on("data", (chunk: Buffer) => {
    if (kept >= MAX_LOGGED_ERROR_BODY_BYTES) return;
    const slice = chunk.subarray(0, MAX_LOGGED_ERROR_BODY_BYTES - kept);
    chunks.push(slice);
    kept += slice.length;
  });
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    onWarning(`upstream responded ${status}: ${Buffer.concat(chunks).toString("utf8")}`);
    if (!res.headersSent) {
      const headers = stripHopByHopHeaders(upstreamRes.headers);
      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (
          lower === "content-length" ||
          lower === "content-encoding" ||
          lower === "content-type"
        ) {
          delete headers[name];
        }
      }
      res.writeHead(status, { ...headers, "content-type": "application/json" });
      res.end(UPSTREAM_ERROR_BODY);
    }
    done();
  };
  upstreamRes.on("end", finish);
  upstreamRes.on("error", finish);
}
class PayloadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body exceeds ${limitBytes} byte limit`);
    this.name = "PayloadTooLargeError";
  }
}
function collectBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.pause();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
/**
 * Hop-by-hop headers (RFC 9110 §7.6.1): the fixed list, any `proxy-*`
 * header, and every header named in this message's `Connection` header.
 */
function hopByHopFilter(headers: http.IncomingHttpHeaders): (headerNameLower: string) => boolean {
  const named = new Set<string>();
  const connection = headers.connection;
  for (const value of Array.isArray(connection) ? connection : [connection ?? ""]) {
    for (const token of value.split(",")) {
      const name = token.trim().toLowerCase();
      if (name.length > 0) named.add(name);
    }
  }
  return (lower) => HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith("proxy-") || named.has(lower);
}
function buildForwardHeaders(
  headers: http.IncomingHttpHeaders,
  upstream: URL,
  bodyLength: number
): http.OutgoingHttpHeaders {
  const isHopByHop = hopByHopFilter(headers);
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === SESSION_HEADER || lower === STEP_HEADER) continue;
    if (lower === "host" || lower === "content-length" || lower === "accept-encoding") continue;
    if (isHopByHop(lower)) continue;
    forwarded[key] = value;
  }
  forwarded.host = upstream.host;
  forwarded["content-length"] = String(bodyLength);
  forwarded["accept-encoding"] = "identity";
  return forwarded;
}
function stripHopByHopHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const isHopByHop = hopByHopFilter(headers);
  const result: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (isHopByHop(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}
async function readJsonUsage(
  adapter: CaptureAdapter,
  body: Buffer,
  contentEncoding: string | undefined,
  maxOutputLength: number,
  onWarning: (message: string) => void
): Promise<Usage> {
  let text: string;
  try {
    text = (await decompress(body, contentEncoding, maxOutputLength)).toString("utf8");
  } catch (error) {
    onWarning(
      `could not decode ${contentEncoding ?? "identity"} response body for usage (${
        error instanceof Error ? error.message : String(error)
      }); recorded with zero usage`
    );
    return ZERO_USAGE;
  }
  return adapter.parseUsageJson(parseJsonText(text));
}
function decompress(
  body: Buffer,
  contentEncoding: string | undefined,
  maxOutputLength: number
): Promise<Buffer> {
  const encoding = contentEncoding?.trim().toLowerCase();
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer): void => {
      if (error) reject(error);
      else resolve(result);
    };
    switch (encoding) {
      case "gzip":
      case "x-gzip":
        gunzip(body, { maxOutputLength }, done);
        return;
      case "deflate":
        inflate(body, { maxOutputLength }, done);
        return;
      case "br":
        brotliDecompress(body, { maxOutputLength }, done);
        return;
      default:
        resolve(body);
    }
  });
}
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
interface CaptureArgs {
  readonly sessionId: string;
  readonly stepName: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly wireBody: string;
  readonly usage: Usage;
}
async function captureCall(
  options: StartProxyOptions,
  adapter: CaptureAdapter,
  args: CaptureArgs
): Promise<void> {
  const call: LlmCall = {
    id: randomUUID(),
    sessionId: args.sessionId,
    stepName: args.stepName,
    timestamp: args.startedAt,
    params: adapter.parseRequest(args.wireBody).params,
    payload: { wireBody: redactWireBody(args.wireBody, { raw: options.raw ?? false }) },
    usage: args.usage,
    durationMs: args.durationMs,
    provider: adapter.provider
  };
  await options.store.append(call);
}
function defaultCaptureErrorHandler(error: unknown): void {
  console.error("[cachelens proxy] capture failed:", error);
}
function defaultWarningHandler(message: string): void {
  console.error(`[cachelens proxy] warning: ${message}`);
}
