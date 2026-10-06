import { describe, expect, it } from "vitest";
import type { LlmCall, Usage } from "../model/call.js";
import { tokenCount } from "../model/types.js";
import { aggregateHitRate } from "./hitrate.js";

function makeCall(usage: Partial<Usage>): LlmCall {
  return {
    id: "call-1",
    sessionId: "session-1",
    stepName: "step-1",
    timestamp: 0,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: "{}" },
    usage: {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(0),
      cacheReadInputTokens: tokenCount(0),
      ...usage
    }
  };
}
describe("aggregateHitRate", () => {
  it("returns 0 for an empty call list", () => {
    expect(aggregateHitRate([])).toBe(0);
  });
  it("weights by tokens, not by call count", () => {
    const calls = [
      makeCall({ cacheReadInputTokens: tokenCount(9000) }),
      makeCall({ inputTokens: tokenCount(1000) })
    ];
    expect(aggregateHitRate(calls)).toBeCloseTo(0.9, 6);
  });
  it("matches a manual weighted-average calculation across mixed calls", () => {
    const calls = [
      makeCall({ cacheReadInputTokens: tokenCount(400), inputTokens: tokenCount(100) }),
      makeCall({ cacheCreationInputTokens: tokenCount(500) })
    ];
    expect(aggregateHitRate(calls)).toBeCloseTo(0.4, 6);
  });
});
