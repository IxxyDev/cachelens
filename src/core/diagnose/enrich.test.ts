import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import { tokenCount } from "../model/types.js";
import { byteOffset, usd } from "../model/types.js";
import type { CorroborationAdapter } from "./corroboration.js";
import type { EngineResult } from "./engine.js";
import { enrichDiagnosis, enrichEngineResult } from "./enrich.js";
import type { Diagnosis } from "./taxonomy.js";
function makeCall(): LlmCall {
  return {
    id: "call-1",
    sessionId: "s",
    stepName: "step",
    timestamp: 0,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: "{}" },
    usage: {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(0),
      cacheReadInputTokens: tokenCount(0)
    }
  };
}
function makeDiagnosis(): Diagnosis {
  return {
    cause: "dynamic-prefix-content",
    invalidatedTiers: ["system"],
    byteOffset: byteOffset(0),
    structuralPath: "system[0].text",
    excerpt: "…",
    wastedTokens: tokenCount(10),
    wastedUsd: usd(0.01),
    wastedUsdByTier: new Map([["system", usd(0.01)]]),
    recommendation: "move it"
  };
}
describe("enrichDiagnosis", () => {
  it("attaches corroboration when the adapter returns one", async () => {
    const adapter: CorroborationAdapter = {
      async corroborate() {
        return { status: "confirmed", note: "vendor agrees" };
      }
    };
    const enriched = await enrichDiagnosis(makeCall(), makeDiagnosis(), adapter);
    expect(enriched.corroboration).toEqual({ status: "confirmed", note: "vendor agrees" });
  });
  it("passes the call and diagnosis cause to the adapter", async () => {
    let seenCallId: string | undefined;
    let seenCause: string | undefined;
    const adapter: CorroborationAdapter = {
      async corroborate(call, cause) {
        seenCallId = call.id;
        seenCause = cause;
        return undefined;
      }
    };
    await enrichDiagnosis(makeCall(), makeDiagnosis(), adapter);
    expect(seenCallId).toBe("call-1");
    expect(seenCause).toBe("dynamic-prefix-content");
  });
  it("leaves the diagnosis unchanged when the adapter returns undefined", async () => {
    const adapter: CorroborationAdapter = {
      async corroborate() {
        return undefined;
      }
    };
    const original = makeDiagnosis();
    const enriched = await enrichDiagnosis(makeCall(), original, adapter);
    expect(enriched).toEqual(original);
    expect("corroboration" in enriched).toBe(false);
  });
});
describe("enrichEngineResult", () => {
  it("enriches a diagnosis result", async () => {
    const adapter: CorroborationAdapter = {
      async corroborate() {
        return { status: "contradicted" };
      }
    };
    const result: EngineResult = { kind: "diagnosis", diagnosis: makeDiagnosis() };
    const enriched = await enrichEngineResult(makeCall(), result, adapter);
    expect(enriched.kind).toBe("diagnosis");
    expect(enriched.kind === "diagnosis" && enriched.diagnosis.corroboration).toEqual({
      status: "contradicted"
    });
  });
  it("passes through non-diagnosis results untouched, never calling the adapter", async () => {
    let called = false;
    const adapter: CorroborationAdapter = {
      async corroborate() {
        called = true;
        return { status: "confirmed" };
      }
    };
    const result: EngineResult = { kind: "healthy-extension" };
    const enriched = await enrichEngineResult(makeCall(), result, adapter);
    expect(enriched).toEqual({ kind: "healthy-extension" });
    expect(called).toBe(false);
  });
});
