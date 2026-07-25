import type { LlmCall } from "../model/call.js";
import type { CorroborationAdapter } from "./corroboration.js";
import type { EngineResult } from "./engine.js";
import type { Diagnosis } from "./taxonomy.js";
export async function enrichDiagnosis(
  call: LlmCall,
  diagnosis: Diagnosis,
  adapter: CorroborationAdapter
): Promise<Diagnosis> {
  const corroboration = await adapter.corroborate(call, diagnosis.cause);
  if (corroboration === undefined) {
    return diagnosis;
  }
  return { ...diagnosis, corroboration };
}
export async function enrichEngineResult(
  call: LlmCall,
  result: EngineResult,
  adapter: CorroborationAdapter
): Promise<EngineResult> {
  if (result.kind !== "diagnosis") {
    return result;
  }
  return { kind: "diagnosis", diagnosis: await enrichDiagnosis(call, result.diagnosis, adapter) };
}
