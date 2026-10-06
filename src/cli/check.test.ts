import { describe, expect, it } from "vitest";
import type { LlmCall, RequestParams, Usage } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { checkTrace, renderCheck, renderCheckJson } from "./check.js";

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
const missCalls = [
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
describe("renderCheck", () => {
  it("reports PASS with a summary line when no thresholds are violated", () => {
    const text = renderCheck(checkTrace(missCalls, {}));
    expect(text).toContain("PASS");
    expect(text).toContain("findings: 1");
  });
  it("reports FAIL and lists each violation when a threshold is violated", () => {
    const text = renderCheck(checkTrace(missCalls, { maxWastedUsd: 0.0001 }));
    expect(text).toContain("FAIL");
    expect(text).toContain("max-wasted-usd");
  });
});
describe("renderCheckJson", () => {
  it("returns a JSON-safe, stable-schema result", () => {
    const result = renderCheckJson(
      checkTrace(missCalls, { maxWastedUsd: 0.0001, minHitRate: 0.9 })
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(() => JSON.stringify(result)).not.toThrow();
  });
  it("passes with an empty trace and no thresholds", () => {
    const result = renderCheckJson(checkTrace([], {}));
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
describe("check rendering with reader warnings and broken metrics", () => {
  it("fails with an invalid-records violation and lists warnings in JSON", () => {
    const warnings = ["t.jsonl:3: skipped invalid record (usage.cacheReadInputTokens ...)"];
    const result = renderCheckJson(checkTrace(missCalls, {}, warnings), warnings);
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(["invalid-records"]);
    expect(result.warnings).toEqual(warnings);
    expect(renderCheck(checkTrace(missCalls, {}, warnings))).toContain(
      "[invalid-records] 1 trace line was skipped"
    );
  });
  it("includes an empty warnings array when the trace was clean", () => {
    expect(renderCheckJson(checkTrace(missCalls, {})).warnings).toEqual([]);
  });
  it("renders n/a instead of NaN for non-finite metrics", () => {
    const corrupt = { ...missCalls[0], usage: { inputTokens: 1 } } as unknown as LlmCall;
    const text = renderCheck(checkTrace([corrupt], { minHitRate: 0.9, maxWastedUsd: 0 }));
    expect(text).toContain("FAIL");
    expect(text).toContain("non-finite-metric");
    expect(text).not.toContain("NaN");
  });
  it("reports the empty-trace min-hit-rate case as no-calls, not 0.0% below min", () => {
    const text = renderCheck(checkTrace([], { minHitRate: 0.9 }));
    expect(text).toContain("FAIL");
    expect(text).toContain("[no-calls] no calls in trace");
    expect(text).not.toContain("below min");
  });
});
