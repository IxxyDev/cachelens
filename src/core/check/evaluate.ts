import { costDistributionByStep } from "../aggregate/distribution.js";
import { aggregateHitRate } from "../aggregate/hitrate.js";
import type { DiagnoseOptions } from "../diagnose/engine.js";
import { type DiagnoseFinding, findAllDiagnoses } from "../diagnose/run.js";
import type { LlmCall } from "../model/call.js";
import { type Usd, usd } from "../model/types.js";
import {
  type BaselineDeltas,
  type BaselineGate,
  computeDeltas,
  metricsFromResult
} from "./baseline.js";
export interface CheckThresholds {
  readonly maxWastedUsd?: number;
  readonly minHitRate?: number;
  /** Regression gate against a previously written baseline (`check --baseline`). */
  readonly baseline?: BaselineGate;
}
/** Epsilon for baseline comparisons, so float summation order never fails an identical trace. */
const BASELINE_EPSILON = 1e-9;
export type CheckViolationKind =
  | "max-wasted-usd"
  | "unpriced-waste"
  | "min-hit-rate"
  | "no-calls"
  | "non-finite-metric"
  | "invalid-records"
  | "hit-rate-drop"
  | "wasted-increase";
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
  /** Present when a baseline gate was evaluated; `deltas` are current minus baseline. */
  readonly baselineComparison?: BaselineGate & { readonly deltas: BaselineDeltas };
}
export interface EvaluateCheckOptions extends DiagnoseOptions {
  /** Findings from a pass the caller already ran over `calls`; skips a second diagnosis. */
  readonly findings?: readonly DiagnoseFinding[];
}
export function evaluateCheck(
  calls: readonly LlmCall[],
  thresholds: CheckThresholds,
  options: EvaluateCheckOptions = {}
): CheckResult {
  const { findings: precomputed, ...diagnoseOptions } = options;
  const findings = precomputed ?? findAllDiagnoses(calls, diagnoseOptions);
  // Findings on unpriced models carry no dollar figure; they are gated separately below.
  const totalWastedUsd = usd(
    findings.reduce((sum, finding) => sum + (finding.diagnosis.wastedUsd ?? 0), 0)
  );
  const unpricedWastedTokens = findings.reduce(
    (sum, finding) =>
      finding.diagnosis.wastedUsd === null ? sum + finding.diagnosis.wastedTokens : sum,
    0
  );
  const hitRate = aggregateHitRate(calls);
  const totalCostUsd = usd(
    costDistributionByStep(calls).reduce((sum, entry) => sum + entry.totalUsd, 0)
  );
  const violations: CheckViolation[] = [];
  // A non-finite metric means the trace data is unusable; NaN comparisons are always false,
  // so without this guard a corrupt trace would silently pass every threshold.
  const metrics = [
    ["total cost", totalCostUsd],
    ["wasted cost", totalWastedUsd],
    ["hit rate", hitRate]
  ] as const;
  for (const [label, value] of metrics) {
    if (!Number.isFinite(value)) {
      violations.push({
        kind: "non-finite-metric",
        message: `${label} is not a finite number; the trace contains unusable usage data`,
        actual: value,
        threshold: 0
      });
    }
  }
  if (
    thresholds.maxWastedUsd !== undefined &&
    Number.isFinite(totalWastedUsd) &&
    totalWastedUsd > thresholds.maxWastedUsd
  ) {
    violations.push({
      kind: "max-wasted-usd",
      message: `wasted $${totalWastedUsd.toFixed(4)} exceeds max $${thresholds.maxWastedUsd.toFixed(4)}`,
      actual: totalWastedUsd,
      threshold: thresholds.maxWastedUsd
    });
  }
  // A priced model with the same waste could fail a dollar gate; an unknown price cannot be
  // shown to stay under it, so wasted tokens on an unpriced model fail whichever dollar gate is
  // active: the absolute max, or the baseline's wasted-increase tolerance.
  const dollarGate =
    thresholds.maxWastedUsd !== undefined
      ? { threshold: thresholds.maxWastedUsd, label: `max $${thresholds.maxWastedUsd.toFixed(4)}` }
      : thresholds.baseline !== undefined
        ? {
            threshold: thresholds.baseline.maxWastedIncreaseUsdPer1k,
            label: `the baseline's max increase of $${thresholds.baseline.maxWastedIncreaseUsdPer1k.toFixed(4)} per 1k calls`
          }
        : undefined;
  if (dollarGate !== undefined && unpricedWastedTokens > 0) {
    violations.push({
      kind: "unpriced-waste",
      message: `${unpricedWastedTokens} wasted tokens on models without pricing; their cost is unknown, so ${dollarGate.label} cannot be verified`,
      actual: unpricedWastedTokens,
      threshold: dollarGate.threshold
    });
  }
  const hitRateGated = thresholds.minHitRate !== undefined || thresholds.baseline !== undefined;
  if (hitRateGated && calls.length === 0) {
    violations.push({
      kind: "no-calls",
      message: "no calls in trace; hit rate cannot be evaluated",
      actual: 0,
      threshold: thresholds.minHitRate ?? 0
    });
  } else if (
    thresholds.minHitRate !== undefined &&
    Number.isFinite(hitRate) &&
    hitRate < thresholds.minHitRate
  ) {
    violations.push({
      kind: "min-hit-rate",
      message: `hit rate ${(hitRate * 100).toFixed(1)}% is below min ${(thresholds.minHitRate * 100).toFixed(1)}%`,
      actual: hitRate,
      threshold: thresholds.minHitRate
    });
  }
  const result: CheckResult = {
    passed: violations.length === 0,
    callCount: calls.length,
    findingsCount: findings.length,
    totalCostUsd,
    totalWastedUsd,
    hitRate,
    violations
  };
  return thresholds.baseline === undefined ? result : applyBaseline(result, thresholds.baseline);
}
/**
 * Compares the current metrics with the baseline. Skipped for an empty or non-finite trace:
 * those already fail with no-calls / non-finite-metric, and a delta against them is noise.
 */
