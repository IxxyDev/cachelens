import { describe, expect, it } from "vitest";
import type { LlmCall } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { renderReport, renderReportHtml, renderReportJson } from "./report.js";
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
    expect(renderReport([])).toContain("No calls");
  });
  it("includes each step, a total cost, and a cache hit rate", () => {
    const calls = [
      makeCall("planner", { inputTokens: 1000, outputTokens: 200 }),
      makeCall("executor", { cacheReadInputTokens: 900, inputTokens: 100 })
    ];
    const report = renderReport(calls);
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
    const report = renderReport(calls);
    expect(report.indexOf("expensive")).toBeLessThan(report.indexOf("cheap"));
  });
  it("reports a 100% hit rate when every input token was a cache read", () => {
    const calls = [makeCall("step", { cacheReadInputTokens: 500 })];
    expect(renderReport(calls)).toContain("100.0%");
  });
});
describe("renderReportJson", () => {
  it("returns zeroed totals for an empty trace", () => {
    expect(renderReportJson([])).toEqual({
      callCount: 0,
      totalUsd: 0,
      hitRate: 0,
      byStep: []
    });
  });
  it("matches costDistributionByStep ordering and totals", () => {
    const calls = [
      makeCall("cheap", { inputTokens: 10 }),
      makeCall("expensive", { inputTokens: 100000, outputTokens: 50000 })
    ];
    const result = renderReportJson(calls);
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
    const html = renderReportHtml(calls);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/<script\s/i);
    expect(html).not.toMatch(/(?:href|src)\s*=\s*"https?:\/\//);
    expect(html).toContain("planner");
  });
  it("escapes step names so untrusted trace data cannot inject markup", () => {
    const calls = [makeCall("<script>alert(1)</script>", { inputTokens: 10 })];
    const html = renderReportHtml(calls);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("renders a no-calls message for an empty trace without throwing", () => {
    const html = renderReportHtml([]);
    expect(html).toContain("No calls");
  });
});
