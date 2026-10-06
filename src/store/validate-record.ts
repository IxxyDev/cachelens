import type { LlmCall, RequestParams } from "../core/model/call.js";

export type ValidateRecordResult =
  | { readonly ok: true; readonly record: LlmCall }
  | { readonly ok: false; readonly reason: string };

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens"
] as const;

/** Optional split of cacheCreationInputTokens by TTL (Anthropic `usage.cache_creation`). */
const OPTIONAL_USAGE_SPLIT_FIELDS = [
  "cacheCreation5mInputTokens",
  "cacheCreation1hInputTokens"
] as const;

const isString = (value: unknown): boolean => typeof value === "string";
const isBoolean = (value: unknown): boolean => typeof value === "boolean";
const isFiniteNumber = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value);

const OPTIONAL_PARAM_CHECKS: readonly (readonly [string, string, (value: unknown) => boolean])[] = [
  ["toolChoice", "string", isString],
  ["effort", "string", isString],
  ["contextManagement", "string", isString],
  ["inferenceGeo", "string", isString],
  ["speed", "string", isString],
  ["imagesPresent", "boolean", isBoolean],
  ["citationsEnabled", "boolean", isBoolean],
  ["webSearchEnabled", "boolean", isBoolean],
  // Legacy (1.0.0) trace fields, normalized into `thinking` by validateCallRecord.
  ["thinkingBudgetTokens", "finite number", isFiniteNumber]
];

const THINKING_TYPES: readonly unknown[] = ["adaptive", "enabled", "disabled"];

function checkThinking(thinking: unknown): string | undefined {
  // A boolean is the legacy 1.0.0 encoding; it is accepted and normalized.
  if (thinking === undefined || typeof thinking === "boolean") return undefined;
  if (!isObject(thinking)) {
    return `params.thinking must be an object when present, got ${describe(thinking)}`;
  }
  const { type, budgetTokens } = thinking;
  if (!THINKING_TYPES.includes(type)) {
    return `params.thinking.type must be one of ${THINKING_TYPES.join(", ")}`;
  }
  if (budgetTokens !== undefined && !isNonNegativeFinite(budgetTokens)) {
    return `params.thinking.budgetTokens must be a finite number >= 0 when present, got ${describe(budgetTokens)}`;
  }
  return undefined;
}

/**
 * Rewrites the legacy `thinking: boolean` + `thinkingBudgetTokens` encoding into the current
 * ThinkingParams shape, matching what capture now records for the same request (no `thinking`
 * field when thinking was off).
 */
function normalizeLegacyParams(params: Record<string, unknown>): RequestParams {
  const { thinking, thinkingBudgetTokens, ...rest } = params;
  if (typeof thinking !== "boolean" && thinkingBudgetTokens === undefined) {
    return params as unknown as RequestParams;
  }
  if (typeof thinking !== "boolean") {
    return { ...rest, ...(thinking !== undefined ? { thinking } : {}) } as unknown as RequestParams;
  }
  if (!thinking) {
    return rest as unknown as RequestParams;
  }
  const budget =
    typeof thinkingBudgetTokens === "number" ? { budgetTokens: thinkingBudgetTokens } : {};
  return { ...rest, thinking: { type: "enabled", ...budget } } as unknown as RequestParams;
}

const PROVIDERS: readonly string[] = ["anthropic", "openai"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function describe(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "a non-finite number";
  return `a ${Array.isArray(value) ? "array" : typeof value}`;
}

function checkRecord(value: unknown): string | undefined {
  if (!isObject(value)) return `record must be a JSON object, got ${describe(value)}`;
  for (const field of ["id", "sessionId", "stepName"] as const) {
    if (typeof value[field] !== "string") {
      return `${field} must be a string, got ${describe(value[field])}`;
    }
  }
  const { timestamp, parentCallId, durationMs, provider, params, payload, usage } = value;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return `timestamp must be a finite number, got ${describe(timestamp)}`;
  }
  if (parentCallId !== undefined && typeof parentCallId !== "string") {
    return `parentCallId must be a string when present, got ${describe(parentCallId)}`;
  }
  if (durationMs !== undefined && !isNonNegativeFinite(durationMs)) {
    return `durationMs must be a finite number >= 0 when present, got ${describe(durationMs)}`;
  }
  if (provider !== undefined && (typeof provider !== "string" || !PROVIDERS.includes(provider))) {
    return `provider must be one of ${PROVIDERS.join(", ")} when present`;
  }

  if (!isObject(params)) return `params must be an object, got ${describe(params)}`;
  const { model, thinking } = params;
  if (typeof model !== "string") {
    return `params.model must be a string, got ${describe(model)}`;
  }
  for (const [field, type, isValid] of OPTIONAL_PARAM_CHECKS) {
    const fieldValue = params[field];
    if (fieldValue !== undefined && !isValid(fieldValue)) {
      return `params.${field} must be a ${type} when present, got ${describe(fieldValue)}`;
    }
  }
  const thinkingError = checkThinking(thinking);
  if (thinkingError !== undefined) return thinkingError;

  if (!isObject(payload)) return `payload must be an object, got ${describe(payload)}`;
  const { wireBody } = payload;
  if (typeof wireBody !== "string") {
    return `payload.wireBody must be a string, got ${describe(wireBody)}`;
  }

  if (!isObject(usage)) return `usage must be an object, got ${describe(usage)}`;
  for (const field of USAGE_FIELDS) {
    if (!isNonNegativeFinite(usage[field])) {
      return `usage.${field} must be a finite number >= 0, got ${describe(usage[field])}`;
    }
  }
  // The TTL split feeds cost math directly: a non-number here would print `~$NaN`, and a split
  // larger than the total it splits is internally inconsistent, so both reject the record.
  let splitTotal = 0;
  for (const field of OPTIONAL_USAGE_SPLIT_FIELDS) {
    const fieldValue = usage[field];
    if (fieldValue === undefined) continue;
    if (!isNonNegativeFinite(fieldValue)) {
      return `usage.${field} must be a finite number >= 0 when present, got ${describe(fieldValue)}`;
    }
    splitTotal += fieldValue;
  }
  const { cacheCreationInputTokens: creation } = usage as { cacheCreationInputTokens: number };
  if (splitTotal > creation) {
    return `usage.cacheCreation5mInputTokens + usage.cacheCreation1hInputTokens (${splitTotal}) exceeds usage.cacheCreationInputTokens (${creation})`;
  }
  return undefined;
}

/**
 * Validates an untrusted parsed JSONL record against the LlmCall shape. Never throws.
 * Legacy 1.0.0 `thinking` encodings are normalized; nothing else is coerced.
 */
export function validateCallRecord(value: unknown): ValidateRecordResult {
  const reason = checkRecord(value);
  if (reason !== undefined) return { ok: false, reason };
  const record = value as LlmCall;
  const params = normalizeLegacyParams(record.params as unknown as Record<string, unknown>);
  return { ok: true, record: params === record.params ? record : { ...record, params } };
}
