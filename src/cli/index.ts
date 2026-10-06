#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_UPSTREAM_BASE_URL, startProxy } from "../capture/proxy/start-proxy.js";
import { type CheckBaseline, createBaseline, parseBaseline } from "../core/check/baseline.js";
import type { CheckThresholds } from "../core/check/evaluate.js";
import { unparseableRequestWarnings } from "../core/diagnose/engine.js";
import { type DiagnosisRun, runDiagnosis } from "../core/diagnose/run.js";
import type { LlmCall } from "../core/model/call.js";
import { PRICING_AS_OF, unpricedModelWarnings } from "../core/pricing/table.js";
import { JsonlTraceStore, type ReadJsonlResult, readJsonlFile } from "../store/jsonl.js";
import { checkTrace, renderCheck, renderCheckJson } from "./check.js";
import { diagnoseTrace, renderDiagnose, renderDiagnoseJson } from "./diagnose.js";
import { type CommandName, type ParsedFlags, parseFlags } from "./flags.js";
import { renderReport, renderReportHtml, renderReportJson, summarizeReport } from "./report.js";

const EXIT_OK = 0;
const EXIT_FINDINGS_OR_VIOLATION = 1;
const EXIT_ERROR = 2;
export interface CliIo {
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  /** Diagnosis pass, injectable for tests; default `runDiagnosis`. Called at most once per run. */
  readonly diagnose?: (calls: readonly LlmCall[]) => DiagnosisRun;
}
const defaultIo: CliIo = {
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text)
};
function printHelp(io: CliIo): void {
  io.writeOut(
    [
      "cachelens - token-economics profiler for LLM agent pipelines",
      "",
      "Usage:",
      "  cachelens <command> [args]",
      "",
      "Commands:",
      "  report <trace.jsonl>... [--json | --html <out.html>]",
      "                          Print cost-by-step and cache hit rate; --html adds",
      "                          findings, a per-session timeline and warnings",
      "  diagnose <trace.jsonl>... [--json]",
      "                          Print compiler-style cache-miss root-cause findings.",
      "                          Offsets are canonical offsets: byte positions in the",
      "                          canonical serialization (tools, system, messages; sorted",
      "                          structural keys; cache_control markers stripped), not in",
      "                          the raw request body.",
      "  check <trace.jsonl>... [--max-wasted-usd <n>] [--min-hit-rate <pct>] [--json]",
      "        [--baseline <file> [--max-hit-rate-drop <pts>] [--max-wasted-increase-usd <n>]]",
      "        [--write-baseline <file>]",
      "                          CI gate: exits nonzero when a threshold is violated.",
      "                          --write-baseline saves this trace's metrics as JSON.",
      "                          --baseline fails on a hit-rate drop (percentage points)",
      "                          or a rise in wasted USD per 1k calls beyond the given",
      "                          tolerance; both default to 0 (no regression allowed).",
      "  proxy <out.jsonl> [--port <n>] [--host <addr>] [--upstream <url>] [--session <id>] [--raw]",
      "                          Zero-code-change HTTP reverse proxy to one upstream API;",
      "                          captures every request/response pair to <out.jsonl>.",
      "                          Binds 127.0.0.1 unless --host is given. Requests without",
      "                          an x-cachelens-session header share one session id",
      "                          (--session, default: random per run). Ctrl+C to stop.",
      "  help                    Show this message",
      "",
      "report, diagnose and check read every trace file given and analyse them as one",
      "trace. Options a command does not list are rejected.",
      "",
      "Exit codes: 0 ok, 1 findings/threshold violation, 2 usage/I/O error.",
      ""
    ].join("\n")
  );
}
interface LoadedTrace {
  readonly calls: LlmCall[];
  /** Trace-reader warnings (skipped lines), one per line, each naming its file. */
  readonly readerWarnings: string[];
  /** Reader, pricing and request warnings, deduplicated, in that order. */
  readonly warnings: string[];
}
async function readTraceFile(traceFile: string, io: CliIo): Promise<ReadJsonlResult> {
  try {
    await access(traceFile);
  } catch {
    throw new Error(`Trace file not found: ${traceFile}`);
  }
  const trace = await readJsonlFile(traceFile);
  for (const warning of trace.warnings) {
    io.writeErr(`warning: ${warning}\n`);
  }
  if (trace.calls.length === 0 && trace.warnings.length > 0) {
    throw new Error(`No valid calls in trace: ${traceFile}`);
  }
  return trace;
}
/**
 * Reads every trace file and concatenates the calls (sessions are grouped by id later, so a
 * session split across files is still one session). Prints one stderr line per reader, pricing
 * and request warning (unparseable bodies, misses no rule could classify); warnings never
 * affect the exit code by themselves.
 */
