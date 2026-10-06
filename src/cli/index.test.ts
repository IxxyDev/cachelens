import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmCall, RequestParams, Usage } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { run } from "./index.js";
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
function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: tokenCount(0),
    outputTokens: tokenCount(0),
    cacheCreationInputTokens: tokenCount(0),
    cacheReadInputTokens: tokenCount(0),
    ...overrides
  };
}
function makeCall(params: {
  readonly id: string;
  readonly sessionId: string;
  readonly stepName: string;
  readonly wireBody: unknown;
  readonly timestamp: number;
  readonly usage?: Partial<Usage>;
  readonly requestParams?: Partial<RequestParams>;
}): LlmCall {
  return {
    id: params.id,
    sessionId: params.sessionId,
    stepName: params.stepName,
    timestamp: params.timestamp,
    params: { model: "claude-sonnet-4-5", ...params.requestParams },
    payload: { wireBody: JSON.stringify(params.wireBody) },
    usage: makeUsage(params.usage)
  };
}
function createIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: (text: string) => out.push(text),
      writeErr: (text: string) => err.push(text)
    },
    out: () => out.join(""),
    err: () => err.join("")
  };
}
describe("cli run()", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cachelens-cli-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  function writeTrace(name: string, calls: readonly LlmCall[]): string {
    const path = join(dir, name);
    writeFileSync(path, calls.map((c) => JSON.stringify(c)).join("\n"), "utf8");
    return path;
  }
  const healthyCalls = [
    makeCall({
      id: "1",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "x", messages: [] },
      timestamp: 0
    }),
    makeCall({
      id: "2",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "x", messages: [] },
      timestamp: 10000,
      usage: { cacheReadInputTokens: tokenCount(900), inputTokens: tokenCount(100) }
    })
  ];
  const missCalls = [
    makeCall({
      id: "call-1",
      sessionId: "s1",
      stepName: "step",
      wireBody: { tools: [], system: "ts=1000", messages: [] },
      timestamp: 0,
      // The earlier call wrote its prefix: only tokens a hit could have reused count as waste.
      usage: { cacheCreationInputTokens: tokenCount(500000) }
    }),
    makeCall({
      id: "call-2",
      sessionId: "s1",
      stepName: "step",
      wireBody: { tools: [], system: "ts=2000", messages: [] },
      timestamp: 1000,
      usage: { cacheCreationInputTokens: tokenCount(500000) }
    })
  ];
  it("help/no-args prints usage and exits 0", async () => {
    const { io, out } = createIo();
    const code = await run([], io);
    expect(code).toBe(0);
    expect(out()).toContain("Usage");
  });
  it("unknown command exits 2 with a stderr message", async () => {
    const { io, err } = createIo();
    const code = await run(["bogus"], io);
    expect(code).toBe(2);
    expect(err()).toContain("Unknown command");
  });
  it("report without a file argument exits 2 (usage error)", async () => {
    const { io, err } = createIo();
    const code = await run(["report"], io);
    expect(code).toBe(2);
    expect(err()).toContain("Usage");
  });
  it("report on a valid trace prints text and exits 0", async () => {
    const path = writeTrace("t.jsonl", healthyCalls);
    const { io, out } = createIo();
    const code = await run(["report", path], io);
    expect(code).toBe(0);
    expect(out()).toContain("Total cost:");
  });
  it("report --json prints valid JSON matching the documented schema", async () => {
    const path = writeTrace("t.jsonl", healthyCalls);
    const { io, out } = createIo();
    const code = await run(["report", path, "--json"], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed).toHaveProperty("totalUsd");
    expect(parsed).toHaveProperty("hitRate");
    expect(parsed).toHaveProperty("byStep");
  });
  it("report --html writes a self-contained HTML artifact to the given path", async () => {
    const path = writeTrace("t.jsonl", healthyCalls);
    const outPath = join(dir, "report.html");
    const { io, out } = createIo();
    const code = await run(["report", path, "--html", outPath], io);
    expect(code).toBe(0);
    expect(out()).toContain(outPath);
    const html = readFileSync(outPath, "utf8");
    expect(html).toContain("<!doctype html>");
  });
  it("diagnose exits 0 with no findings on a healthy trace", async () => {
    const path = writeTrace("t.jsonl", healthyCalls);
    const { io } = createIo();
    const code = await run(["diagnose", path], io);
    expect(code).toBe(0);
  });
  it("diagnose exits 1 when a cause is diagnosed", async () => {
    const path = writeTrace("t.jsonl", missCalls);
    const { io, out } = createIo();
    const code = await run(["diagnose", path], io);
    expect(code).toBe(1);
    expect(out()).toContain("dynamic-prefix-content");
  });
  it("diagnose --json exits 1 on findings and includes the findings array", async () => {
    const path = writeTrace("t.jsonl", missCalls);
    const { io, out } = createIo();
    const code = await run(["diagnose", path, "--json"], io);
    expect(code).toBe(1);
    const parsed = JSON.parse(out());
    expect(parsed.findingCount).toBe(1);
  });
  it("check passes (exit 0) when thresholds are not violated", async () => {
    const path = writeTrace("t.jsonl", healthyCalls);
    const { io, out } = createIo();
    const code = await run(["check", path, "--max-wasted-usd", "10", "--min-hit-rate", "10"], io);
    expect(code).toBe(0);
    expect(out()).toContain("PASS");
  });
  it("check fails (exit 1) when max-wasted-usd is violated", async () => {
    const path = writeTrace("t.jsonl", missCalls);
    const { io, out } = createIo();
    const code = await run(["check", path, "--max-wasted-usd", "0.0001"], io);
    expect(code).toBe(1);
    expect(out()).toContain("FAIL");
  });
  it("check --json fails (exit 1) and reports violations with a stable schema", async () => {
    const path = writeTrace("t.jsonl", missCalls);
    const { io, out } = createIo();
    const code = await run(["check", path, "--max-wasted-usd", "0.0001", "--json"], io);
    expect(code).toBe(1);
    const parsed = JSON.parse(out());
    expect(parsed.passed).toBe(false);
    expect(parsed.violations[0].kind).toBe("max-wasted-usd");
  });
  it("check treats --min-hit-rate as a percentage (0-100)", async () => {
    const path = writeTrace("t.jsonl", healthyCalls);
    const { io, out } = createIo();
    const code = await run(["check", path, "--min-hit-rate", "95"], io);
    expect(code).toBe(1);
    expect(out()).toContain("min-hit-rate");
  });
  it("a malformed trace file is reported as an I/O/usage error (exit 2)", async () => {
    const path = join(dir, "bad.jsonl");
    writeFileSync(path, "not json\n", "utf8");
    const { io, err } = createIo();
    const code = await run(["report", path], io);
    expect(code).toBe(2);
    expect(err().length).toBeGreaterThan(0);
  });
  describe("missing trace file (exit 2, not a silently-empty trace)", () => {
    it("report", async () => {
      const path = join(dir, "does-not-exist.jsonl");
      const { io, err, out } = createIo();
      const code = await run(["report", path], io);
      expect(code).toBe(2);
      expect(err()).toContain("not found");
      expect(err()).toContain(path);
      expect(out()).toBe("");
    });
    it("diagnose", async () => {
      const path = join(dir, "does-not-exist.jsonl");
      const { io, err } = createIo();
      const code = await run(["diagnose", path], io);
      expect(code).toBe(2);
      expect(err()).toContain("not found");
      expect(err()).toContain(path);
    });
    it("check", async () => {
      const path = join(dir, "does-not-exist.jsonl");
      const { io, err } = createIo();
      const code = await run(["check", path, "--max-wasted-usd", "0"], io);
      expect(code).toBe(2);
      expect(err()).toContain("not found");
      expect(err()).toContain(path);
    });
  });
  describe("proxy", () => {
    it("without an output-file argument exits 2 (usage error)", async () => {
      const { io, err } = createIo();
      const code = await run(["proxy"], io);
      expect(code).toBe(2);
      expect(err()).toContain("Usage");
    });
    it("starts, captures a forwarded call to the output JSONL, and stops cleanly on abort", async () => {
      const upstream = await startFakeUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            model: "claude-opus-4-8",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0
            }
          })
        );
      });
      const outPath = join(dir, "captured.jsonl");
      const controller = new AbortController();
      const { io, out } = createIo();
      const runPromise = run(
        ["proxy", outPath, "--port", "0", "--upstream", upstream.url],
        io,
        controller.signal
      );
      let port: number | undefined;
      for (let i = 0; i < 50 && port === undefined; i++) {
        const match = out().match(/localhost:(\d+)/);
        if (match?.[1]) {
          port = Number(match[1]);
        } else {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      expect(port).toBeDefined();
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-8", messages: [] })
      });
      expect(response.status).toBe(200);
      for (let i = 0; i < 50 && !existsSync(outPath); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(existsSync(outPath)).toBe(true);
      controller.abort();
      const code = await runPromise;
      await upstream.close();
      expect(code).toBe(0);
      const captured = readFileSync(outPath, "utf8").trim();
      expect(captured.length).toBeGreaterThan(0);
      const call = JSON.parse(captured.split("\n")[0] ?? "{}") as LlmCall;
      expect(call.usage.inputTokens).toBe(10);
    });
  });
});
