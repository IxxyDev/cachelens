import { describe, expect, it } from "vitest";
import type { LlmCall, RequestParams, Usage } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { renderCheck, renderCheckJson } from "./check.js";
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
    const text = renderCheck(missCalls, {});
    expect(text).toContain("PASS");
    expect(text).toContain("findings: 1");
  });
  it("reports FAIL and lists each violation when a threshold is violated", () => {
    const text = renderCheck(missCalls, { maxWastedUsd: 0.0001 });
    expect(text).toContain("FAIL");
    expect(text).toContain("max-wasted-usd");
  });
});
describe("renderCheckJson", () => {
  it("returns a JSON-safe, stable-schema result", () => {
    const result = renderCheckJson(missCalls, { maxWastedUsd: 0.0001, minHitRate: 0.9 });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(() => JSON.stringify(result)).not.toThrow();
  });
  it("passes with an empty trace and no thresholds", () => {
    const result = renderCheckJson([], {});
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
