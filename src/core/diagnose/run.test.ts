import { describe, expect, it } from "vitest";
import type { LlmCall, RequestParams, Usage } from "../model/call.js";
import { tokenCount } from "../model/types.js";
import { findAllDiagnoses } from "./run.js";
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
describe("findAllDiagnoses", () => {
  it("returns no findings for an empty trace", () => {
    expect(findAllDiagnoses([])).toEqual([]);
  });
  it("returns no findings when every pair is healthy", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const calls = [
      makeCall({ id: "1", sessionId: "s", stepName: "step", wireBody, timestamp: 0 }),
      makeCall({
        id: "2",
        sessionId: "s",
        stepName: "step",
        wireBody,
        timestamp: 10000,
        usage: { cacheReadInputTokens: tokenCount(100) }
      })
    ];
    expect(findAllDiagnoses(calls)).toEqual([]);
  });
  it("finds a dynamic-prefix-content diagnosis, tagged with sessionId and the call", () => {
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
        usage: { cacheCreationInputTokens: tokenCount(50) }
      })
    ];
    const findings = findAllDiagnoses(calls);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.sessionId).toBe("s1");
    expect(findings[0]?.call.id).toBe("call-2");
    expect(findings[0]?.diagnosis.cause).toBe("dynamic-prefix-content");
  });
  it("groups sessions independently, pairing only within the same session", () => {
    const wireBodyA = { tools: [], system: "a", messages: [] };
    const wireBodyB = { tools: [], system: "b", messages: [] };
    const calls = [
      makeCall({ id: "a1", sessionId: "sa", stepName: "step", wireBody: wireBodyA, timestamp: 0 }),
      makeCall({ id: "b1", sessionId: "sb", stepName: "step", wireBody: wireBodyB, timestamp: 0 })
    ];
    expect(findAllDiagnoses(calls)).toEqual([]);
  });
});
