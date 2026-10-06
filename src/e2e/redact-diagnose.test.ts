import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REDACTION_PLACEHOLDER_RE, redactWireBody } from "../capture/redact.js";
import { findAllDiagnoses } from "../core/diagnose/run.js";
import type { LlmCall } from "../core/model/call.js";

const NAIVE_TRACE = fileURLToPath(
  new URL("../../fixtures/demo-agent/naive.jsonl", import.meta.url)
);
function loadRawTrace(): LlmCall[] {
  return readFileSync(NAIVE_TRACE, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LlmCall);
}
function redactTrace(calls: readonly LlmCall[]): LlmCall[] {
  return calls.map((call) => ({
    ...call,
    payload: { ...call.payload, wireBody: redactWireBody(call.payload.wireBody) }
  }));
}
describe("diagnose on a default-redacted trace (no --raw)", () => {
  const raw = loadRawTrace();
  const redacted = redactTrace(raw);
  it("the redacted trace really is redacted", () => {
    const system = JSON.parse(redacted[0]?.payload.wireBody ?? "{}").system;
    expect(system[0].text).toMatch(REDACTION_PLACEHOLDER_RE);
    for (const call of redacted) {
      expect(call.payload.wireBody).not.toContain("research assistant");
      expect(call.payload.wireBody).not.toContain("Current time");
    }
  });
  it("yields at least one finding and the same set of cause kinds as the raw trace", () => {
    const rawFindings = findAllDiagnoses(raw);
    const redactedFindings = findAllDiagnoses(redacted);
    expect(rawFindings.length).toBeGreaterThan(0);
    expect(redactedFindings.length).toBeGreaterThanOrEqual(1);
    const rawCauses = new Set(rawFindings.map((f) => f.diagnosis.cause));
    const redactedCauses = new Set(redactedFindings.map((f) => f.diagnosis.cause));
    expect([...redactedCauses].sort()).toEqual([...rawCauses].sort());
  });
  it("flags the same calls at the same structural paths as the raw trace", () => {
    const summarize = (calls: readonly LlmCall[]) =>
      findAllDiagnoses(calls).map((f) => ({
        callId: f.call.id,
        cause: f.diagnosis.cause,
        structuralPath: f.diagnosis.structuralPath
      }));
    expect(summarize(redacted)).toEqual(summarize(raw));
  });
});
