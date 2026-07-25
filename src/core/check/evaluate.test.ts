import { describe, expect, it } from "vitest";
import type { LlmCall, RequestParams, Usage } from "../model/call.js";
import { tokenCount } from "../model/types.js";
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
        timestamp: 0
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
        timestamp: 0
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
});
