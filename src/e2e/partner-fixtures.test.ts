import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findAllDiagnoses } from "../core/diagnose/run.js";
import { readJsonlFile } from "../store/jsonl.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/demo-agent/${name}.jsonl`, import.meta.url));
}

describe("cache-partner selection on demo-agent fixtures", () => {
  it("interleaved: two alternating steps with healthy caching produce no findings", async () => {
    const { calls, warnings } = await readJsonlFile(fixture("interleaved"));
    expect(warnings).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(new Set(calls.map((c) => c.stepName))).toEqual(new Set(["plan", "summarize"]));
    const findings = findAllDiagnoses(calls);
    expect(findings.filter((f) => f.diagnosis.cause === "dynamic-prefix-content")).toEqual([]);
    expect(findings).toEqual([]);
  });

  it("out-of-order: a healthy session written in completion order produces no findings", async () => {
    const { calls, warnings } = await readJsonlFile(fixture("out-of-order"));
    expect(warnings).toEqual([]);
    const timestamps = calls.map((c) => c.timestamp);
    expect(timestamps).not.toEqual([...timestamps].sort((a, b) => a - b));
    expect(findAllDiagnoses(calls)).toEqual([]);
  });

  it("naive: every non-first turn is still a dynamic-prefix-content finding", async () => {
    const { calls } = await readJsonlFile(fixture("naive"));
    const findings = findAllDiagnoses(calls);
    expect(findings).toHaveLength(15);
    expect(findings.every((f) => f.diagnosis.cause === "dynamic-prefix-content")).toBe(true);
  });

  it("fixed: no findings", async () => {
    const { calls } = await readJsonlFile(fixture("fixed"));
    expect(findAllDiagnoses(calls)).toEqual([]);
  });

  it("interleaved-expired: each step's expired prefix is ttl-expiry, never dynamic-prefix-content", async () => {
    const { calls, warnings } = await readJsonlFile(fixture("interleaved-expired"));
    expect(warnings).toEqual([]);
    const findings = findAllDiagnoses(calls);
    expect(findings.filter((f) => f.diagnosis.cause === "dynamic-prefix-content")).toEqual([]);
    expect(findings.map((f) => f.diagnosis.cause)).toEqual(Array(10).fill("ttl-expiry"));
    const firstTurns = calls.filter((c) => c.id.endsWith("-1")).map((c) => c.id);
    expect(findings.map((f) => f.call.id)).not.toContain(firstTurns[0]);
    expect(findings.map((f) => f.call.id)).not.toContain(firstTurns[1]);
  });
});
