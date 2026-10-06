import type { LlmCall } from "../model/call.js";
import {
  type DiagnoseOptions,
  diagnoseCall,
  unclassifiedMissWarning,
  unparseableRequestWarnings
} from "./engine.js";
import { type PartnerCache, selectPartner } from "./partner.js";
import type { Diagnosis } from "./taxonomy.js";
export interface DiagnoseFinding {
  readonly sessionId: string;
  readonly call: LlmCall;
  readonly diagnosis: Diagnosis;
}
function groupBySession(calls: readonly LlmCall[]): Map<string, LlmCall[]> {
  const bySession = new Map<string, LlmCall[]>();
  for (const call of calls) {
    const existing = bySession.get(call.sessionId);
    if (existing) {
      existing.push(call);
    } else {
      bySession.set(call.sessionId, [call]);
    }
  }
  return bySession;
}
/** Request order: records are appended on completion, so file order is not trusted. */
function byRequestOrder(a: LlmCall, b: LlmCall): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/**
 * The call `current` is diagnosed against: the earlier call the prompt cache could actually have
 * hit (see `selectPartner`). The first call of a step whose best match belongs to another step
 * only shares that step's common prefix (e.g. the tools), so its own content is a cold start.
 * When no same-model call qualifies, the step's own previous call is used, so a model switch
 * inside a step is still diagnosed; a step that simply runs on another model is a cold start.
 */
function comparisonPartner(
  current: LlmCall,
  earlier: readonly LlmCall[],
  lastCallByStep: ReadonlyMap<string, LlmCall>,
  cache: PartnerCache
): LlmCall | undefined {
  const partner = selectPartner(current, earlier, cache);
  if (!partner) return lastCallByStep.get(current.stepName);
  if (partner.stepName !== current.stepName && !lastCallByStep.has(current.stepName)) {
    return undefined;
  }
  return partner;
}
/** One diagnosis pass: the findings plus the warnings for calls it could not explain. */
export interface DiagnosisRun {
  readonly findings: DiagnoseFinding[];
  /** Unparseable request bodies, then unclassified misses, in request order. */
  readonly warnings: string[];
}
/**
 * Diagnoses every call against its cache partner in request order, not file order, and collects
 * the warnings in the same pass. Prefer this over `findAllDiagnoses` + `diagnosisWarnings` when
 * both are needed: each of those runs a full pass.
 */
export function runDiagnosis(
  calls: readonly LlmCall[],
  options: DiagnoseOptions = {}
): DiagnosisRun {
  const warnings = unparseableRequestWarnings(calls);
  const passOptions: DiagnoseOptions = {
    ...options,
    onUnclassifiedMiss: (call, signature) => {
      warnings.push(unclassifiedMissWarning(call, signature));
      options.onUnclassifiedMiss?.(call, signature);
    }
  };
  const findings: DiagnoseFinding[] = [];
  const cache: PartnerCache = new Map();
  for (const [sessionId, sessionCalls] of groupBySession(calls)) {
    const earlier: LlmCall[] = [];
    const lastCallByStep = new Map<string, LlmCall>();
    for (const current of [...sessionCalls].sort(byRequestOrder)) {
      const partner = comparisonPartner(current, earlier, lastCallByStep, cache);
      const result = diagnoseCall(partner, current, passOptions);
      if (result.kind === "diagnosis") {
        findings.push({ sessionId, call: current, diagnosis: result.diagnosis });
      }
      earlier.push(current);
      lastCallByStep.set(current.stepName, current);
    }
  }
  return { findings, warnings };
}
/** Diagnoses every call against its cache partner in request order, not file order. */
export function findAllDiagnoses(
  calls: readonly LlmCall[],
  options: DiagnoseOptions = {}
): DiagnoseFinding[] {
  return runDiagnosis(calls, options).findings;
}
/**
 * Warnings for calls diagnosis could not explain: unparseable bodies and unclassified misses.
 * Runs a full pass; use `runDiagnosis` when the findings are needed too.
 */
export function diagnosisWarnings(
  calls: readonly LlmCall[],
  options: DiagnoseOptions = {}
): string[] {
  return runDiagnosis(calls, options).warnings;
}
