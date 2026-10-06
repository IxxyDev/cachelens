import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import { tokenCount } from "../model/types.js";
import { PRICING_AS_OF } from "../pricing/table.js";
import {
  BASELINE_VERSION,
  type CheckBaseline,
  computeDeltas,
  createBaseline,
  parseBaseline,
  wastedUsdPer1kCalls
} from "./baseline.js";
import { evaluateCheck } from "./evaluate.js";

function makeCall(id: string, usage: { read?: number; input?: number; create?: number }): LlmCall {
  return {
    id,
    sessionId: "s1",
    stepName: "step",
    timestamp: 0,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: JSON.stringify({ tools: [], system: "stable", messages: [] }) },
    usage: {
      inputTokens: tokenCount(usage.input ?? 0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(usage.create ?? 0),
      cacheReadInputTokens: tokenCount(usage.read ?? 0)
    }
  };
}

function baselineWith(overrides: Partial<CheckBaseline> = {}): CheckBaseline {
  return {
    version: BASELINE_VERSION,
    generatedAt: "2026-10-01T00:00:00.000Z",
    pricingAsOf: PRICING_AS_OF,
    calls: 10,
    hitRate: 0.8,
    totalUsd: 1,
    wastedUsd: 0.01,
    wastedUsdPer1kCalls: 1,
    ...overrides
  };
}

describe("wastedUsdPer1kCalls", () => {
  it("normalises wasted dollars per 1,000 calls", () => {
    expect(wastedUsdPer1kCalls(0.5, 500)).toBeCloseTo(1, 12);
  });
  it("is 0 for an empty trace instead of NaN", () => {
    expect(wastedUsdPer1kCalls(0, 0)).toBe(0);
  });
});

describe("createBaseline", () => {
  it("records version, pricing date, ISO timestamp and the result's metrics", () => {
    const result = evaluateCheck([makeCall("1", { read: 75, input: 25 })], {});
    const baseline = createBaseline(result, new Date("2026-10-06T12:00:00.000Z"));
    expect(baseline).toEqual({
      version: 1,
      generatedAt: "2026-10-06T12:00:00.000Z",
      pricingAsOf: PRICING_AS_OF,
      calls: 1,
      hitRate: 0.75,
      totalUsd: result.totalCostUsd,
      wastedUsd: 0,
      wastedUsdPer1kCalls: 0
    });
  });
});

describe("computeDeltas", () => {
  it("reports the hit-rate delta in percentage points and the waste delta per 1k calls", () => {
    const deltas = computeDeltas(
      baselineWith({ hitRate: 0.5, wastedUsdPer1kCalls: 3 }),
      baselineWith({ hitRate: 0.8, wastedUsdPer1kCalls: 1 })
    );
    expect(deltas.hitRatePoints).toBeCloseTo(-30, 10);
    expect(deltas.wastedUsdPer1kCalls).toBeCloseTo(2, 10);
  });
});

describe("parseBaseline", () => {
  it("accepts a written baseline after a JSON round trip", () => {
    const baseline = baselineWith();
    expect(parseBaseline(JSON.parse(JSON.stringify(baseline)))).toEqual(baseline);
  });
  it.each([
    ["an array", [], "not a JSON object"],
    ["null", null, "not a JSON object"],
    ["a wrong version", { ...baselineWith(), version: 2 }, "unsupported version 2"],
    ["a missing version", { ...baselineWith(), version: undefined }, "unsupported version"],
    ["a missing generatedAt", { ...baselineWith(), generatedAt: undefined }, '"generatedAt"'],
    [
      "a missing wastedUsdPer1kCalls",
      { ...baselineWith(), wastedUsdPer1kCalls: undefined },
      '"wastedUsdPer1kCalls"'
    ],
    ["a string hitRate", { ...baselineWith(), hitRate: "0.8" }, '"hitRate"'],
    ["a negative calls", { ...baselineWith(), calls: -1 }, '"calls"'],
    ["a percent hitRate", { ...baselineWith(), hitRate: 80 }, "ratio between 0 and 1"]
  ])("rejects %s", (_label, value, reason) => {
    const parsed = parseBaseline(value);
    expect(parsed).toEqual({ error: expect.stringContaining(reason) });
  });
});

describe("evaluateCheck with a baseline gate", () => {
  const healthy = [makeCall("1", { read: 80, input: 20 }), makeCall("2", { read: 80, input: 20 })];

  it("passes against a baseline built from the same calls", () => {
    const baseline = createBaseline(evaluateCheck(healthy, {}));
    const result = evaluateCheck(healthy, {
      baseline: { baseline, maxHitRateDropPoints: 0, maxWastedIncreaseUsdPer1k: 0 }
    });
    expect(result.passed).toBe(true);
    expect(result.baselineComparison?.deltas.hitRatePoints).toBeCloseTo(0, 12);
  });

  it("fails with hit-rate-drop when the drop exceeds the allowed points", () => {
    const result = evaluateCheck(healthy, {
      baseline: {
        baseline: baselineWith({ hitRate: 0.9, wastedUsdPer1kCalls: 0 }),
        maxHitRateDropPoints: 5,
        maxWastedIncreaseUsdPer1k: 0
      }
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ kind: "hit-rate-drop", threshold: 5 })
    ]);
    expect(result.violations[0]?.actual).toBeCloseTo(10, 10);
  });

  it("passes a drop within the allowed points", () => {
    const result = evaluateCheck(healthy, {
      baseline: {
        baseline: baselineWith({ hitRate: 0.9, wastedUsdPer1kCalls: 0 }),
        maxHitRateDropPoints: 10.5,
        maxWastedIncreaseUsdPer1k: 0
      }
    });
    expect(result.passed).toBe(true);
  });

  it("does not fail an improvement over the baseline", () => {
    const result = evaluateCheck(healthy, {
      baseline: {
        baseline: baselineWith({ hitRate: 0.1, wastedUsdPer1kCalls: 50 }),
        maxHitRateDropPoints: 0,
        maxWastedIncreaseUsdPer1k: 0
      }
    });
    expect(result.passed).toBe(true);
    expect(result.baselineComparison?.deltas.wastedUsdPer1kCalls).toBeCloseTo(-50, 10);
  });

  it("fails an empty trace with no-calls instead of a meaningless delta", () => {
    const result = evaluateCheck([], {
      baseline: { baseline: baselineWith(), maxHitRateDropPoints: 0, maxWastedIncreaseUsdPer1k: 0 }
    });
    expect(result.violations.map((v) => v.kind)).toEqual(["no-calls"]);
  });
});
