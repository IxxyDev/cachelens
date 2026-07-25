import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { costDistributionByStep } from "../core/aggregate/distribution.js";
import { aggregateHitRate } from "../core/aggregate/hitrate.js";
import { type EngineResult, diagnoseCall } from "../core/diagnose/engine.js";
import type { LlmCall } from "../core/model/call.js";
import { readJsonlFile } from "../store/jsonl.js";
const NAIVE_TRACE = fileURLToPath(
  new URL("../../fixtures/demo-agent/naive.jsonl", import.meta.url)
);
const FIXED_TRACE = fileURLToPath(
  new URL("../../fixtures/demo-agent/fixed.jsonl", import.meta.url)
);
interface DiagnosedCall {
  readonly call: LlmCall;
  readonly result: EngineResult;
}
function diagnoseTrace(calls: readonly LlmCall[]): DiagnosedCall[] {
  const bySession = new Map<string, LlmCall[]>();
  for (const call of calls) {
    const existing = bySession.get(call.sessionId);
    if (existing) {
      existing.push(call);
    } else {
      bySession.set(call.sessionId, [call]);
    }
  }
  const results: DiagnosedCall[] = [];
  for (const sessionCalls of bySession.values()) {
    let previous: LlmCall | undefined;
    for (const current of sessionCalls) {
      results.push({ call: current, result: diagnoseCall(previous, current) });
      previous = current;
    }
  }
  return results;
}
describe("golden demo-agent e2e gate", () => {
  it("fixture files exist and are non-empty", async () => {
    const naive = await readJsonlFile(NAIVE_TRACE);
    const fixed = await readJsonlFile(FIXED_TRACE);
    expect(naive.length).toBeGreaterThan(0);
    expect(fixed.length).toBeGreaterThan(0);
    expect(naive.length).toBe(fixed.length);
  });
  it("naive: every non-cold-start turn is diagnosed as dynamic-prefix-content with an exact byteOffset+structuralPath", async () => {
    const calls = await readJsonlFile(NAIVE_TRACE);
    const diagnosed = diagnoseTrace(calls);
    const nonColdStart = diagnosed.filter((d) => d.result.kind !== "cold-start");
    expect(nonColdStart.length).toBeGreaterThan(0);
    for (const { call, result } of nonColdStart) {
      expect(result.kind, `expected a diagnosis for ${call.id}, got ${result.kind}`).toBe(
        "diagnosis"
      );
      if (result.kind !== "diagnosis") continue;
      expect(result.diagnosis.cause).toBe("dynamic-prefix-content");
      expect(result.diagnosis.structuralPath).toBe("system[0].text");
      expect(result.diagnosis.invalidatedTiers).toEqual(["system"]);
      expect(result.diagnosis.byteOffset).toBeGreaterThan(0);
      expect(result.diagnosis.wastedUsd).toBeGreaterThan(0);
    }
  });
  it("fixed: no call is ever diagnosed with a cache-miss cause — false-miss gate", async () => {
    const calls = await readJsonlFile(FIXED_TRACE);
    const diagnosed = diagnoseTrace(calls);
    for (const { call, result } of diagnosed) {
      expect(result.kind, `unexpected miss for ${call.id}: ${JSON.stringify(result)}`).not.toBe(
        "diagnosis"
      );
      expect(result.kind).not.toBe("unclassified-miss");
      expect(["cold-start", "healthy-extension"]).toContain(result.kind);
    }
    expect(diagnosed.some((d) => d.result.kind === "healthy-extension")).toBe(true);
  });
  it("shows a real dollar delta and hit-rate improvement between naive and fixed", async () => {
    const naive = await readJsonlFile(NAIVE_TRACE);
    const fixed = await readJsonlFile(FIXED_TRACE);
    const naiveCost = costDistributionByStep(naive).reduce((sum, entry) => sum + entry.totalUsd, 0);
    const fixedCost = costDistributionByStep(fixed).reduce((sum, entry) => sum + entry.totalUsd, 0);
    expect(naiveCost).toBeGreaterThan(fixedCost);
    const naiveHitRate = aggregateHitRate(naive);
    const fixedHitRate = aggregateHitRate(fixed);
    expect(fixedHitRate).toBeGreaterThan(naiveHitRate);
  });
});
