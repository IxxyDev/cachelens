import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import { byteOffset, tokenCount, usd } from "../model/types.js";
import { noCorroborationAdapter } from "./corroboration.js";
import { enrichDiagnosis, enrichEngineResult } from "./enrich.js";
import type { Diagnosis } from "./taxonomy.js";

const call: LlmCall = {
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
const diagnosis: Diagnosis = {
  cause: "dynamic-prefix-content",
  invalidatedTiers: ["system"],
  byteOffset: byteOffset(4),
  structuralPath: "system[0].text",
  excerpt: "now=…",
  wastedTokens: tokenCount(10),
  wastedUsd: usd(0.01),
  wastedUsdByTier: new Map([["system", usd(0.01)]]),
  recommendation: "move it"
};

describe("noCorroborationAdapter in the enrichment pipeline", () => {
  it("leaves a diagnosis untouched, with no corroboration field at all", async () => {
    const enriched = await enrichDiagnosis(call, diagnosis, noCorroborationAdapter);
    expect(enriched).toBe(diagnosis);
    expect("corroboration" in enriched).toBe(false);
  });

  it("passes a diagnosed engine result through unchanged", async () => {
    const result = await enrichEngineResult(
      call,
      { kind: "diagnosis", diagnosis },
      noCorroborationAdapter
    );
    expect(result).toEqual({ kind: "diagnosis", diagnosis });
    expect(result.kind === "diagnosis" && "corroboration" in result.diagnosis).toBe(false);
  });
});
