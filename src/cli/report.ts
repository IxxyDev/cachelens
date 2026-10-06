import { type CostByStep, costDistributionByStep } from "../core/aggregate/distribution.js";
import { aggregateHitRate } from "../core/aggregate/hitrate.js";
import type { DiagnoseFinding } from "../core/diagnose/run.js";
import type { LlmCall } from "../core/model/call.js";
import { type Usd, usd } from "../core/model/types.js";
import { computeCallCost, declaredWriteTtl } from "../core/pricing/cost.js";
import { tryGetModelPricing } from "../core/pricing/table.js";
import { formatPercent, formatUsd } from "./format.js";

/** Aggregates computed once per invocation; rendered as text, JSON or HTML. */
export interface ReportSummary {
  readonly callCount: number;
  readonly totalUsd: Usd;
  readonly hitRate: number;
  readonly byStep: readonly CostByStep[];
  /** Reader, pricing and request warnings, already deduplicated. */
  readonly warnings: readonly string[];
  /** The analysed calls, for the HTML per-session timeline. */
  readonly calls: readonly LlmCall[];
}

export function summarizeReport(
  calls: readonly LlmCall[],
  warnings: readonly string[] = []
): ReportSummary {
  const byStep = costDistributionByStep(calls);
  return {
    callCount: calls.length,
    totalUsd: usd(byStep.reduce((sum, entry) => sum + entry.totalUsd, 0)),
    hitRate: aggregateHitRate(calls),
    byStep,
    warnings,
    calls
  };
}

export function renderReport(summary: ReportSummary): string {
  if (summary.callCount === 0) {
    return "No calls in this trace.\n";
  }
  const lines: string[] = [];
  lines.push(`cachelens report — ${summary.callCount} call${summary.callCount === 1 ? "" : "s"}`);
  lines.push("");
  lines.push("Cost by step:");
  for (const entry of summary.byStep) {
    lines.push(
      `  ${entry.stepName.padEnd(24)} ${formatUsd(entry.totalUsd).padStart(10)}  (${entry.callCount} call${entry.callCount === 1 ? "" : "s"})`
    );
  }
  lines.push("");
  lines.push(`Total cost:        ${formatUsd(summary.totalUsd)}`);
  lines.push(`Cache hit rate:    ${formatPercent(summary.hitRate)}`);
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
  /** Reader, pricing and request warnings; an unpriced model's calls add no cost. */
  readonly warnings: readonly string[];
}

