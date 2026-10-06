import {
  type BaselineDeltas,
  type CheckBaseline,
  type CheckMetrics,
  metricsFromResult
} from "../core/check/baseline.js";
import { type CheckResult, type CheckThresholds, evaluateCheck } from "../core/check/evaluate.js";
import type { DiagnoseFinding } from "../core/diagnose/run.js";
import type { LlmCall } from "../core/model/call.js";
import { formatPercent, formatUsd } from "./format.js";

/**
 * Evaluates the gate once (reusing `findings` when the caller already diagnosed `calls`) and
 * folds trace-reader warnings (skipped lines) into the result as a failing violation. Render the
 * returned result with `renderCheck` / `renderCheckJson`.
 */
export function checkTrace(
  calls: readonly LlmCall[],
  thresholds: CheckThresholds,
  readerWarnings: readonly string[] = [],
  findings?: readonly DiagnoseFinding[]
): CheckResult {
  const result = evaluateCheck(calls, thresholds, findings !== undefined ? { findings } : {});
  if (readerWarnings.length === 0) {
    return result;
  }
  const count = readerWarnings.length;
  return {
    ...result,
    passed: false,
    violations: [
      ...result.violations,
      {
        kind: "invalid-records",
        message: `${count} trace line${count === 1 ? " was" : "s were"} skipped as invalid`,
        actual: count,
        threshold: 0
      }
    ]
  };
}

export function renderCheck(result: CheckResult): string {
  const lines: string[] = [];
  lines.push(
    `cachelens check — ${result.passed ? "PASS" : "FAIL"} (${result.callCount} call${result.callCount === 1 ? "" : "s"}, findings: ${result.findingsCount})`
  );
  lines.push(`  total cost:    ${formatUsd(result.totalCostUsd)}`);
  lines.push(`  wasted cost:   ${formatUsd(result.totalWastedUsd)}`);
  const comparison = result.baselineComparison;
  if (comparison === undefined) {
    lines.push(`  hit rate:      ${formatPercent(result.hitRate)}`);
  } else {
    const { baseline, deltas } = comparison;
    const current = metricsFromResult(result);
    lines.push(
      `  hit rate:      ${formatPercent(current.hitRate)} (baseline ${formatPercent(baseline.hitRate)}, delta ${formatSigned(deltas.hitRatePoints, 1)} points, max drop ${comparison.maxHitRateDropPoints.toFixed(1)})`
    );
    lines.push(
      `  wasted/1k:     ${formatUsd(current.wastedUsdPer1kCalls)} per 1k calls (baseline ${formatUsd(baseline.wastedUsdPer1kCalls)}, delta ${formatSigned(deltas.wastedUsdPer1kCalls, 4, "$")}, max increase ${formatUsd(comparison.maxWastedIncreaseUsdPer1k)})`
    );
    lines.push(
      `  baseline:      ${baseline.calls} call${baseline.calls === 1 ? "" : "s"}, generated ${baseline.generatedAt}, pricing as of ${baseline.pricingAsOf}`
    );
  }
  if (!result.passed) {
    lines.push("  violations:");
    for (const violation of result.violations) {
      lines.push(`    - [${violation.kind}] ${violation.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Signed fixed-point number ("+1.2", "-$0.0040"); "n/a" for a non-finite value. */
function formatSigned(value: number, digits: number, prefix = ""): string {
  if (!Number.isFinite(value)) return "n/a";
  // Sign from the rounded value, so float noise like -1e-17 prints "+0.0", not "-0.0".
  const rounded = Math.abs(value).toFixed(digits);
  const sign = value < 0 && Number(rounded) !== 0 ? "-" : "+";
  return `${sign}${prefix}${rounded}`;
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
  /** This trace's metrics in the baseline schema; `hitRate` is a ratio (0-1). */
  readonly current: CheckMetrics;
  /** The loaded baseline, present only with `--baseline`. */
  readonly baseline?: CheckBaseline;
  /** Current minus baseline (hit rate in percentage points), present only with `--baseline`. */
  readonly deltas?: BaselineDeltas;
  /** The tolerances the baseline gate used, present only with `--baseline`. */
  readonly tolerances?: {
    readonly maxHitRateDropPoints: number;
    readonly maxWastedIncreaseUsdPer1k: number;
  };
  /** Reader, pricing and request warnings; informational beyond the invalid-records violation. */
  readonly warnings: readonly string[];
}

export function renderCheckJson(
  result: CheckResult,
  warnings: readonly string[] = []
): CheckResultJson {
  const comparison = result.baselineComparison;
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
    })),
    current: metricsFromResult(result),
    ...(comparison !== undefined
      ? {
          baseline: comparison.baseline,
          deltas: comparison.deltas,
          tolerances: {
            maxHitRateDropPoints: comparison.maxHitRateDropPoints,
            maxWastedIncreaseUsdPer1k: comparison.maxWastedIncreaseUsdPer1k
          }
        }
      : {}),
    warnings: [...warnings]
  };
}
