import { describe, expect, it } from "vitest";
import type { LlmCall, RequestParams, Usage } from "../model/call.js";
import { tokenCount } from "../model/types.js";
import { diagnosisWarnings, findAllDiagnoses, runDiagnosis } from "./run.js";

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
  it("pairs calls in request order: a reversed two-call trace diagnoses the later call against the earlier", () => {
    const system = [
      { type: "text", text: "stable system prompt", cache_control: { type: "ephemeral" } }
    ];
    const first = { role: "user", content: "q1" };
    const earlier = makeCall({
      id: "turn-1",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system, messages: [first] },
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(1200) }
    });
    const later = makeCall({
      id: "turn-2",
      sessionId: "s",
      stepName: "step",
      wireBody: {
        tools: [],
        system,
        messages: [first, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }]
      },
      timestamp: 30000,
      usage: { cacheReadInputTokens: tokenCount(1200), cacheCreationInputTokens: tokenCount(150) }
    });
    expect(findAllDiagnoses([later, earlier])).toEqual([]);
  });
  it("reports a real miss on the later call even when the file lists it first", () => {
    const earlier = makeCall({
      id: "call-1",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "ts=1000", messages: [] },
      timestamp: 0
    });
    const later = makeCall({
      id: "call-2",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "ts=2000", messages: [] },
      timestamp: 1000,
      usage: { cacheCreationInputTokens: tokenCount(50) }
    });
    const findings = findAllDiagnoses([later, earlier]);
    expect(findings.map((f) => [f.call.id, f.diagnosis.cause])).toEqual([
      ["call-2", "dynamic-prefix-content"]
    ]);
  });
  it("orders calls with equal timestamps by id", () => {
    const wireBody = { tools: [], system: "x", messages: [] };
    const a = makeCall({ id: "a", sessionId: "s", stepName: "step", wireBody, timestamp: 0 });
    const b = makeCall({
      id: "b",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "y", messages: [] },
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(50) }
    });
    const findings = findAllDiagnoses([b, a]);
    expect(findings.map((f) => f.call.id)).toEqual(["b"]);
  });
  it("diffs each step against its own previous call when two steps interleave", () => {
    const stepBody = (name: string, turn: number) => ({
      tools: [],
      system: [
        { type: "text", text: `${name} system prompt`, cache_control: { type: "ephemeral" } }
      ],
      messages: Array.from({ length: turn }, (_, i) => ({ role: "user", content: `${name} ${i}` }))
    });
    const calls = [
      makeCall({
        id: "plan-1",
        sessionId: "s",
        stepName: "plan",
        wireBody: stepBody("plan", 1),
        timestamp: 0,
        usage: { cacheCreationInputTokens: tokenCount(1100) }
      }),
      makeCall({
        id: "summarize-1",
        sessionId: "s",
        stepName: "summarize",
        wireBody: stepBody("summarize", 1),
        timestamp: 1000,
        usage: { cacheCreationInputTokens: tokenCount(1100) }
      }),
      makeCall({
        id: "plan-2",
        sessionId: "s",
        stepName: "plan",
        wireBody: stepBody("plan", 2),
        timestamp: 2000,
        usage: { cacheReadInputTokens: tokenCount(1100), cacheCreationInputTokens: tokenCount(20) }
      }),
      makeCall({
        id: "summarize-2",
        sessionId: "s",
        stepName: "summarize",
        wireBody: stepBody("summarize", 2),
        timestamp: 3000,
        usage: { cacheReadInputTokens: tokenCount(1100), cacheCreationInputTokens: tokenCount(20) }
      })
    ];
    expect(findAllDiagnoses(calls)).toEqual([]);
  });
  it("diagnoses a model switch inside a step against that step's previous call", () => {
    const wireBody = { tools: [{ name: "search" }], system: "stable prompt", messages: [] };
    const calls = [
      makeCall({
        id: "1",
        sessionId: "s",
        stepName: "step",
        wireBody,
        timestamp: 0,
        usage: { cacheReadInputTokens: tokenCount(300) }
      }),
      makeCall({
        id: "2",
        sessionId: "s",
        stepName: "step",
        wireBody,
        timestamp: 10000,
        requestParams: { model: "claude-opus-4-5" },
        usage: { cacheCreationInputTokens: tokenCount(300) }
      })
    ];
    const findings = findAllDiagnoses(calls);
    expect(findings.map((f) => [f.call.id, f.diagnosis.cause])).toEqual([
      ["2", "request-param-invalidation"]
    ]);
  });
  it("skips a call whose wire body is not JSON without throwing, still diagnosing the others", () => {
    const first = makeCall({
      id: "1",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "ts=1000", messages: [] },
      timestamp: 0
    });
    const broken: LlmCall = {
      ...makeCall({
        id: "2",
        sessionId: "s",
        stepName: "step",
        wireBody: {},
        timestamp: 1000,
        usage: { cacheCreationInputTokens: tokenCount(50) }
      }),
      payload: { wireBody: "{not json" }
    };
    const third = makeCall({
      id: "3",
      sessionId: "s",
      stepName: "step",
      wireBody: { tools: [], system: "ts=3000", messages: [] },
      timestamp: 2000,
      usage: { cacheCreationInputTokens: tokenCount(50) }
    });
    const findings = findAllDiagnoses([first, broken, third]);
    expect(findings.map((f) => [f.call.id, f.diagnosis.cause])).toEqual([
      ["3", "dynamic-prefix-content"]
    ]);
  });
  it("treats a step that runs on a different model as a cold start, not a model change", () => {
    const wireBody = { tools: [{ name: "search" }], system: "stable prompt", messages: [] };
    const calls = [
      makeCall({
        id: "plan-1",
        sessionId: "s",
        stepName: "plan",
        wireBody,
        timestamp: 0,
        usage: { cacheCreationInputTokens: tokenCount(300) }
      }),
      makeCall({
        id: "classify-1",
        sessionId: "s",
        stepName: "classify",
        wireBody,
        timestamp: 10000,
        requestParams: { model: "claude-haiku-4-5" },
        usage: { cacheCreationInputTokens: tokenCount(300) }
      })
    ];
    expect(findAllDiagnoses(calls)).toEqual([]);
  });
});