export function renderReportJson(summary: ReportSummary): ReportJson {
  return {
    callCount: summary.callCount,
    totalUsd: summary.totalUsd,
    hitRate: summary.hitRate,
    byStep: summary.byStep.map((entry) => ({
      stepName: entry.stepName,
      totalUsd: entry.totalUsd,
      callCount: entry.callCount
    })),
    warnings: [...summary.warnings]
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
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  h3 { font-size: 0.95rem; margin-top: 1.25rem; }
  table.wide { max-width: none; }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .muted { opacity: 0.7; }
`;
/** Longest advice text shown per finding; the full text is in `cachelens diagnose`. */
const ADVICE_MAX_CHARS = 160;
function renderBar(fraction: number): string {
  const width = Math.max(0, Math.min(100, fraction * 100));
  return `<span class="bar-track"><svg width="160" height="10" xmlns="http://www.w3.org/2000/svg"><rect class="bar-fill" width="${width}%" height="10" fill="currentColor" /></svg></span>`;
}
function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}
function renderFindingsSection(findings: readonly DiagnoseFinding[]): string {
  if (findings.length === 0) {
    return "<h2>Findings</h2>\n<p>No cache-miss root causes found.</p>";
  }
  const rows = findings
    .map(({ sessionId, call, diagnosis }) =>
      [
        "<tr>",
        `<td>${escapeHtml(diagnosis.cause)}</td>`,
        `<td><code>${escapeHtml(call.id)}</code></td>`,
        `<td>${escapeHtml(sessionId)}</td>`,
        `<td>${escapeHtml(call.stepName)}</td>`,
        `<td class="num">${diagnosis.byteOffset}</td>`,
        `<td><code>${escapeHtml(diagnosis.structuralPath)}</code></td>`,
        `<td class="num">${formatUsd(diagnosis.wastedUsd ?? Number.NaN)}${diagnosis.wastedEstimate === true ? " (est.)" : ""}</td>`,
        `<td>${escapeHtml(truncate(diagnosis.recommendation, ADVICE_MAX_CHARS))}</td>`,
        "</tr>"
      ].join("")
    )
    .join("\n");
  return [
    `<h2>Findings (${findings.length})</h2>`,
    '<table class="wide">',
    '<thead><tr><th>Cause</th><th>Call</th><th>Session</th><th>Step</th><th class="num">Canonical offset</th><th>Structural path</th><th class="num">Wasted</th><th>Advice</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    "</table>"
  ].join("\n");
}
function callCostUsd(call: LlmCall): number | undefined {
  const pricing = tryGetModelPricing(call.params.model);
  return pricing ? computeCallCost(call.usage, pricing, declaredWriteTtl(call)) : undefined;
}
function renderTimelineSection(calls: readonly LlmCall[]): string {
  const bySession = new Map<string, LlmCall[]>();
  for (const call of calls) {
    const existing = bySession.get(call.sessionId);
    if (existing) existing.push(call);
    else bySession.set(call.sessionId, [call]);
  }
  const sections = [...bySession].map(([sessionId, sessionCalls]) => {
    const ordered = [...sessionCalls].sort(
      (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const rows = ordered
      .map((call) => {
        const cost = callCostUsd(call);
        return [
          "<tr>",
          `<td>${escapeHtml(formatTimestamp(call.timestamp))}</td>`,
          `<td><code>${escapeHtml(call.id)}</code></td>`,
          `<td>${escapeHtml(call.stepName)}</td>`,
          `<td class="num">${call.usage.inputTokens}</td>`,
          `<td class="num">${call.usage.cacheReadInputTokens}</td>`,
          `<td class="num">${call.usage.cacheCreationInputTokens}</td>`,
          `<td class="num">${cost === undefined ? '<span class="muted">unpriced</span>' : formatUsd(cost)}</td>`,
          "</tr>"
        ].join("");
      })
      .join("\n");
    return [
      `<h3>Session ${escapeHtml(sessionId)} (${ordered.length} call${ordered.length === 1 ? "" : "s"})</h3>`,
      '<table class="wide">',
      '<thead><tr><th>Timestamp</th><th>Call</th><th>Step</th><th class="num">Input</th><th class="num">Cache read</th><th class="num">Cache creation</th><th class="num">Cost</th></tr></thead>',
      `<tbody>${rows}</tbody>`,
      "</table>"
    ].join("\n");
  });
  return ["<h2>Timeline</h2>", ...sections].join("\n");
}
function renderWarningsSection(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return "<h2>Warnings</h2>\n<p>None.</p>";
  }
  const items = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("\n");
  return `<h2>Warnings (${warnings.length})</h2>\n<ul>\n${items}\n</ul>`;
}
/**
 * Self-contained HTML report (inline CSS, no scripts or external requests). `findings` come from
 * the caller's single diagnosis pass; every trace-derived string is escaped.
 */
export function renderReportHtml(
  summary: ReportSummary,
  findings: readonly DiagnoseFinding[]
): string {
  if (summary.callCount === 0) {
    return [
      "<!doctype html>",
      '<html><head><meta charset="utf-8"><title>cachelens report</title>',
      `<style>${HTML_STYLE}</style></head>`,
      "<body><h1>cachelens report</h1><p>No calls in this trace.</p>",
      renderWarningsSection(summary.warnings),
      "</body></html>"
    ].join("\n");
  }
  const { byStep, hitRate, totalUsd } = summary;
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
    `<h1>cachelens report — ${summary.callCount} call${summary.callCount === 1 ? "" : "s"}</h1>`,
    "<h2>Cost by step</h2>",
    "<table>",
    '<thead><tr><th>Step</th><th class="num">Cost</th><th class="num">Calls</th><th>Distribution</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    "</table>",
    '<p class="totals">',
    `Total cost: <strong>${formatUsd(totalUsd)}</strong><br>`,
    `Cache hit rate: <strong>${formatPercent(hitRate)}</strong>`,
    "</p>",
    renderFindingsSection(findings),
    renderTimelineSection(summary.calls),
    renderWarningsSection(summary.warnings),
    "</body></html>"
  ].join("\n");
}
