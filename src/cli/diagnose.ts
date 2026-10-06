import { type DiagnoseFinding, findAllDiagnoses } from "../core/diagnose/run.js";
import type { Diagnosis } from "../core/diagnose/taxonomy.js";
import type { LlmCall } from "../core/model/call.js";
function renderTierBreakdown(diagnosis: Diagnosis): string[] {
  const byTier = diagnosis.wastedUsdByTier;
  if (diagnosis.invalidatedTiers.length <= 1 || byTier === null) {
    return [];
  }
  const lines = diagnosis.invalidatedTiers.map((tier) => {
    const tierWastedUsd = byTier.get(tier) ?? 0;
    return `    ${tier.padEnd(10)} ~$${tierWastedUsd.toFixed(4)}`;
  });
  return ["", "  wasted by tier (approximate — see docs):", ...lines];
}
function renderFinding(sessionId: string, call: LlmCall, diagnosis: Diagnosis): string {
  const tiers = diagnosis.invalidatedTiers.join("+");
  return [
    `${sessionId} / ${call.stepName} (${call.id})`,
    `  ${diagnosis.cause} at ${diagnosis.structuralPath} (wire-body offset ${diagnosis.byteOffset}, tier: ${tiers})`,
    "",
    `    ${diagnosis.excerpt}`,
    "",
    `  wasted: ${diagnosis.wastedTokens} token${diagnosis.wastedTokens === 1 ? "" : "s"} (${diagnosis.wastedUsd === null ? "~$n/a, model unpriced" : `~$${diagnosis.wastedUsd.toFixed(4)}`})`,
    ...renderTierBreakdown(diagnosis),
    `  fix: ${diagnosis.recommendation}`
  ].join("\n");
}
export function renderDiagnose(calls: readonly LlmCall[]): string {
  if (calls.length === 0) {
    return "No calls in this trace.\n";
  }
  const results = findAllDiagnoses(calls);
  const findings = results.map((r) => renderFinding(r.sessionId, r.call, r.diagnosis));
  if (findings.length === 0) {
    return "cachelens diagnose — no cache-miss root causes found.\n";
  }
  const header = `cachelens diagnose — ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  return `${[header, ...findings].join("\n\n")}\n`;
}
export interface DiagnoseFindingJson {
  readonly sessionId: string;
  readonly callId: string;
  readonly stepName: string;
  readonly cause: Diagnosis["cause"];
  readonly invalidatedTiers: Diagnosis["invalidatedTiers"];
  readonly byteOffset: number;
  readonly structuralPath: string;
  readonly excerpt: string;
  readonly wastedTokens: number;
  /** Null when the model has no pricing entry. */
  readonly wastedUsd: number | null;
  readonly wastedUsdByTier: Record<string, number> | null;
  readonly recommendation: string;
}
function toFindingJson(finding: DiagnoseFinding): DiagnoseFindingJson {
  const { diagnosis } = finding;
  return {
    sessionId: finding.sessionId,
    callId: finding.call.id,
    stepName: finding.call.stepName,
    cause: diagnosis.cause,
    invalidatedTiers: diagnosis.invalidatedTiers,
    byteOffset: diagnosis.byteOffset,
    structuralPath: diagnosis.structuralPath,
    excerpt: diagnosis.excerpt,
    wastedTokens: diagnosis.wastedTokens,
    wastedUsd: diagnosis.wastedUsd,
    wastedUsdByTier: diagnosis.wastedUsdByTier && Object.fromEntries(diagnosis.wastedUsdByTier),
    recommendation: diagnosis.recommendation
  };
}
export interface DiagnoseReportJson {
  readonly callCount: number;
  readonly findingCount: number;
  readonly findings: readonly DiagnoseFindingJson[];
}
export function renderDiagnoseJson(calls: readonly LlmCall[]): DiagnoseReportJson {
  const findings = findAllDiagnoses(calls);
  return {
    callCount: calls.length,
    findingCount: findings.length,
    findings: findings.map(toFindingJson)
  };
}
