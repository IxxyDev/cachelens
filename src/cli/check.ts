import { type CheckResult, type CheckThresholds, evaluateCheck } from "../core/check/evaluate.js";
import type { LlmCall } from "../core/model/call.js";
function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
export function renderCheck(calls: readonly LlmCall[], thresholds: CheckThresholds): string {
  const result = evaluateCheck(calls, thresholds);
  const lines: string[] = [];
  lines.push(
    `cachelens check — ${result.passed ? "PASS" : "FAIL"} (${calls.length} call${calls.length === 1 ? "" : "s"}, findings: ${result.findingsCount})`
  );
  lines.push(`  total cost:    ${formatUsd(result.totalCostUsd)}`);
  lines.push(`  wasted cost:   ${formatUsd(result.totalWastedUsd)}`);
  lines.push(`  hit rate:      ${formatPercent(result.hitRate)}`);
  if (!result.passed) {
    lines.push("  violations:");
    for (const violation of result.violations) {
      lines.push(`    - [${violation.kind}] ${violation.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
export interface CheckResultJson {
  readonly passed: boolean;
  readonly callCount: number;
  readonly findingsCount: number;
  readonly totalCostUsd: number;
  readonly totalWastedUsd: number;
  readonly hitRate: number;
  readonly violations: readonly {
    readonly kind: string;
    readonly message: string;
    readonly actual: number;
    readonly threshold: number;
  }[];
}
function toCheckResultJson(result: CheckResult): CheckResultJson {
  return {
    passed: result.passed,
    callCount: result.callCount,
    findingsCount: result.findingsCount,
    totalCostUsd: result.totalCostUsd,
    totalWastedUsd: result.totalWastedUsd,
    hitRate: result.hitRate,
    violations: result.violations.map((v) => ({
      kind: v.kind,
      message: v.message,
      actual: v.actual,
      threshold: v.threshold
    }))
  };
}
export function renderCheckJson(
  calls: readonly LlmCall[],
  thresholds: CheckThresholds
): CheckResultJson {
  return toCheckResultJson(evaluateCheck(calls, thresholds));
}
