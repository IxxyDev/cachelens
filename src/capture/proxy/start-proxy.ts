import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { LlmCall, Usage } from "../../core/model/call.js";
import type { TraceStore } from "../../store/trace-store.js";
import { redactWireBody } from "../redact.js";
import { parseRequestParams, parseUsageFromJsonText } from "../wrap/anthropic.js";
import { createSseUsageAccumulator } from "./sse-usage.js";
const SESSION_HEADER = "x-cachelens-session";
const STEP_HEADER = "x-cachelens-step";
export const DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_STEP_NAME = "proxy";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization"
]);
function isHopByHop(headerNameLower: string): boolean {
  return HOP_BY_HOP_HEADERS.has(headerNameLower) || headerNameLower.startsWith("proxy-");
}
export interface StartProxyOptions {
  readonly store: TraceStore;
  readonly port?: number;
  readonly upstreamBaseUrl?: string;
  readonly raw?: boolean;
  readonly now?: () => number;
  readonly onCaptureError?: (error: unknown) => void;
  readonly upstreamTimeoutMs?: number;
  readonly maxRequestBodyBytes?: number;
}
export interface StartedProxy {
  readonly port: number;
  close(): Promise<void>;
}
export function startProxy(options: StartProxyOptions): Promise<StartedProxy> {
  const upstream = new URL(options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL);
  const requestUpstream = upstream.protocol === "http:" ? http.request : https.request;
  const now = options.now ?? Date.now;
  const onCaptureError = options.onCaptureError ?? defaultCaptureErrorHandler;
  const server = http.createServer((req, res) => {
    handleRequest(req, res, upstream, requestUpstream, options, now, onCaptureError).catch(
      (error: unknown) => {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (error instanceof PayloadTooLargeError) {
          res.writeHead(413, { "content-type": "text/plain" });
          res.end(`cachelens proxy: ${error.message}\n`);
          return;
        }
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("cachelens proxy error");
      }
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          })
      });
    });
  });
}
type RequestUpstreamFn = typeof http.request | typeof https.request;
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: URL,
  requestUpstream: RequestUpstreamFn,
  options: StartProxyOptions,
  now: () => number,
  onCaptureError: (error: unknown) => void
): Promise<void> {
  const startedAt = now();
  const sessionId = firstHeader(req.headers[SESSION_HEADER]) ?? randomUUID();
  const stepName = firstHeader(req.headers[STEP_HEADER]) ?? DEFAULT_STEP_NAME;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const requestBody = await collectBody(req, maxRequestBodyBytes);
  await new Promise<void>((resolve, reject) => {
    let clientDisconnected = false;
    let upstreamTimedOut = false;
    const upstreamReq = requestUpstream(
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
        res.writeHead(upstreamRes.statusCode ?? 502, stripHopByHopHeaders(upstreamRes.headers));
        const contentType = firstHeader(upstreamRes.headers["content-type"]) ?? "";
        const isEventStream = contentType.includes("text/event-stream");
        const sse = isEventStream ? createSseUsageAccumulator() : undefined;
        const bodyChunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => {
          if (clientDisconnected) return;
          if (!res.write(chunk)) {
            upstreamRes.pause();
            res.once("drain", () => upstreamRes.resume());
          }
          if (sse) {
            sse.push(chunk);
          } else {
            bodyChunks.push(chunk);
          }
        });
        upstreamRes.on("end", () => {
          if (!clientDisconnected) {
            res.end();
          }
          const durationMs = now() - startedAt;
          try {
            const usage = sse
              ? sse.finalize()
              : parseUsageFromJsonText(
                  decodeResponseBodyForParsing(
                    Buffer.concat(bodyChunks),
                    firstHeader(upstreamRes.headers["content-encoding"])
                  )
                );
            captureCall(options, {
              sessionId,
              stepName,
              startedAt,
              durationMs,
              wireBody: requestBody.toString("utf8"),
              usage
            }).catch(onCaptureError);
          } catch (error) {
            onCaptureError(error);
          }
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
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(
          upstreamTimedOut
            ? "cachelens proxy: upstream timed out\n"
            : `cachelens proxy: upstream error: ${error.message}\n`
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
function buildForwardHeaders(
  headers: http.IncomingHttpHeaders,
  upstream: URL,
  bodyLength: number
): http.OutgoingHttpHeaders {
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
  const result: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (isHopByHop(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}
function decodeResponseBodyForParsing(body: Buffer, contentEncoding: string | undefined): string {
  const encoding = contentEncoding?.trim().toLowerCase();
  try {
    switch (encoding) {
      case "gzip":
      case "x-gzip":
        return gunzipSync(body).toString("utf8");
      case "deflate":
        return inflateSync(body).toString("utf8");
      case "br":
        return brotliDecompressSync(body).toString("utf8");
      default:
        return body.toString("utf8");
    }
  } catch {
    return body.toString("utf8");
  }
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
async function captureCall(options: StartProxyOptions, args: CaptureArgs): Promise<void> {
  const call: LlmCall = {
    id: randomUUID(),
    sessionId: args.sessionId,
    stepName: args.stepName,
    timestamp: args.startedAt,
    params: parseRequestParams(args.wireBody),
    payload: { wireBody: redactWireBody(args.wireBody, { raw: options.raw ?? false }) },
    usage: args.usage,
    durationMs: args.durationMs
  };
  await options.store.append(call);
}
function defaultCaptureErrorHandler(error: unknown): void {
  console.error("[cachelens proxy] capture failed:", error);
}