async function loadTraces(traceFiles: readonly string[], io: CliIo): Promise<LoadedTrace> {
  const calls: LlmCall[] = [];
  const readerWarnings: string[] = [];
  for (const traceFile of traceFiles) {
    const trace = await readTraceFile(traceFile, io);
    calls.push(...trace.calls);
    readerWarnings.push(...trace.warnings);
  }
  const pricingWarnings = unpricedModelWarnings(calls.map((call) => call.params.model));
  for (const warning of pricingWarnings) {
    io.writeErr(`pricing warning: ${warning}\n`);
  }
  const warnings = [...new Set([...readerWarnings, ...pricingWarnings])];
  return { calls, readerWarnings: [...new Set(readerWarnings)], warnings };
}
/** Prints request warnings to stderr and returns `warnings` extended with them, deduplicated. */
function addRequestWarnings(
  warnings: readonly string[],
  requestWarnings: readonly string[],
  io: CliIo
): string[] {
  for (const warning of requestWarnings) {
    io.writeErr(`request warning: ${warning}\n`);
  }
  return [...new Set([...warnings, ...requestWarnings])];
}
/**
 * The one diagnosis pass of a command: findings plus the request warnings it produced
 * (unparseable bodies, misses no rule could classify), printed to stderr.
 */
function diagnoseOnce(
  calls: readonly LlmCall[],
  warnings: readonly string[],
  io: CliIo
): { readonly findings: DiagnosisRun["findings"]; readonly warnings: string[] } {
  const pass = (io.diagnose ?? runDiagnosis)(calls);
  return { findings: pass.findings, warnings: addRequestWarnings(warnings, pass.warnings, io) };
}
const USAGE: Readonly<Record<CommandName, string>> = {
  report: "Usage: cachelens report <trace.jsonl>... [--json | --html <out.html>]",
  diagnose: "Usage: cachelens diagnose <trace.jsonl>... [--json]",
  check:
    "Usage: cachelens check <trace.jsonl>... [--max-wasted-usd <n>] [--min-hit-rate <pct>] [--json] [--baseline <file> [--max-hit-rate-drop <pts>] [--max-wasted-increase-usd <n>]] [--write-baseline <file>]",
  proxy:
    "Usage: cachelens proxy <out.jsonl> [--port <n>] [--host <addr>] [--upstream <url>] [--session <id>] [--raw]"
};
/** Parses flags for `command` and checks the positional count; writes the error on failure. */
function parseCommand(command: CommandName, args: readonly string[], io: CliIo) {
  const parsed = parseFlags(command, args);
  if (!parsed.ok) {
    io.writeErr(`${parsed.error}\n`);
    return undefined;
  }
  const count = parsed.flags.positional.length;
  if (count === 0 || (command === "proxy" && count > 1)) {
    io.writeErr(`${USAGE[command]}\n`);
    return undefined;
  }
  return parsed.flags;
}
/** Report and baseline files are owner-only: the HTML report embeds excerpts of prompt text. */
const OUTPUT_FILE_MODE = 0o600;
async function writeOwnerOnlyFile(path: string, text: string): Promise<void> {
  await writeFile(path, text, { encoding: "utf8", mode: OUTPUT_FILE_MODE });
  // `mode` only applies when the file is created; tighten an existing file too.
  await chmod(path, OUTPUT_FILE_MODE);
}
async function runReport(flags: ParsedFlags, io: CliIo): Promise<number> {
  const loaded = await loadTraces(flags.positional, io);
  const { calls } = loaded;
  if (flags.html !== undefined) {
    // Diagnosed only for the HTML findings table; text and JSON reports never diagnose.
    const { findings, warnings } = diagnoseOnce(calls, loaded.warnings, io);
    const summary = summarizeReport(calls, warnings);
    await writeOwnerOnlyFile(flags.html, renderReportHtml(summary, findings));
    io.writeOut(`Wrote HTML report to ${flags.html}\n`);
    return EXIT_OK;
  }
  // Unparseable bodies need no diagnosis; unclassified misses are only known after one.
  const warnings = addRequestWarnings(loaded.warnings, unparseableRequestWarnings(calls), io);
  const summary = summarizeReport(calls, warnings);
  if (flags.json) {
    io.writeOut(`${JSON.stringify(renderReportJson(summary), null, 2)}\n`);
    return EXIT_OK;
  }
  io.writeOut(renderReport(summary));
  return EXIT_OK;
}
async function runDiagnose(flags: ParsedFlags, io: CliIo): Promise<number> {
  const loaded = await loadTraces(flags.positional, io);
  const { findings, warnings } = diagnoseOnce(loaded.calls, loaded.warnings, io);
  const result = diagnoseTrace(loaded.calls, warnings, findings);
  if (flags.json) {
    io.writeOut(`${JSON.stringify(renderDiagnoseJson(result), null, 2)}\n`);
  } else {
    io.writeOut(renderDiagnose(result));
  }
  return result.findings.length > 0 ? EXIT_FINDINGS_OR_VIOLATION : EXIT_OK;
}
/** Reads and validates a `--write-baseline` artifact; every failure names the file (exit 2). */
async function loadBaseline(path: string): Promise<CheckBaseline> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Baseline file not found or unreadable: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid baseline file ${path}: not valid JSON`);
  }
  const baseline = parseBaseline(parsed);
  if ("error" in baseline) {
    throw new Error(`Invalid baseline file ${path}: ${baseline.error}`);
  }
  return baseline;
}
async function runCheck(flags: ParsedFlags, io: CliIo): Promise<number> {
  // Load the baseline before the trace so a bad baseline path fails fast with exit 2.
  const baseline = flags.baseline !== undefined ? await loadBaseline(flags.baseline) : undefined;
  const loaded = await loadTraces(flags.positional, io);
  const { calls, readerWarnings } = loaded;
  const { findings, warnings } = diagnoseOnce(calls, loaded.warnings, io);
  if (baseline !== undefined && baseline.pricingAsOf !== PRICING_AS_OF) {
    const warning = `baseline ${flags.baseline} was priced as of ${baseline.pricingAsOf}, current pricing is as of ${PRICING_AS_OF}; dollar deltas may reflect price changes`;
    io.writeErr(`baseline warning: ${warning}\n`);
    warnings.push(warning);
  }
  const thresholds: CheckThresholds = {
    ...(flags.maxWastedUsd !== undefined ? { maxWastedUsd: flags.maxWastedUsd } : {}),
    ...(flags.minHitRatePercent !== undefined ? { minHitRate: flags.minHitRatePercent / 100 } : {}),
    ...(baseline !== undefined
      ? {
          baseline: {
            baseline,
            maxHitRateDropPoints: flags.maxHitRateDropPoints ?? 0,
            maxWastedIncreaseUsdPer1k: flags.maxWastedIncreaseUsd ?? 0
          }
        }
      : {})
  };
  // Only skipped trace lines fail the gate; pricing/request warnings are informational.
  const result = checkTrace(calls, thresholds, readerWarnings, findings);
  if (flags.writeBaseline !== undefined) {
    const artifact = createBaseline(result);
    const values = [artifact.hitRate, artifact.totalUsd, artifact.wastedUsd];
    if (!values.every(Number.isFinite)) {
      throw new Error(
        `Refusing to write baseline ${flags.writeBaseline}: the trace's metrics are not finite numbers`
      );
    }
    await writeOwnerOnlyFile(flags.writeBaseline, `${JSON.stringify(artifact, null, 2)}\n`);
    io.writeErr(`Wrote baseline to ${flags.writeBaseline}\n`);
  }
  if (flags.json) {
    io.writeOut(`${JSON.stringify(renderCheckJson(result, warnings), null, 2)}\n`);
  } else {
    io.writeOut(renderCheck(result));
  }
  return result.passed ? EXIT_OK : EXIT_FINDINGS_OR_VIOLATION;
}
async function runProxy(
  flags: ParsedFlags,
  io: CliIo,
  signal: AbortSignal | undefined
): Promise<number> {
  const [outFile] = flags.positional;
  if (outFile === undefined) {
    io.writeErr(`${USAGE.proxy}\n`);
    return EXIT_ERROR;
  }
  const onWarning = (message: string): void => io.writeErr(`cachelens proxy warning: ${message}\n`);
  const store = new JsonlTraceStore(outFile, { onWarning });
  const proxy = await startProxy({
    store,
    ...(flags.port !== undefined ? { port: flags.port } : {}),
    ...(flags.host !== undefined ? { host: flags.host } : {}),
    ...(flags.session !== undefined ? { sessionId: flags.session } : {}),
    ...(flags.upstream !== undefined ? { upstreamBaseUrl: flags.upstream } : {}),
    raw: flags.raw,
    onCaptureError: (error) =>
      io.writeErr(
        `cachelens proxy capture error: ${error instanceof Error ? error.message : String(error)}\n`
      ),
    onWarning
  });
  io.writeOut(
    [
      `cachelens proxy listening on ${proxy.url}`,
      `  forwarding to ${flags.upstream ?? DEFAULT_UPSTREAM_BASE_URL}`,
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
      case "diagnose":
      case "check":
      case "proxy": {
        const flags = parseCommand(command, args, io);
        if (flags === undefined) return EXIT_ERROR;
        if (command === "report") return await runReport(flags, io);
        if (command === "diagnose") return await runDiagnose(flags, io);
        if (command === "check") return await runCheck(flags, io);
        return await runProxy(flags, io, signal);
      }
      default:
        io.writeErr(`Unknown command: ${command}\n`);
        return EXIT_ERROR;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.writeErr(`${message}\n`);
    // A --json caller parses stdout: give it a machine-readable error instead of nothing.
    if (command !== "proxy" && args.includes("--json")) {
      io.writeOut(`${JSON.stringify({ error: message, exitCode: EXIT_ERROR }, null, 2)}\n`);
    }
    return EXIT_ERROR;
  }
}
/**
 * npm installs `bin` entries as symlinks, so argv[1] is the link while import.meta.url is the
 * resolved file; compare real paths or the CLI silently does nothing when installed.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  let resolved = entry;
  try {
    resolved = realpathSync(entry);
  } catch {
    // Fall back to the raw path (e.g. the entry was removed after start).
  }
  return resolved === fileURLToPath(import.meta.url);
}
// Process bootstrap: only runs when this file is the executed bin, i.e. in a child process that
// in-process coverage cannot see. Exercised by src/e2e/cli.test.ts and src/cli/bin-entry.test.ts.
/* v8 ignore next 9 -- @preserve */
if (isMainModule()) {
  const shutdownController = new AbortController();
  const requestShutdown = () => shutdownController.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  run(process.argv.slice(2), defaultIo, shutdownController.signal).then((code) => {
    process.exitCode = code;
  });
}
