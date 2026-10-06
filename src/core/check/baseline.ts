import { PRICING_AS_OF } from "../pricing/table.js";
import type { CheckResult } from "./evaluate.js";

export const BASELINE_VERSION = 1;

/** The metrics a baseline records and a later `check` compares against. */
export interface CheckMetrics {
  readonly calls: number;
  /** Aggregate cache hit rate as a ratio (0-1), the same unit as `CheckResult.hitRate`. */
  readonly hitRate: number;
  readonly totalUsd: number;
  readonly wastedUsd: number;
  /** `wastedUsd` normalised per 1,000 calls so traces of different sizes compare. */
  readonly wastedUsdPer1kCalls: number;
}

/** The artifact `check --write-baseline` writes and `check --baseline` reads. */
export interface CheckBaseline extends CheckMetrics {
  readonly version: typeof BASELINE_VERSION;
  /** ISO 8601 timestamp of when the baseline was written. */
  readonly generatedAt: string;
  /** `PRICING_AS_OF` of the build that wrote it; dollar metrics are only comparable within one. */
  readonly pricingAsOf: string;
}

export interface BaselineTolerances {
  /** Allowed hit-rate drop in percentage points (0-100). 0 means no drop is allowed. */
  readonly maxHitRateDropPoints: number;
  /** Allowed rise in wasted USD per 1,000 calls. 0 means no rise is allowed. */
  readonly maxWastedIncreaseUsdPer1k: number;
}

export interface BaselineGate extends BaselineTolerances {
  readonly baseline: CheckBaseline;
}

export interface BaselineDeltas {
  /** Current minus baseline hit rate, in percentage points; negative is a drop. */
  readonly hitRatePoints: number;
  /** Current minus baseline wasted USD per 1,000 calls; positive is a rise. */
  readonly wastedUsdPer1kCalls: number;
}

export function wastedUsdPer1kCalls(wastedUsd: number, calls: number): number {
  return calls === 0 ? 0 : (wastedUsd / calls) * 1000;
}

export function metricsFromResult(result: CheckResult): CheckMetrics {
  return {
    calls: result.callCount,
    hitRate: result.hitRate,
    totalUsd: result.totalCostUsd,
    wastedUsd: result.totalWastedUsd,
    wastedUsdPer1kCalls: wastedUsdPer1kCalls(result.totalWastedUsd, result.callCount)
  };
}

export function createBaseline(result: CheckResult, now: Date = new Date()): CheckBaseline {
  return {
    version: BASELINE_VERSION,
    generatedAt: now.toISOString(),
    pricingAsOf: PRICING_AS_OF,
    ...metricsFromResult(result)
  };
}

export function computeDeltas(current: CheckMetrics, baseline: CheckMetrics): BaselineDeltas {
  return {
    hitRatePoints: (current.hitRate - baseline.hitRate) * 100,
    wastedUsdPer1kCalls: current.wastedUsdPer1kCalls - baseline.wastedUsdPer1kCalls
  };
}

const NUMBER_FIELDS = ["calls", "hitRate", "totalUsd", "wastedUsd", "wastedUsdPer1kCalls"] as const;

/**
 * Validates parsed JSON as a baseline. Returns the reason it is not one (without the file name,
 * which the caller adds) so a hand-edited or foreign file fails loudly instead of comparing NaN.
 */
export function parseBaseline(value: unknown): CheckBaseline | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "not a JSON object" };
  }
  const record = value as Partial<Record<keyof CheckBaseline, unknown>>;
  if (record.version !== BASELINE_VERSION) {
    return {
      error: `unsupported version ${JSON.stringify(record.version)} (expected ${BASELINE_VERSION})`
    };
  }
  for (const field of ["generatedAt", "pricingAsOf"] as const) {
    if (typeof record[field] !== "string") {
      return { error: `missing or non-string field "${field}"` };
    }
  }
  for (const field of NUMBER_FIELDS) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0) {
      return { error: `missing or invalid field "${field}" (expected a finite number >= 0)` };
    }
  }
  if ((record.hitRate as number) > 1) {
    return { error: `field "hitRate" must be a ratio between 0 and 1` };
  }
  return {
    version: BASELINE_VERSION,
    generatedAt: record.generatedAt as string,
    pricingAsOf: record.pricingAsOf as string,
    calls: record.calls as number,
    hitRate: record.hitRate as number,
    totalUsd: record.totalUsd as number,
    wastedUsd: record.wastedUsd as number,
    wastedUsdPer1kCalls: record.wastedUsdPer1kCalls as number
  };
}
