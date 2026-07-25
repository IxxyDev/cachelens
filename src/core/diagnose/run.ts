import type { LlmCall } from "../model/call.js";
import { type DiagnoseOptions, diagnoseCall } from "./engine.js";
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
export function findAllDiagnoses(
  calls: readonly LlmCall[],
  options: DiagnoseOptions = {}
): DiagnoseFinding[] {
  const findings: DiagnoseFinding[] = [];
  for (const [sessionId, sessionCalls] of groupBySession(calls)) {
    let previous: LlmCall | undefined;
    for (const current of sessionCalls) {
      const result = diagnoseCall(previous, current, options);
      if (result.kind === "diagnosis") {
        findings.push({ sessionId, call: current, diagnosis: result.diagnosis });
      }
      previous = current;
    }
  }
  return findings;
}
