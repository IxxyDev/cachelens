import { describe, expect, it } from "vitest";
import type { Diagnosis } from "../core/diagnose/taxonomy.js";
import type { LlmCall, RequestParams, Usage } from "../core/model/call.js";
import { byteOffset, tokenCount, usd } from "../core/model/types.js";
import { diagnoseTrace, renderDiagnose, renderDiagnoseJson } from "./diagnose.js";

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
describe("renderDiagnose", () => {
  it("reports no calls for an empty trace", () => {
    expect(renderDiagnose(diagnoseTrace([]))).toBe("No calls in this trace.\n");
  });
  it("reports no findings when every pair is healthy", () => {
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
    expect(renderDiagnose(diagnoseTrace(calls))).toBe(
      "cachelens diagnose — no cache-miss root causes found.\n"
    );
  });
  it("renders a compiler-style block for a dynamic-prefix-content finding (snapshot)", () => {
    const calls = [
      makeCall({
        id: "call-1",
        sessionId: "session-1",
        stepName: "planner",
        wireBody: {
          tools: [],
          system: [{ type: "text", text: "You are an agent. Current time: 2026-07-24T10:00:00Z." }],
          messages: []
        },
        timestamp: 0,
        usage: { cacheReadInputTokens: tokenCount(300) }
      }),
      makeCall({
        id: "call-2",
        sessionId: "session-1",
        stepName: "planner",
        wireBody: {
          tools: [],
          system: [{ type: "text", text: "You are an agent. Current time: 2026-11-01T03:30:00Z." }],
          messages: []
        },
        timestamp: 10000,
        usage: { cacheCreationInputTokens: tokenCount(300) }
      })
    ];
    expect(renderDiagnose(diagnoseTrace(calls))).toMatchSnapshot();
  });
  it("renders a per-tier wasted-$ breakdown for a multi-tier finding (tiered counterfactual)", () => {
    const wireBody = {
      tools: [{ name: "search" }],
      system: [{ type: "text", text: "a fairly long, stable system prompt for this step" }],
      messages: [{ role: "user", content: "hi" }]
    };
    const calls = [
      makeCall({
        id: "call-1",
        sessionId: "session-1",
        stepName: "planner",
        wireBody,
        timestamp: 0,
        requestParams: { model: "claude-sonnet-4-5" },
        usage: { cacheReadInputTokens: tokenCount(300) }
      }),
      makeCall({
        id: "call-2",
        sessionId: "session-1",
        stepName: "planner",
        wireBody,
        timestamp: 10000,
        requestParams: { model: "claude-opus-4-5" },
        usage: { cacheCreationInputTokens: tokenCount(300) }
      })
    ];
    const report = renderDiagnose(diagnoseTrace(calls));
    expect(report).toContain("wasted by tier");
    expect(report).toMatchSnapshot();
  });
  it("does not render a per-tier breakdown for a single-tier finding", () => {
    const previousTimestamp = "2026-07-24T10:00:00Z";
    const currentTimestamp = "2026-11-01T03:30:00Z";
    const makeSystem = (timestamp: string) => [
      { type: "text", text: `You are an agent. Current time: ${timestamp}. Be concise.` }
    ];
    const calls = [
      makeCall({
        id: "call-1",
        sessionId: "session-1",
        stepName: "planner",
        wireBody: { tools: [], system: makeSystem(previousTimestamp), messages: [] },
        timestamp: 0,
        usage: { cacheReadInputTokens: tokenCount(300) }
      }),
      makeCall({
        id: "call-2",
        sessionId: "session-1",
        stepName: "planner",
        wireBody: { tools: [], system: makeSystem(currentTimestamp), messages: [] },
        timestamp: 10000,
        usage: { cacheCreationInputTokens: tokenCount(300) }
      })
    ];
    expect(renderDiagnose(diagnoseTrace(calls))).not.toContain("wasted by tier");
  });
});
describe("renderDiagnoseJson", () => {
  it("returns an empty findings array with counts for an empty trace", () => {
    expect(renderDiagnoseJson(diagnoseTrace([]))).toEqual({
      callCount: 0,
      findingCount: 0,
      findings: [],
      warnings: []
    });
  });
  it("returns a JSON-safe finding (Map converted to a plain object) for a diagnosed miss", () => {
    const calls = [
      makeCall({
        id: "call-1",
        sessionId: "session-1",
        stepName: "planner",
        wireBody: { tools: [], system: "ts=1000", messages: [] },
        timestamp: 0
      }),
      makeCall({
        id: "call-2",
        sessionId: "session-1",
        stepName: "planner",
        wireBody: { tools: [], system: "ts=2000", messages: [] },
        timestamp: 1000,
        usage: { cacheCreationInputTokens: tokenCount(50) }
      })
    ];
    const result = renderDiagnoseJson(diagnoseTrace(calls));
    expect(result.callCount).toBe(2);
    expect(result.findingCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding?.sessionId).toBe("session-1");
    expect(finding?.callId).toBe("call-2");
    expect(finding?.cause).toBe("dynamic-prefix-content");
    expect(typeof finding?.wastedUsdByTier).toBe("object");
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
describe("renderDiagnose wording for hand-built findings", () => {
  const call = makeCall({
    id: "c1",
    sessionId: "s",
    stepName: "planner",
    wireBody: {},
    timestamp: 0
  });
  const diagnosis = (overrides: Partial<Diagnosis>): Diagnosis => ({
    cause: "dynamic-prefix-content",
    invalidatedTiers: ["system"],
    byteOffset: byteOffset(12),
    structuralPath: "system[0].text",
    excerpt: "Current time: …",
    wastedTokens: tokenCount(1),
    wastedUsd: usd(0.5),
    wastedUsdByTier: new Map(),
    recommendation: "move the timestamp out of the prefix",
    ...overrides
  });
  it("uses the singular for exactly one finding and one wasted token", () => {
    const text = renderDiagnose({
      callCount: 1,
      findings: [{ sessionId: "s", call, diagnosis: diagnosis({}) }],
      warnings: []
    });
    expect(text).toContain("cachelens diagnose — 1 finding\n");
    expect(text).toContain("  wasted: 1 token (~$0.5000)");
  });
  it("uses the plural for two findings and shows $0 for a tier missing from the breakdown", () => {
    const multiTier = diagnosis({
      invalidatedTiers: ["system", "messages"],
      wastedTokens: tokenCount(40),
      wastedUsdByTier: new Map([["system", usd(0.25)]])
    });
    const text = renderDiagnose({
      callCount: 2,
      findings: [
        { sessionId: "s", call, diagnosis: multiTier },
        { sessionId: "s", call, diagnosis: diagnosis({}) }
      ],
      warnings: []
    });
    expect(text).toContain("cachelens diagnose — 2 findings\n");
    expect(text).toContain("  wasted: 40 tokens");
    expect(text).toContain("    system     ~$0.2500");
    expect(text).toContain("    messages   ~$0.0000");
  });
});
