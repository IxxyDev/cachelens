import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "../core/diagnose/engine.js";
import { runDiagnosis } from "../core/diagnose/run.js";
import type { LlmCall } from "../core/model/call.js";
import { type CliIo, run } from "./index.js";

// diagnoseCall lives in engine.ts and is imported by run.ts, so this mock replaces the binding
// every diagnosis pass actually calls: the per-call count catches a pass made from anywhere
// (including one hidden inside another helper), not only calls through a module export.
vi.mock("../core/diagnose/engine.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../core/diagnose/engine.js")>();
  return { ...original, diagnoseCall: vi.fn(original.diagnoseCall) };
});
const diagnoseCall = vi.mocked(engine.diagnoseCall);

/** The trace below has two calls, so one full pass makes exactly two diagnoseCall calls. */
const CALLS_PER_PASS = 2;

let passes = 0;
const io: CliIo = {
  writeOut: () => {},
  writeErr: () => {},
  diagnose: (calls: readonly LlmCall[]) => {
    passes++;
    return runDiagnosis(calls);
  }
};

describe("each command diagnoses the trace exactly once", () => {
  let dir: string;
  let trace: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cachelens-once-"));
    trace = join(dir, "t.jsonl");
    const call = (id: string, timestamp: number, system: string) =>
      JSON.stringify({
        id,
        sessionId: "s1",
        stepName: "step",
        timestamp,
        params: { model: "claude-sonnet-4-5" },
        payload: { wireBody: JSON.stringify({ tools: [], system, messages: [] }) },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 500000,
          cacheReadInputTokens: 0
        }
      });
    writeFileSync(trace, `${call("1", 0, "ts=1000")}\n${call("2", 1000, "ts=2000")}\n`, "utf8");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    passes = 0;
    diagnoseCall.mockClear();
  });
  function expectPasses(count: number): void {
    expect(passes).toBe(count);
    expect(diagnoseCall).toHaveBeenCalledTimes(count * CALLS_PER_PASS);
  }

  it.each([
    [["diagnose"], 1],
    [["diagnose", "--json"], 1],
    [["check", "--max-wasted-usd", "0"], 1],
    [["check", "--max-wasted-usd", "0", "--json"], 1]
  ])("%j", async (args, expectedExit) => {
    const [command, ...rest] = args;
    expect(await run([command as string, trace, ...rest], io)).toBe(expectedExit);
    expectPasses(1);
  });

  it("check --baseline --write-baseline still diagnoses once", async () => {
    const baseline = join(dir, "baseline.json");
    expect(await run(["check", trace, "--write-baseline", baseline], io)).toBe(0);
    expectPasses(1);
    passes = 0;
    diagnoseCall.mockClear();
    expect(await run(["check", trace, "--baseline", baseline, "--json"], io)).toBe(0);
    expectPasses(1);
  });

  it.each([[[]], [["--json"]]])("report %j does not diagnose at all", async (rest) => {
    expect(await run(["report", trace, ...rest], io)).toBe(0);
    expectPasses(0);
  });

  it("report --html diagnoses once for the findings table", async () => {
    const out = join(dir, "r.html");
    expect(await run(["report", trace, "--html", out], io)).toBe(0);
    expectPasses(1);
    expect(readFileSync(out, "utf8")).toContain("dynamic-prefix-content");
  });
});
