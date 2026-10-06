/**
 * cachelens library entry (`import { ... } from "cachelens"`). The CLI lives at
 * `dist/cli/index.js` (the `cachelens` bin) and is not re-exported here.
 *
 * Exports are kept in module-path order (biome sorts them), so they group by area: capture
 * (`capture/*`), analysis (`core/*`: breakpoints, check, diagnose, model, pricing, serialize)
 * and storage (`store/*`).
 */

export type { CaptureAdapter, CaptureFetch, CaptureOptions } from "./capture/capture-fetch.js";
export { createCaptureFetch } from "./capture/capture-fetch.js";
export type { AnthropicCorroborationAdapterOptions } from "./capture/corroboration/anthropic-corroboration-adapter.js";
export { createAnthropicCorroborationAdapter } from "./capture/corroboration/anthropic-corroboration-adapter.js";
export type { AnthropicCountTokensAdapterOptions } from "./capture/pricing/anthropic-count-tokens.js";
export { createAnthropicCountTokensAdapter } from "./capture/pricing/anthropic-count-tokens.js";
export { REDACTION_PLACEHOLDER_RE, redactRequestBody, redactWireBody } from "./capture/redact.js";
export type { WrapAnthropicOptions } from "./capture/wrap/anthropic.js";
export {
  anthropicCaptureAdapter,
  createAnthropicCaptureFetch,
  wrapAnthropic
} from "./capture/wrap/anthropic.js";
export type { WrapOpenAiOptions } from "./capture/wrap/openai.js";
export {
  createOpenAiCaptureFetch,
  openAiCaptureAdapter,
  wrapOpenAi
} from "./capture/wrap/openai.js";
export { locateBreakpoints } from "./core/breakpoints/locate.js";
export type { CheckResult, CheckThresholds, CheckViolation } from "./core/check/evaluate.js";
export { evaluateCheck } from "./core/check/evaluate.js";
export type { CorroborationAdapter } from "./core/diagnose/corroboration.js";
export { noCorroborationAdapter } from "./core/diagnose/corroboration.js";
export type { DiagnoseOptions, EngineResult } from "./core/diagnose/engine.js";
export { diagnoseCall, unparseableRequestWarnings } from "./core/diagnose/engine.js";
export { enrichDiagnosis, enrichEngineResult } from "./core/diagnose/enrich.js";
export type { DiagnoseFinding, DiagnosisRun } from "./core/diagnose/run.js";
export { diagnosisWarnings, findAllDiagnoses, runDiagnosis } from "./core/diagnose/run.js";
export type {
  Cause as CacheMissCause,
  Corroboration,
  CorroborationStatus,
  Diagnosis
} from "./core/diagnose/taxonomy.js";
export type { LlmCall, RequestParams, Usage } from "./core/model/call.js";
export type { ByteOffset, TokenCount, Usd } from "./core/model/types.js";
export { computeCallCost, computeWastedUsd } from "./core/pricing/cost.js";
export type { CountTokensAdapter } from "./core/pricing/count-tokens.js";
export {
  cachingCountTokensAdapter,
  offlineCountTokensAdapter
} from "./core/pricing/count-tokens.js";
export type { ModelPricing } from "./core/pricing/table.js";
export {
  getModelPricing,
  PRICED_MODEL_IDS,
  PRICING_AS_OF,
  tryGetModelPricing,
  UnknownModelError,
  unpricedModelWarnings
} from "./core/pricing/table.js";
export type { CanonicalRequest } from "./core/serialize/canonical-request.js";
export { buildCanonicalRequest } from "./core/serialize/canonical-request.js";
export type { JsonlTraceStoreOptions, ReadJsonlResult } from "./store/jsonl.js";
export { JsonlTraceStore, readJsonlFile, writeJsonlFile } from "./store/jsonl.js";
export { MemoryTraceStore } from "./store/memory-store.js";
export type { TraceStore } from "./store/trace-store.js";
