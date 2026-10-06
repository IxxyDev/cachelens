import { describe, expect, it } from "vitest";
import type { LlmCall, RequestParams, Usage } from "../model/call.js";
import { tokenCount } from "../model/types.js";
import { createBaseline } from "./baseline.js";
import { evaluateCheck } from "./evaluate.js";

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
describe("evaluateCheck", () => {
  it("passes with no thresholds and no calls", () => {
    const result = evaluateCheck([], {});
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.findingsCount).toBe(0);
    expect(result.hitRate).toBe(0);
  });
  it("passes when thresholds are not violated", () => {
    const calls = [
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
    const result = evaluateCheck(calls, { maxWastedUsd: 100, minHitRate: 0.1 });
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });
  it("violates max-wasted-usd when a diagnosed miss's cost exceeds the threshold", () => {
    const calls = [
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
    const result = evaluateCheck(calls, { maxWastedUsd: 0.0001 });
    expect(result.passed).toBe(false);
    expect(result.findingsCount).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe("max-wasted-usd");
    expect(result.violations[0]?.actual).toBeGreaterThan(result.violations[0]?.threshold ?? 0);
  });
  it("violates min-hit-rate when the aggregate hit rate falls below the threshold", () => {
    const calls = [
      makeCall({
        id: "1",
        sessionId: "s",
        stepName: "step",
        wireBody: { tools: [], system: "x", messages: [] },
        timestamp: 0,
        usage: { inputTokens: tokenCount(1000) }
      })
    ];
    const result = evaluateCheck(calls, { minHitRate: 0.5 });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe("min-hit-rate");
    expect(result.hitRate).toBe(0);
  });
  it("can report both violations at once, independently", () => {
    const calls = [
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
    const result = evaluateCheck(calls, { maxWastedUsd: 0.0001, minHitRate: 0.99 });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind).sort()).toEqual(["max-wasted-usd", "min-hit-rate"]);
  });
  it("emits an explicit no-calls violation for an empty trace with --min-hit-rate", () => {
    const result = evaluateCheck([], { minHitRate: 0.9 });
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      {
        kind: "no-calls",
        message: "no calls in trace; hit rate cannot be evaluated",
        actual: 0,
        threshold: 0.9
      }
    ]);
  });
  it("still passes an empty trace when only --max-wasted-usd is set", () => {
    expect(evaluateCheck([], { maxWastedUsd: 0 }).passed).toBe(true);
  });
  it("fails with non-finite-metric violations when usage data produces NaN", () => {
    const corrupt = {
      ...makeCall({
        id: "1",
        sessionId: "s",
        stepName: "step",
        wireBody: { tools: [], system: "x", messages: [] },
        timestamp: 0,
        usage: { inputTokens: tokenCount(100) }
      }),
      usage: {
        inputTokens: tokenCount(100),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(0)
      } as Usage
    };
    const result = evaluateCheck([corrupt], { minHitRate: 0.9, maxWastedUsd: 0 });
    expect(Number.isFinite(result.hitRate)).toBe(false);
    expect(result.passed).toBe(false);
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain("non-finite-metric");
    expect(kinds).not.toContain("min-hit-rate");
    for (const violation of result.violations) {
      expect(violation.message).not.toContain("NaN");
    }
  });
  it("emits a non-finite-metric violation even without thresholds", () => {
    const corrupt = {
      ...makeCall({
        id: "1",
        sessionId: "s",
        stepName: "step",
        wireBody: {},
        timestamp: 0
      }),
      usage: { inputTokens: Number.NaN } as unknown as Usage
    };
    const result = evaluateCheck([corrupt], {});
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.kind === "non-finite-metric")).toBe(true);
  });
});

describe("evaluateCheck: unpriced waste against dollar gates", () => {
  // A dynamic-prefix miss on a model without pricing: wasted tokens, no dollar figure.
  const unpricedMiss = [
    makeCall({
      id: "1",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "ts=1000", messages: [] },
      timestamp: 0,
      requestParams: { model: "claude-unknown-9" },
      usage: { cacheCreationInputTokens: tokenCount(5000) }
    }),
    makeCall({
      id: "2",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "ts=2000", messages: [] },
      timestamp: 1000,
      requestParams: { model: "claude-unknown-9" },
      usage: { cacheCreationInputTokens: tokenCount(5000) }
    })
  ];
  const baselineGate = (maxWastedIncreaseUsdPer1k: number) => ({
    baseline: createBaseline(evaluateCheck(unpricedMiss, {}), new Date(0)),
    maxHitRateDropPoints: 100,
    maxWastedIncreaseUsdPer1k
  });

  it("the trace really has unpriced waste and no priced waste", () => {
    const result = evaluateCheck(unpricedMiss, {});
    expect(result.findingsCount).toBe(1);
    expect(result.totalWastedUsd).toBe(0);
    expect(result.passed).toBe(true);
  });
  it("fails the baseline wasted-increase gate even with no --max-wasted-usd", () => {
    const result = evaluateCheck(unpricedMiss, { baseline: baselineGate(0) });
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.kind === "unpriced-waste");
    expect(violation?.message).toContain("baseline's max increase of $0.0000 per 1k calls");
    expect(violation?.actual).toBeGreaterThan(0);
    expect(violation?.threshold).toBe(0);
  });
  it("reports the absolute max when both dollar gates are active", () => {
    const result = evaluateCheck(unpricedMiss, { maxWastedUsd: 5, baseline: baselineGate(1) });
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds.filter((k) => k === "unpriced-waste")).toHaveLength(1);
    expect(result.violations.find((v) => v.kind === "unpriced-waste")?.threshold).toBe(5);
  });
  it("no dollar gate active: unpriced waste is not a violation", () => {
    expect(evaluateCheck(unpricedMiss, { minHitRate: 0 }).passed).toBe(true);
  });
  it("reuses precomputed findings instead of diagnosing again", () => {
    const result = evaluateCheck(unpricedMiss, { maxWastedUsd: 0 }, { findings: [] });
    expect(result.findingsCount).toBe(0);
    expect(result.passed).toBe(true);
  });
});
