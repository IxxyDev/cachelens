import { describe, expect, it } from "vitest";
import type { DiagnoseFinding } from "../core/diagnose/run.js";
import { findAllDiagnoses } from "../core/diagnose/run.js";
import type { LlmCall } from "../core/model/call.js";
import { byteOffset, tokenCount, usd } from "../core/model/types.js";
import { unpricedModelWarnings } from "../core/pricing/table.js";
import { renderReport, renderReportHtml, renderReportJson, summarizeReport } from "./report.js";

function makeCall(
  stepName: string,
  usage: Partial<Record<keyof LlmCall["usage"], number>> = {},
  model = "claude-sonnet-4-5"
): LlmCall {
  return {
    id: `${stepName}-${Math.random()}`,
    sessionId: "s1",
    stepName,
    timestamp: 0,
    params: { model },
    payload: { wireBody: "{}" },
    usage: {
      inputTokens: tokenCount(usage.inputTokens ?? 0),
      outputTokens: tokenCount(usage.outputTokens ?? 0),
      cacheCreationInputTokens: tokenCount(usage.cacheCreationInputTokens ?? 0),
      cacheReadInputTokens: tokenCount(usage.cacheReadInputTokens ?? 0)
    }
  };
}
describe("renderReport", () => {
  it("reports no calls in an empty trace without throwing", () => {
    expect(renderReport(summarizeReport([]))).toContain("No calls");
  });
  it("includes each step, a total cost, and a cache hit rate", () => {
    const calls = [
      makeCall("planner", { inputTokens: 1000, outputTokens: 200 }),
      makeCall("executor", { cacheReadInputTokens: 900, inputTokens: 100 })
    ];
    const report = renderReport(summarizeReport(calls));
    expect(report).toContain("planner");
    expect(report).toContain("executor");
    expect(report).toContain("Total cost:");
    expect(report).toContain("Cache hit rate:");
  });
  it("orders steps most-expensive-first (delegates to costDistributionByStep)", () => {
    const calls = [
      makeCall("cheap", { inputTokens: 10 }),
      makeCall("expensive", { inputTokens: 100000, outputTokens: 50000 })
    ];
    const report = renderReport(summarizeReport(calls));
    expect(report.indexOf("expensive")).toBeLessThan(report.indexOf("cheap"));
  });
  it("reports a 100% hit rate when every input token was a cache read", () => {
    const calls = [makeCall("step", { cacheReadInputTokens: 500 })];
    expect(renderReport(summarizeReport(calls))).toContain("100.0%");
  });
});
describe("renderReportJson", () => {
  it("excludes an unpriced model's cost and carries the given warnings instead of throwing", () => {
    const priced = makeCall("priced", { inputTokens: 1000000 });
    const unpriced = makeCall("unpriced", { inputTokens: 1000000 }, "claude-unknown-9");
    const calls = [priced, unpriced];
    const warnings = unpricedModelWarnings(calls.map((call) => call.params.model));
    const result = renderReportJson(summarizeReport(calls, warnings));
    expect(result.totalUsd).toBeCloseTo(3, 10);
    expect(result.warnings).toEqual([expect.stringContaining('"claude-unknown-9"')]);
  });
  it("returns zeroed totals for an empty trace", () => {
    expect(renderReportJson(summarizeReport([]))).toEqual({
      callCount: 0,
      totalUsd: 0,
      hitRate: 0,
      byStep: [],
      warnings: []
    });
  });
  it("matches costDistributionByStep ordering and totals", () => {
    const calls = [
      makeCall("cheap", { inputTokens: 10 }),
      makeCall("expensive", { inputTokens: 100000, outputTokens: 50000 })
    ];
    const result = renderReportJson(summarizeReport(calls));
    expect(result.callCount).toBe(2);
    expect(result.byStep.map((s) => s.stepName)).toEqual(["expensive", "cheap"]);
    expect(result.totalUsd).toBeCloseTo(
      result.byStep.reduce((sum, s) => sum + s.totalUsd, 0),
      10
    );
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
describe("renderReportHtml", () => {
  it("renders a self-contained HTML document with no external dependencies", () => {
    const calls = [makeCall("planner", { inputTokens: 1000, outputTokens: 200 })];
    const html = renderReportHtml(summarizeReport(calls), []);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/<script\s/i);
    expect(html).not.toMatch(/(?:href|src)\s*=\s*"https?:\/\//);
    expect(html).toContain("planner");
  });
  it("escapes step names so untrusted trace data cannot inject markup", () => {
    const calls = [makeCall("<script>alert(1)</script>", { inputTokens: 10 })];
    const html = renderReportHtml(summarizeReport(calls), []);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("renders a no-calls message for an empty trace without throwing", () => {
    const html = renderReportHtml(summarizeReport([]), []);
    expect(html).toContain("No calls");
  });
});

describe("renderReportHtml findings, timeline and warnings", () => {
  const missCall = (id: string, timestamp: number, system: string, stepName = "loop"): LlmCall => ({
    ...makeCall(stepName, { cacheCreationInputTokens: 500000 }),
    id,
    timestamp,
    payload: { wireBody: JSON.stringify({ tools: [], system, messages: [] }) }
  });

  it("renders a findings table computed by findAllDiagnoses", () => {
    const calls = [missCall("c1", 1000, "ts=1000"), missCall("c2", 2000, "ts=2000")];
    const findings = findAllDiagnoses(calls);
    expect(findings).toHaveLength(1);
    const html = renderReportHtml(summarizeReport(calls), findings);
    const [finding] = findings as [DiagnoseFinding];
    expect(html).toContain("<h2>Findings (1)</h2>");
    expect(html).toContain(`<td>${finding.diagnosis.cause}</td>`);
    expect(html).toContain("<code>c2</code>");
    expect(html).toContain(`<td class="num">${finding.diagnosis.byteOffset}</td>`);
    expect(html).toContain(finding.diagnosis.structuralPath);
    expect(html).toContain(`$${finding.diagnosis.wastedUsd?.toFixed(4)}`);
  });

  it("says so when there are no findings", () => {
    const html = renderReportHtml(summarizeReport([makeCall("a", { inputTokens: 1 })]), []);
    expect(html).toContain("No cache-miss root causes found.");
  });

  it("renders a per-session timeline in request order with tokens and cost", () => {
    const later = {
      ...makeCall("second", { inputTokens: 7, cacheReadInputTokens: 11 }),
      id: "late",
      timestamp: 2000
    };
    const earlier = {
      ...makeCall("first", { cacheCreationInputTokens: 13 }),
      id: "early",
      timestamp: 1000
    };
    const other = { ...makeCall("x", { inputTokens: 1 }), id: "o1", sessionId: "s2" };
    const html = renderReportHtml(summarizeReport([later, earlier, other]), []);
    expect(html).toContain("<h3>Session s1 (2 calls)</h3>");
    expect(html).toContain("<h3>Session s2 (1 call)</h3>");
    expect(html.indexOf("<code>early</code>")).toBeLessThan(html.indexOf("<code>late</code>"));
    expect(html).toContain(new Date(1000).toISOString());
    expect(html).toContain('<td class="num">7</td><td class="num">11</td><td class="num">0</td>');
  });

  it("marks an unpriced model's timeline cost instead of showing $0", () => {
    const html = renderReportHtml(
      summarizeReport([makeCall("a", { inputTokens: 1 }, "claude-unknown-9")]),
      []
    );
    expect(html).toContain("unpriced");
  });

  it("lists warnings, escaped", () => {
    const warnings = ['t.jsonl:3: skipped invalid record (<img src=x onerror="alert(1)">)'];
    const html = renderReportHtml(
      summarizeReport([makeCall("a", { inputTokens: 1 })], warnings),
      []
    );
    expect(html).toContain("<h2>Warnings (1)</h2>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("escapes a <script> step name, session id, call id and advice in every section", () => {
    const evil = "<script>alert(1)</script>";
    const call: LlmCall = { ...makeCall(evil, { inputTokens: 1 }), id: evil, sessionId: evil };
    const finding: DiagnoseFinding = {
      sessionId: evil,
      call,
      diagnosis: {
        cause: "dynamic-prefix-content",
        invalidatedTiers: ["system"],
        byteOffset: byteOffset(3),
        structuralPath: `system[0].text${evil}`,
        excerpt: evil,
        wastedTokens: tokenCount(10),
        wastedUsd: usd(0.01),
        wastedUsdByTier: new Map(),
        recommendation: `Move it ${evil}`
      }
    };
    const html = renderReportHtml(summarizeReport([call], [evil]), [finding]);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Move it &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.match(/&lt;script&gt;/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it("truncates long advice to a short excerpt", () => {
    const call = makeCall("a", { inputTokens: 1 });
    const finding: DiagnoseFinding = {
      sessionId: "s1",
      call,
      diagnosis: {
        cause: "ttl-expiry",
        invalidatedTiers: ["system"],
        byteOffset: byteOffset(0),
        structuralPath: "system",
        excerpt: "",
        wastedTokens: tokenCount(1),
        wastedUsd: usd(0),
        wastedUsdByTier: new Map(),
        recommendation: "x".repeat(500)
      }
    };
    const html = renderReportHtml(summarizeReport([call]), [finding]);
    expect(html).not.toContain("x".repeat(200));
    expect(html).toContain(`${"x".repeat(159)}…`);
  });

  it("stays self-contained with every section present", () => {
    const calls = [missCall("c1", 1000, "ts=1000"), missCall("c2", 2000, "ts=2000")];
    const html = renderReportHtml(summarizeReport(calls, ["w"]), findAllDiagnoses(calls));
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(?:href|src)\s*=\s*"https?:\/\//);
    expect(html).not.toMatch(/@import|url\(/i);
  });
});

describe("renderReportHtml edge cases", () => {
  it("orders calls with equal timestamps by call id", () => {
    const at = (id: string): LlmCall => ({
      ...makeCall("step", { inputTokens: 1 }),
      id,
      timestamp: 500
    });
    const html = renderReportHtml(summarizeReport([at("b"), at("c"), at("a"), at("b")]), []);
    const a = html.indexOf("<code>a</code>");
    const b = html.indexOf("<code>b</code>");
    const c = html.indexOf("<code>c</code>");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("prints an out-of-range timestamp verbatim instead of throwing on toISOString", () => {
    const call = { ...makeCall("step", { inputTokens: 1 }), id: "far", timestamp: 9e15 };
    const html = renderReportHtml(summarizeReport([call]), []);
    expect(html).toContain("<td>9000000000000000</td>");
  });

  it("labels an estimated wasted amount", () => {
    const call = makeCall("step", { inputTokens: 1 }, "gpt-5");
    const finding: DiagnoseFinding = {
      sessionId: "s1",
      call,
      diagnosis: {
        cause: "dynamic-prefix-content",
        invalidatedTiers: ["system"],
        byteOffset: byteOffset(3),
        structuralPath: "system",
        excerpt: "x",
        wastedTokens: tokenCount(100),
        wastedUsd: usd(0.0125),
        wastedUsdByTier: new Map(),
        wastedEstimate: true,
        recommendation: "keep the prefix stable"
      }
    };
    const html = renderReportHtml(summarizeReport([call]), [finding]);
    expect(html).toContain('<td class="num">$0.0125 (est.)</td>');
  });
});
