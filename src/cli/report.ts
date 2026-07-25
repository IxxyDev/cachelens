import { costDistributionByStep } from "../core/aggregate/distribution.js";
import { aggregateHitRate } from "../core/aggregate/hitrate.js";
import type { LlmCall } from "../core/model/call.js";
import type { Usd } from "../core/model/types.js";
function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
export function renderReport(calls: readonly LlmCall[]): string {
  if (calls.length === 0) {
    return "No calls in this trace.\n";
  }
  const byStep = costDistributionByStep(calls);
  const hitRate = aggregateHitRate(calls);
  const totalUsd = byStep.reduce((sum, entry) => sum + entry.totalUsd, 0);
  const lines: string[] = [];
  lines.push(`cachelens report — ${calls.length} call${calls.length === 1 ? "" : "s"}`);
  lines.push("");
  lines.push("Cost by step:");
  for (const entry of byStep) {
    lines.push(
      `  ${entry.stepName.padEnd(24)} ${formatUsd(entry.totalUsd).padStart(10)}  (${entry.callCount} call${entry.callCount === 1 ? "" : "s"})`
    );
  }
  lines.push("");
  lines.push(`Total cost:        ${formatUsd(totalUsd)}`);
  lines.push(`Cache hit rate:    ${formatPercent(hitRate)}`);
  lines.push("");
  return lines.join("\n");
}
export interface ReportStepJson {
  readonly stepName: string;
  readonly totalUsd: number;
  readonly callCount: number;
}
export interface ReportJson {
  readonly callCount: number;
  readonly totalUsd: number;
  readonly hitRate: number;
  readonly byStep: readonly ReportStepJson[];
}
export function renderReportJson(calls: readonly LlmCall[]): ReportJson {
  const byStep = costDistributionByStep(calls);
  const totalUsd: Usd = byStep.reduce((sum, entry) => sum + entry.totalUsd, 0) as Usd;
  return {
    callCount: calls.length,
    totalUsd,
    hitRate: aggregateHitRate(calls),
    byStep: byStep.map((entry) => ({
      stepName: entry.stepName,
      totalUsd: entry.totalUsd,
      callCount: entry.callCount
    }))
  };
}
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const HTML_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; }
  h1 { font-size: 1.25rem; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th, td { text-align: left; padding: 0.4rem 0.75rem; border-bottom: 1px solid rgba(128, 128, 128, 0.35); }
  th { font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar-track { background: rgba(128, 128, 128, 0.2); border-radius: 3px; overflow: hidden; width: 160px; height: 10px; display: inline-block; vertical-align: middle; }
  .bar-fill { height: 10px; }
  .totals { margin-top: 1rem; }
`;
function renderBar(fraction: number): string {
  const width = Math.max(0, Math.min(100, fraction * 100));
  return `<span class="bar-track"><svg width="160" height="10" xmlns="http://www.w3.org/2000/svg"><rect class="bar-fill" width="${width}%" height="10" fill="currentColor" /></svg></span>`;
}
export function renderReportHtml(calls: readonly LlmCall[]): string {
  if (calls.length === 0) {
    return [
      "<!doctype html>",
      '<html><head><meta charset="utf-8"><title>cachelens report</title>',
      `<style>${HTML_STYLE}</style></head>`,
      "<body><h1>cachelens report</h1><p>No calls in this trace.</p></body></html>"
    ].join("\n");
  }
  const byStep = costDistributionByStep(calls);
  const hitRate = aggregateHitRate(calls);
  const totalUsd = byStep.reduce((sum, entry) => sum + entry.totalUsd, 0);
  const maxStepUsd = Math.max(...byStep.map((entry) => entry.totalUsd), 0);
  const rows = byStep
    .map((entry) => {
      const fraction = maxStepUsd === 0 ? 0 : entry.totalUsd / maxStepUsd;
      return [
        "<tr>",
        `<td>${escapeHtml(entry.stepName)}</td>`,
        `<td class="num">${formatUsd(entry.totalUsd)}</td>`,
        `<td class="num">${entry.callCount}</td>`,
        `<td>${renderBar(fraction)}</td>`,
        "</tr>"
      ].join("");
    })
    .join("\n");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>cachelens report</title>',
    `<style>${HTML_STYLE}</style></head>`,
    "<body>",
    `<h1>cachelens report — ${calls.length} call${calls.length === 1 ? "" : "s"}</h1>`,
    "<table>",
    '<thead><tr><th>Step</th><th class="num">Cost</th><th class="num">Calls</th><th>Distribution</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    "</table>",
    '<p class="totals">',
    `Total cost: <strong>${formatUsd(totalUsd)}</strong><br>`,
    `Cache hit rate: <strong>${formatPercent(hitRate)}</strong>`,
    "</p>",
    "</body></html>"
  ].join("\n");
}
