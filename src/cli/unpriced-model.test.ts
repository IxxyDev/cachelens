import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmCall } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { run } from "./index.js";

function makeCall(
  id: string,
  sessionId: string,
  model: string,
  timestamp: number,
  system: string,
  cacheCreationTokens: number
): LlmCall {
  return {
    id,
    sessionId,
    stepName: "step",
    timestamp,
    params: { model },
    payload: { wireBody: JSON.stringify({ tools: [], system, messages: [] }) },
    usage: {
      inputTokens: tokenCount(1000000),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(cacheCreationTokens),
      cacheReadInputTokens: tokenCount(0)
    }
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
const WARNING = 'no pricing for model "claude-unknown-9"';
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
/**
 * A dynamic-system-prompt miss on `model` (the first call wrote its prefix, the second re-wrote
 * it after a timestamp change), plus a priced call in its own session: 1M input on
 * claude-sonnet-4-5 = $3.
 */
function missTrace(model: string): LlmCall[] {
  return [
    makeCall("1", "s1", model, 0, "ts=1000", 500000),
    makeCall("2", "s1", model, 1000, "ts=2000", 500000),
    makeCall("3", "s2", "claude-sonnet-4-5", 2000, "stable", 0)
  ];
}
describe("cli run() on a trace with an unpriced model", () => {
  let dir: string;
  let tracePath: string;
  let pricedTracePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cachelens-unpriced-"));
    tracePath = join(dir, "trace.jsonl");
    pricedTracePath = join(dir, "priced.jsonl");
    const write = (path: string, calls: LlmCall[]) =>
      writeFileSync(path, calls.map((c) => JSON.stringify(c)).join("\n"), "utf8");
    write(tracePath, missTrace("claude-unknown-9"));
    write(pricedTracePath, missTrace("claude-sonnet-4-5"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it("report exits 0, prices only the known call, and warns once on stderr", async () => {
    const { io, out, err } = createIo();
    expect(await run(["report", tracePath], io)).toBe(0);
    expect(out()).toContain("Total cost:        $3.0000");
    expect(countOccurrences(err(), WARNING)).toBe(1);
    expect(err()).toContain(`pricing warning: ${WARNING}`);
  });
  it("report --json carries the warning in a top-level warnings array", async () => {
    const { io, out, err } = createIo();
    expect(await run(["report", tracePath, "--json"], io)).toBe(0);
    const json = JSON.parse(out());
    expect(json.totalUsd).toBeCloseTo(3, 10);
    expect(json.warnings).toEqual([expect.stringContaining(WARNING)]);
    expect(countOccurrences(err(), WARNING)).toBe(1);
  });
  it("diagnose still finds the unpriced miss (exit 1) and prints its wasted $ as n/a", async () => {
    const { io, out, err } = createIo();
    expect(await run(["diagnose", tracePath], io)).toBe(1);
    expect(out()).toContain("dynamic-prefix-content");
    expect(out()).toContain("~$n/a, model unpriced");
    expect(countOccurrences(err(), WARNING)).toBe(1);
  });
  it("diagnose --json reports the finding with null dollar fields and the warning", async () => {
    const { io, out } = createIo();
    expect(await run(["diagnose", tracePath, "--json"], io)).toBe(1);
    const json = JSON.parse(out());
    expect(json.findingCount).toBe(1);
    expect(json.findings[0].wastedTokens).toBe(500000);
    expect(json.findings[0].wastedUsd).toBeNull();
    expect(json.findings[0].wastedUsdByTier).toBeNull();
    expect(json.warnings).toEqual([expect.stringContaining(WARNING)]);
  });
  it("check --max-wasted-usd 0 fails (exit 1): unpriced wasted tokens cannot be shown to stay under the cap", async () => {
    const { io, err } = createIo();
    expect(await run(["check", tracePath, "--max-wasted-usd", "0"], io)).toBe(1);
    expect(countOccurrences(err(), WARNING)).toBe(1);
  });
  it("check --json with no thresholds passes and appends the warning without a violation", async () => {
    const { io, out } = createIo();
    expect(await run(["check", tracePath, "--json"], io)).toBe(0);
    const json = JSON.parse(out());
    expect(json.passed).toBe(true);
    expect(json.violations).toEqual([]);
    expect(json.warnings).toEqual([expect.stringContaining(WARNING)]);
  });
  it("check --json --max-wasted-usd reports an unpriced-waste violation, not a $0 pass", async () => {
    const { io, out } = createIo();
    expect(await run(["check", tracePath, "--max-wasted-usd", "10", "--json"], io)).toBe(1);
    const json = JSON.parse(out());
    expect(json.violations.map((v: { kind: string }) => v.kind)).toEqual(["unpriced-waste"]);
  });
  it("every command exits with the same code as the same trace on a priced model", async () => {
    const commands = [
      ["report"],
      ["diagnose"],
      ["diagnose", "--json"],
      ["check", "--max-wasted-usd", "0"],
      ["check", "--json"]
    ];
    for (const [command, ...flags] of commands) {
      const unpriced = await run([command as string, tracePath, ...flags], createIo().io);
      const priced = await run([command as string, pricedTracePath, ...flags], createIo().io);
      expect({ command, flags, exit: unpriced }).toEqual({ command, flags, exit: priced });
    }
  });
});
