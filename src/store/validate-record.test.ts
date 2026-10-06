import { describe, expect, it } from "vitest";
import { validateCallRecord } from "./validate-record.js";

function validRecord() {
  return {
    id: "a",
    sessionId: "s",
    stepName: "step",
    timestamp: 1000,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: "{}" },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    }
  };
}

function withUsage(overrides: Record<string, unknown>): Record<string, unknown> {
  const record = validRecord();
  return { ...record, usage: { ...record.usage, ...overrides } };
}

describe("validateCallRecord: cache-creation TTL split", () => {
  it("accepts a split that sums to at most the creation total", () => {
    const record = withUsage({
      cacheCreationInputTokens: 300,
      cacheCreation5mInputTokens: 100,
      cacheCreation1hInputTokens: 200
    });
    expect(validateCallRecord(record)).toEqual({ ok: true, record });
  });
  it.each([
    ["cacheCreation5mInputTokens", "abc"],
    ["cacheCreation1hInputTokens", "abc"],
    ["cacheCreation5mInputTokens", -1],
    ["cacheCreation1hInputTokens", null],
    ["cacheCreation5mInputTokens", Number.NaN]
  ])("rejects usage.%s = %j", (field, value) => {
    const result = validateCallRecord(withUsage({ cacheCreationInputTokens: 10, [field]: value }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(`usage.${field} must be a finite number >= 0`);
  });
  it("rejects a split whose sum exceeds cacheCreationInputTokens", () => {
    const result = validateCallRecord(
      withUsage({
        cacheCreationInputTokens: 100,
        cacheCreation5mInputTokens: 80,
        cacheCreation1hInputTokens: 40
      })
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("exceeds usage.cacheCreationInputTokens");
  });
});

describe("validateCallRecord", () => {
  it("accepts a well-formed record and returns it unchanged", () => {
    const record = validRecord();
    expect(validateCallRecord(record)).toEqual({ ok: true, record });
  });

  it("accepts a record with every optional field correctly typed", () => {
    const record = {
      ...validRecord(),
      parentCallId: "p",
      durationMs: 12,
      provider: "openai",
      params: {
        model: "m",
        toolChoice: "auto",
        thinking: { type: "enabled", budgetTokens: 1024 },
        effort: "high",
        contextManagement: "{}",
        inferenceGeo: "us",
        speed: "fast",
        imagesPresent: false,
        citationsEnabled: true,
        webSearchEnabled: false
      }
    };
    expect(validateCallRecord(record)).toEqual({ ok: true, record });
  });

  it("normalizes legacy thinking:false by dropping the field", () => {
    const record = { ...validRecord(), params: { model: "m", thinking: false } };
    expect(validateCallRecord(record)).toEqual({
      ok: true,
      record: { ...record, params: { model: "m" } }
    });
  });

  it("normalizes legacy thinking:true + thinkingBudgetTokens into ThinkingParams", () => {
    const record = {
      ...validRecord(),
      params: { model: "m", thinking: true, thinkingBudgetTokens: 2048 }
    };
    expect(validateCallRecord(record)).toEqual({
      ok: true,
      record: {
        ...record,
        params: { model: "m", thinking: { type: "enabled", budgetTokens: 2048 } }
      }
    });
  });

  it("rejects a record missing usage.cacheReadInputTokens instead of coercing to NaN", () => {
    const record = validRecord();
    const { cacheReadInputTokens: _omit, ...usage } = record.usage;
    const result = validateCallRecord({ ...record, usage });
    expect(result).toEqual({
      ok: false,
      reason: "usage.cacheReadInputTokens must be a finite number >= 0, got missing"
    });
  });

  it.each([
    ["negative", -1],
    ["string", "10"],
    ["null", null]
  ])("rejects a %s usage token count", (_label, value) => {
    const result = validateCallRecord(withUsage({ inputTokens: value }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("usage.inputTokens");
  });

  it.each(["id", "sessionId", "stepName"])("rejects a non-string %s", (field) => {
    const result = validateCallRecord({ ...validRecord(), [field]: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(field);
  });

  it.each([
    ["timestamp", { timestamp: "2026-01-01" }],
    ["params.model", { params: { model: 1 } }],
    ["payload.wireBody", { payload: { wireBody: {} } }],
    ["usage", { usage: null }],
    ["params", { params: [] }]
  ])("rejects an invalid %s", (field, patch) => {
    const result = validateCallRecord({ ...validRecord(), ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(field);
  });

  it.each([
    ["parentCallId", { parentCallId: 5 }],
    ["durationMs", { durationMs: "5" }],
    ["provider", { provider: "gemini" }],
    ["params.thinking", { params: { model: "m", thinking: "yes" } }],
    ["params.thinking.type", { params: { model: "m", thinking: { type: "always" } } }],
    [
      "params.thinking.budgetTokens",
      { params: { model: "m", thinking: { type: "enabled", budgetTokens: -1 } } }
    ],
    ["params.webSearchEnabled", { params: { model: "m", webSearchEnabled: "true" } }],
    ["params.thinkingBudgetTokens", { params: { model: "m", thinkingBudgetTokens: "1" } }]
  ])("rejects a mistyped optional field %s", (field, patch) => {
    const result = validateCallRecord({ ...validRecord(), ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(field);
  });

  it.each([null, [], "string", 3])("rejects a non-object record %j without throwing", (value) => {
    expect(validateCallRecord(value).ok).toBe(false);
  });
});