function applyBaseline(result: CheckResult, gate: BaselineGate): CheckResult {
  const deltas = computeDeltas(metricsFromResult(result), gate.baseline);
  const comparison = { ...gate, deltas };
  const comparable =
    result.callCount > 0 &&
    Number.isFinite(deltas.hitRatePoints) &&
    Number.isFinite(deltas.wastedUsdPer1kCalls);
  if (!comparable) {
    return { ...result, baselineComparison: comparison };
  }
  const violations = [...result.violations];
  const drop = -deltas.hitRatePoints;
  if (drop > gate.maxHitRateDropPoints + BASELINE_EPSILON) {
    violations.push({
      kind: "hit-rate-drop",
      message: `hit rate ${(result.hitRate * 100).toFixed(1)}% dropped ${drop.toFixed(1)} points from baseline ${(gate.baseline.hitRate * 100).toFixed(1)}% (max drop ${gate.maxHitRateDropPoints.toFixed(1)} points)`,
      actual: drop,
      threshold: gate.maxHitRateDropPoints
    });
  }
  const increase = deltas.wastedUsdPer1kCalls;
  if (increase > gate.maxWastedIncreaseUsdPer1k + BASELINE_EPSILON) {
    const current = gate.baseline.wastedUsdPer1kCalls + increase;
    violations.push({
      kind: "wasted-increase",
      message: `wasted $${current.toFixed(4)} per 1k calls rose $${increase.toFixed(4)} from baseline $${gate.baseline.wastedUsdPer1kCalls.toFixed(4)} (max increase $${gate.maxWastedIncreaseUsdPer1k.toFixed(4)})`,
      actual: increase,
      threshold: gate.maxWastedIncreaseUsdPer1k
    });
  }
  return {
    ...result,
    passed: violations.length === 0,
    violations,
    baselineComparison: comparison
  };
}
