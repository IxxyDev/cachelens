import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../cli/index.js";
import { diagnosisWarnings, findAllDiagnoses } from "../core/diagnose/run.js";
import { readJsonlFile } from "../store/jsonl.js";

/**
 * A react loop whose only breakpoint sits on a ~245-byte tools+system prefix, far below
 * claude-sonnet-5-5's 512-token minimum: the API silently ignores it, so every turn reads and
 * writes 0 cache tokens while the conversation grows.
 */
const NEVER_CACHED_TRACE = fileURLToPath(
  new URL("../../fixtures/demo-agent/never-cached.jsonl", import.meta.url)
);
function createIo() {
  const out: string[] = [];
  return {
    io: { writeOut: (text: string) => out.push(text), writeErr: () => {} },
    out: () => out.join("")
  };
}
describe("never-cached e2e: a loop that never activated caching", () => {
  it("diagnoses at least one estimated prefix-too-short finding", async () => {
    const { calls, warnings } = await readJsonlFile(NEVER_CACHED_TRACE);
    expect(warnings).toEqual([]);
    expect(calls.length).toBeGreaterThan(1);
    const findings = findAllDiagnoses(calls);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    for (const { diagnosis } of findings) {
      expect(diagnosis.cause).toBe("prefix-too-short");
      expect(diagnosis.wastedEstimate).toBe(true);
      expect(diagnosis.recommendation).toContain("estimated from bytes");
    }
    expect(diagnosisWarnings(calls)).toEqual([]);
  });
  it("cachelens diagnose exits 1", async () => {
    const { io, out } = createIo();
    expect(await run(["diagnose", NEVER_CACHED_TRACE], io)).toBe(1);
    expect(out()).toContain("prefix-too-short");
  });
});
