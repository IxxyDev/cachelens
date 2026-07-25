import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import { tokenCount } from "../model/types.js";
import { costDistributionByStep } from "./distribution.js";
function makeCall(
  id: string,
  stepName: string,
  inputTokens: number,
  outputTokens: number
): LlmCall {
  return {
    id,
    sessionId: "session-1",
    stepName,
    timestamp: 0,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: "{}" },
    usage: {
      inputTokens: tokenCount(inputTokens),
      outputTokens: tokenCount(outputTokens),
      cacheCreationInputTokens: tokenCount(0),
      cacheReadInputTokens: tokenCount(0)
    }
  };
}
describe("costDistributionByStep", () => {
  it("groups cost and call count by step name", () => {
    const calls = [
      makeCall("1", "planner", 1000000, 0),
      makeCall("2", "planner", 1000000, 0),
      makeCall("3", "executor", 0, 1000000)
    ];
    const dist = costDistributionByStep(calls);
    const planner = dist.find((d) => d.stepName === "planner");
    const executor = dist.find((d) => d.stepName === "executor");
    expect(planner?.callCount).toBe(2);
    expect(planner?.totalUsd).toBeCloseTo(3 * 2, 6);
    expect(executor?.callCount).toBe(1);
    expect(executor?.totalUsd).toBeCloseTo(15, 6);
  });
  it("sorts steps by totalUsd descending", () => {
    const calls = [makeCall("1", "cheap", 10000, 0), makeCall("2", "expensive", 5000000, 0)];
    const dist = costDistributionByStep(calls);
    expect(dist.map((d) => d.stepName)).toEqual(["expensive", "cheap"]);
  });
  it("returns an empty array for no calls", () => {
    expect(costDistributionByStep([])).toEqual([]);
  });
});
describe("costDistributionByStep (provider-aware via per-model pricing lookup)", () => {
  it("prices an openai call using its own read discount and no write premium, purely from the model name — no distribution.ts change needed", () => {
    const call: LlmCall = {
      id: "1",
      sessionId: "session-1",
      stepName: "openai-step",
      timestamp: 0,
      params: { model: "gpt-4o" },
      payload: { wireBody: "{}" },
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: tokenCount(0),
        cacheCreationInputTokens: tokenCount(0),
        cacheReadInputTokens: tokenCount(1000000)
      },
      provider: "openai"
    };
    const [entry] = costDistributionByStep([call]);
    expect(entry?.totalUsd).toBeCloseTo(2.5 * 0.5, 6);
  });
});
