import { describe, expect, it } from "vitest";
import * as lib from "./index.js";

describe("library entry", () => {
  it.each([
    "findAllDiagnoses",
    "runDiagnosis",
    "diagnosisWarnings",
    "diagnoseCall",
    "evaluateCheck",
    "computeCallCost",
    "computeWastedUsd",
    "getModelPricing",
    "tryGetModelPricing",
    "readJsonlFile",
    "writeJsonlFile",
    "buildCanonicalRequest",
    "locateBreakpoints",
    "redactWireBody",
    "enrichDiagnosis",
    "enrichEngineResult",
    "createAnthropicCorroborationAdapter",
    "cachingCountTokensAdapter",
    "createAnthropicCountTokensAdapter",
    "wrapAnthropic",
    "wrapOpenAi",
    "createCaptureFetch",
    "JsonlTraceStore",
    "MemoryTraceStore"
  ])("exports %s as a function", (name) => {
    expect(typeof (lib as Record<string, unknown>)[name]).toBe("function");
  });

  it("exports the pricing constants, adapters and placeholder pattern", () => {
    expect(lib.PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lib.PRICED_MODEL_IDS.length).toBeGreaterThan(0);
    expect(lib.REDACTION_PLACEHOLDER_RE).toBeInstanceOf(RegExp);
    expect(typeof lib.offlineCountTokensAdapter.countTokens).toBe("function");
    expect(typeof lib.noCorroborationAdapter.corroborate).toBe("function");
  });

  it("MemoryTraceStore round-trips through the TraceStore interface", async () => {
    const store: lib.TraceStore = new lib.MemoryTraceStore();
    expect(await store.list()).toEqual([]);
  });
});
