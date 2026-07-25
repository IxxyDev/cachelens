#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_UPSTREAM_BASE_URL, startProxy } from "../capture/proxy/start-proxy.js";
import { evaluateCheck } from "../core/check/evaluate.js";
import type { LlmCall } from "../core/model/call.js";
import { JsonlTraceStore, readJsonlFile } from "../store/jsonl.js";
import { renderCheck, renderCheckJson } from "./check.js";
import { renderDiagnose, renderDiagnoseJson } from "./diagnose.js";
import { renderReport, renderReportHtml, renderReportJson } from "./report.js";
const EXIT_OK = 0;
const EXIT_FINDINGS_OR_VIOLATION = 1;
const EXIT_ERROR = 2;
export interface CliIo {
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
}
const defaultIo: CliIo = {
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text)
};
interface ParsedFlags {
  readonly positional: string[];
  readonly json: boolean;
  readonly html?: string;
  readonly maxWastedUsd?: number;
  readonly minHitRatePercent?: number;
  readonly port?: number;
  readonly upstream?: string;
  readonly raw: boolean;
}
type ParseResult =
  | {
      readonly ok: true;
      readonly flags: ParsedFlags;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };
interface NumberFlagConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}
function parseNumberFlag(
  name: string,
  value: string | undefined,
  constraints: NumberFlagConstraints = {}
):
  | number
  | {
      error: string;
    } {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) {
    return { error: `${name} requires a numeric argument` };
  }
  if (constraints.integer === true && !Number.isInteger(parsed)) {
    return { error: `${name} requires an integer argument` };
  }
  if (constraints.min !== undefined && constraints.max !== undefined) {
    if (parsed < constraints.min || parsed > constraints.max) {
      return { error: `${name} must be between ${constraints.min} and ${constraints.max}` };
    }
  } else if (constraints.min !== undefined && parsed < constraints.min) {
    return { error: `${name} must be at least ${constraints.min}` };
  }
  return parsed;
}
function parseFlags(args: readonly string[]): ParseResult {
  const positional: string[] = [];
  let json = false;
  let raw = false;
  let html: string | undefined;
  let maxWastedUsd: number | undefined;
  let minHitRatePercent: number | undefined;
  let port: number | undefined;
  let upstream: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--raw":
        raw = true;
        break;
      case "--html": {
        const value = args[++i];
        if (value === undefined) {
          return { ok: false, error: "--html requires a path argument" };
        }
        html = value;
        break;
      }
      case "--upstream": {
        const value = args[++i];
        if (value === undefined) {
          return { ok: false, error: "--upstream requires a URL argument" };
        }
        upstream = value;
        break;
      }
      case "--max-wasted-usd": {
        const result = parseNumberFlag("--max-wasted-usd", args[++i], { min: 0 });
        if (typeof result === "object") {
          return { ok: false, error: result.error };
        }
        maxWastedUsd = result;
        break;
      }
      case "--min-hit-rate": {
        const result = parseNumberFlag("--min-hit-rate", args[++i], { min: 0, max: 100 });
        if (typeof result === "object") {
          return { ok: false, error: result.error };
        }
        minHitRatePercent = result;
        break;
      }
      case "--port": {
        const result = parseNumberFlag("--port", args[++i], { min: 0, max: 65535, integer: true });
        if (typeof result === "object") {
          return { ok: false, error: result.error };
        }
        port = result;
        break;
      }
      default:
        if (arg?.startsWith("--")) {
          return { ok: false, error: `Unknown flag: ${arg}` };
        }
        if (arg !== undefined) {
          positional.push(arg);
        }
    }
  }
  return {
    ok: true,
    flags: {
      positional,
      json,
      raw,
      ...(html !== undefined ? { html } : {}),
      ...(maxWastedUsd !== undefined ? { maxWastedUsd } : {}),
      ...(minHitRatePercent !== undefined ? { minHitRatePercent } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(upstream !== undefined ? { upstream } : {})
    }
  };
}
function printHelp(io: CliIo): void {
  io.writeOut(
    [
      "cachelens - token-economics profiler for LLM agent pipelines",
      "",
      "Usage:",
      "  cachelens <command> [args]",
      "",
      "Commands:",
      "  report <trace.jsonl> [--json] [--html <out.html>]",
      "                          Print cost-by-step and cache hit rate",
      "  diagnose <trace.jsonl> [--json]",
      "                          Print compiler-style cache-miss root-cause findings",
      "  check <trace.jsonl> [--max-wasted-usd <n>] [--min-hit-rate <pct>] [--json]",
      "                          CI gate: exits nonzero when a threshold is violated",
      "  proxy <out.jsonl> [--port <n>] [--upstream <url>] [--raw]",
      "                          Zero-code-change HTTPS forward proxy; captures every",
      "                          request/response pair to <out.jsonl>. Ctrl+C to stop.",
      "  help                    Show this message",
      "",
      "Exit codes: 0 ok, 1 findings/threshold violation, 2 usage/I/O error.",
      ""
    ].join("\n")
  );
}
async function readTraceOrThrow(traceFile: string): Promise<LlmCall[]> {
  try {
    await access(traceFile);
  } catch {
    throw new Error(`Trace file not found: ${traceFile}`);
  }
  return readJsonlFile(traceFile);
}
async function runReport(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseFlags(args);
  if (!parsed.ok) {
    io.writeErr(`${parsed.error}\n`);
    return EXIT_ERROR;
  }
  const [traceFile] = parsed.flags.positional;
  if (!traceFile) {
    io.writeErr("Usage: cachelens report <trace.jsonl> [--json] [--html <out.html>]\n");
    return EXIT_ERROR;
  }
  const calls = await readTraceOrThrow(traceFile);
  if (parsed.flags.html) {
    await writeFile(parsed.flags.html, renderReportHtml(calls), "utf8");
    io.writeOut(`Wrote HTML report to ${parsed.flags.html}\n`);
    return EXIT_OK;
  }
  if (parsed.flags.json) {
    io.writeOut(`${JSON.stringify(renderReportJson(calls), null, 2)}\n`);
    return EXIT_OK;
  }
  io.writeOut(renderReport(calls));
  return EXIT_OK;
}
async function runDiagnose(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseFlags(args);
  if (!parsed.ok) {
    io.writeErr(`${parsed.error}\n`);
    return EXIT_ERROR;
  }
  const [traceFile] = parsed.flags.positional;
  if (!traceFile) {
    io.writeErr("Usage: cachelens diagnose <trace.jsonl> [--json]\n");
    return EXIT_ERROR;
  }
  const calls = await readTraceOrThrow(traceFile);
  const jsonResult = renderDiagnoseJson(calls);
  if (parsed.flags.json) {
    io.writeOut(`${JSON.stringify(jsonResult, null, 2)}\n`);
  } else {
    io.writeOut(renderDiagnose(calls));
  }
  return jsonResult.findingCount > 0 ? EXIT_FINDINGS_OR_VIOLATION : EXIT_OK;
}
async function runCheck(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseFlags(args);
  if (!parsed.ok) {
    io.writeErr(`${parsed.error}\n`);
    return EXIT_ERROR;
  }
  const [traceFile] = parsed.flags.positional;
  if (!traceFile) {
    io.writeErr(
      "Usage: cachelens check <trace.jsonl> [--max-wasted-usd <n>] [--min-hit-rate <pct>] [--json]\n"
    );
    return EXIT_ERROR;
  }
  const calls = await readTraceOrThrow(traceFile);
  const thresholds = {
    ...(parsed.flags.maxWastedUsd !== undefined ? { maxWastedUsd: parsed.flags.maxWastedUsd } : {}),
    ...(parsed.flags.minHitRatePercent !== undefined
      ? { minHitRate: parsed.flags.minHitRatePercent / 100 }
      : {})
  };
  const result = evaluateCheck(calls, thresholds);
  if (parsed.flags.json) {
    io.writeOut(`${JSON.stringify(renderCheckJson(calls, thresholds), null, 2)}\n`);
  } else {
    io.writeOut(renderCheck(calls, thresholds));
  }
  return result.passed ? EXIT_OK : EXIT_FINDINGS_OR_VIOLATION;
}
async function runProxy(
  args: readonly string[],
  io: CliIo,
  signal: AbortSignal | undefined
): Promise<number> {
  const parsed = parseFlags(args);
  if (!parsed.ok) {
    io.writeErr(`${parsed.error}\n`);
    return EXIT_ERROR;
  }
  const [outFile] = parsed.flags.positional;
  if (!outFile) {
    io.writeErr("Usage: cachelens proxy <out.jsonl> [--port <n>] [--upstream <url>] [--raw]\n");
    return EXIT_ERROR;
  }
  const store = new JsonlTraceStore(outFile);
  const proxy = await startProxy({
    store,
    ...(parsed.flags.port !== undefined ? { port: parsed.flags.port } : {}),
    ...(parsed.flags.upstream !== undefined ? { upstreamBaseUrl: parsed.flags.upstream } : {}),
    raw: parsed.flags.raw,
    onCaptureError: (error) =>
      io.writeErr(
        `cachelens proxy capture error: ${error instanceof Error ? error.message : String(error)}\n`
      )
  });
  io.writeOut(
    [
      `cachelens proxy listening on http://localhost:${proxy.port}`,
      `  forwarding to ${parsed.flags.upstream ?? DEFAULT_UPSTREAM_BASE_URL}`,
      `  capturing to ${outFile}`,
      "  press Ctrl+C to stop",
      ""
    ].join("\n")
  );
  await new Promise<void>((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await proxy.close();
  io.writeOut("cachelens proxy stopped.\n");
  return EXIT_OK;
}
export async function run(
  argv: readonly string[],
  io: CliIo = defaultIo,
  signal?: AbortSignal
): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printHelp(io);
        return EXIT_OK;
      case "report":
        return await runReport(args, io);
      case "diagnose":
        return await runDiagnose(args, io);
      case "check":
        return await runCheck(args, io);
      case "proxy":
        return await runProxy(args, io, signal);
      default:
        io.writeErr(`Unknown command: ${command}\n`);
        return EXIT_ERROR;
    }
  } catch (error) {
    io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
}
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const shutdownController = new AbortController();
  const requestShutdown = () => shutdownController.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  run(process.argv.slice(2), defaultIo, shutdownController.signal).then((code) => {
    process.exitCode = code;
  });
}
