import type { LlmCall } from "../model/call.js";
import { type Usd, usd } from "../model/types.js";
import { computeCallCost } from "../pricing/cost.js";
import { getModelPricing } from "../pricing/table.js";
export interface CostByStep {
  readonly stepName: string;
  readonly totalUsd: Usd;
  readonly callCount: number;
}
export function costDistributionByStep(calls: readonly LlmCall[]): CostByStep[] {
  const byStep = new Map<
    string,
    {
      totalUsd: number;
      callCount: number;
    }
  >();
  for (const call of calls) {
    const pricing = getModelPricing(call.params.model);
    const cost = computeCallCost(call.usage, pricing, "5m");
    const existing = byStep.get(call.stepName) ?? { totalUsd: 0, callCount: 0 };
    byStep.set(call.stepName, {
      totalUsd: existing.totalUsd + cost,
      callCount: existing.callCount + 1
    });
  }
  return Array.from(byStep.entries())
    .map(([stepName, { totalUsd, callCount }]) => ({
      stepName,
      totalUsd: usd(totalUsd),
      callCount
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
}
