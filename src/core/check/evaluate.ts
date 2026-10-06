import { costDistributionByStep } from "../aggregate/distribution.js";
import { aggregateHitRate } from "../aggregate/hitrate.js";
import type { DiagnoseOptions } from "../diagnose/engine.js";
import { findAllDiagnoses } from "../diagnose/run.js";
import type { LlmCall } from "../model/call.js";
import { type Usd, usd } from "../model/types.js";
export interface CheckThresholds {
  readonly maxWastedUsd?: number;
  readonly minHitRate?: number;
}
export type CheckViolationKind = "max-wasted-usd" | "min-hit-rate";
export interface CheckViolation {
  readonly kind: CheckViolationKind;
  readonly message: string;
  readonly actual: number;
  readonly threshold: number;
}
export interface CheckResult {
  readonly passed: boolean;
  readonly callCount: number;
  readonly findingsCount: number;
  readonly totalCostUsd: Usd;
  readonly totalWastedUsd: Usd;
  readonly hitRate: number;
  readonly violations: readonly CheckViolation[];
}
export function evaluateCheck(
  calls: readonly LlmCall[],
  thresholds: CheckThresholds,
  options: DiagnoseOptions = {}
): CheckResult {
  const findings = findAllDiagnoses(calls, options);
  // Findings on unpriced models carry no dollar figure.
  const totalWastedUsd = usd(
    findings.reduce((sum, finding) => sum + (finding.diagnosis.wastedUsd ?? 0), 0)
  );
  const hitRate = aggregateHitRate(calls);
  const totalCostUsd = usd(
    costDistributionByStep(calls).reduce((sum, entry) => sum + entry.totalUsd, 0)
  );
  const violations: CheckViolation[] = [];
  if (thresholds.maxWastedUsd !== undefined && totalWastedUsd > thresholds.maxWastedUsd) {
    violations.push({
      kind: "max-wasted-usd",
      message: `wasted $${totalWastedUsd.toFixed(4)} exceeds max $${thresholds.maxWastedUsd.toFixed(4)}`,
      actual: totalWastedUsd,
      threshold: thresholds.maxWastedUsd
    });
  }
  if (thresholds.minHitRate !== undefined && hitRate < thresholds.minHitRate) {
    violations.push({
      kind: "min-hit-rate",
      message: `hit rate ${(hitRate * 100).toFixed(1)}% is below min ${(thresholds.minHitRate * 100).toFixed(1)}%`,
      actual: hitRate,
      threshold: thresholds.minHitRate
    });
  }
  return {
    passed: violations.length === 0,
    callCount: calls.length,
    findingsCount: findings.length,
    totalCostUsd,
    totalWastedUsd,
    hitRate,
    violations
  };
}
