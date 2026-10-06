/** Dollar amount with 4 decimals; "n/a" for a non-finite value so output never shows NaN. */
export function formatUsd(amount: number): string {
  return Number.isFinite(amount) ? `$${amount.toFixed(4)}` : "n/a";
}

/** Ratio (0-1) as a percentage with 1 decimal; "n/a" for a non-finite value. */
export function formatPercent(ratio: number): string {
  return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : "n/a";
}