describe("runDiagnosis", () => {
  // Call "2" is a long-prefix miss no rule explains (unclassified); call "3" has a body that is
  // not JSON; calls "a"/"b" are a dynamic-prefix miss (a finding).
  const longPrefix = {
    tools: [],
    system: [{ type: "text", text: "S".repeat(4200), cache_control: { type: "ephemeral" } }],
    messages: []
  };
  const calls: LlmCall[] = [
    makeCall({
      id: "1",
      sessionId: "s1",
      stepName: "step",
      wireBody: longPrefix,
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(1050) }
    }),
    makeCall({ id: "2", sessionId: "s1", stepName: "step", wireBody: longPrefix, timestamp: 5000 }),
    {
      ...makeCall({ id: "3", sessionId: "s3", stepName: "x", wireBody: {}, timestamp: 0 }),
      payload: { wireBody: "not json" }
    },
    makeCall({
      id: "a",
      sessionId: "s2",
      stepName: "step",
      wireBody: { tools: [], system: "ts=1000", messages: [] },
      timestamp: 0,
      usage: { cacheCreationInputTokens: tokenCount(500000) }
    }),
    makeCall({
      id: "b",
      sessionId: "s2",
      stepName: "step",
      wireBody: { tools: [], system: "ts=2000", messages: [] },
      timestamp: 1000,
      usage: { cacheCreationInputTokens: tokenCount(500000) }
    })
  ];

  it("returns the findings and the warnings of one pass", () => {
    const result = runDiagnosis(calls);
    expect(result.findings.map((f) => f.call.id)).toEqual(["b"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/^call "3" .*not a JSON object/);
    expect(result.warnings[1]).toMatch(/^call "2" .*could not be classified \(signature-2/);
  });
  it("agrees with findAllDiagnoses and diagnosisWarnings", () => {
    const result = runDiagnosis(calls);
    expect(findAllDiagnoses(calls)).toEqual(result.findings);
    expect(diagnosisWarnings(calls)).toEqual(result.warnings);
  });
  it("still forwards unclassified misses to a caller's onUnclassifiedMiss", () => {
    const reported: string[] = [];
    runDiagnosis(calls, { onUnclassifiedMiss: (call) => reported.push(call.id) });
    expect(reported).toEqual(["2"]);
  });
});
