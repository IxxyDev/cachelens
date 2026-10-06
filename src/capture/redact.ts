import { createHash } from "node:crypto";

const UNPARSEABLE_PLACEHOLDER = '{"redacted":"unparseable-body"}';

export { REDACTION_PLACEHOLDER_RE } from "../core/model/redaction.js";

const IDENTIFIER_RE = /^[A-Za-z0-9_\-:.]+$/;
const MAX_IDENTIFIER_LENGTH = 64;
export function redactionPlaceholder(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return `[R:${digest}:${bytes.byteLength}]`;
}
/**
 * Path-based redaction. Each rule knows the structural position it is applied at:
 * string values survive only where a rule explicitly keeps them (model, roles, block
 * types, tool names, schema structure, cache_control, identifier-shaped ids). Any
 * position without a rule falls back to `hashed`: every string becomes a placeholder,
 * while keys, numbers, booleans, null and array shapes are kept. Inside caller-supplied
 * payload objects (`opaque`) keys and numbers are hashed too.
 */
type Rule = (value: unknown) => unknown;
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });
}
const hashed: Rule = (value) => {
  if (typeof value === "string") return redactionPlaceholder(value);
  if (Array.isArray(value)) return value.map(hashed);
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) setOwn(result, key, hashed(entry));
    return result;
  }
  return value;
};
const opaque: Rule = (value) => {
  if (typeof value === "string") return redactionPlaceholder(value);
  if (typeof value === "number") return redactionPlaceholder(String(value));
  if (Array.isArray(value)) return value.map(opaque);
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      setOwn(result, redactionPlaceholder(key), opaque(entry));
    }
    return result;
  }
  return value;
};
const keep: Rule = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(keep);
  return hashed(value);
};
const identifier: Rule = (value) =>
  typeof value === "string" && value.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER_RE.test(value)
    ? value
    : hashed(value);
function object(rules: ReadonlyMap<string, Rule>): Rule {
  return (value) => {
    if (!isPlainObject(value)) return hashed(value);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      setOwn(result, key, (rules.get(key) ?? hashed)(entry));
    }
    return result;
  };
}
function arrayOf(rule: Rule): Rule {
  return (value) => (Array.isArray(value) ? value.map(rule) : hashed(value));
}
function recordOf(rule: Rule): Rule {
  return (value) => {
    if (!isPlainObject(value)) return hashed(value);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) setOwn(result, key, rule(entry));
    return result;
  };
}
const cacheControl = object(
  new Map([
    ["type", keep],
    ["ttl", keep]
  ])
);
const schema: Rule = (value) => (Array.isArray(value) ? value.map(schema) : schemaObject(value));
const schemaObject: Rule = object(
  new Map<string, Rule>([
    ["type", keep],
    ["format", keep],
    ["required", keep],
    ["properties", recordOf(schema)],
    ["patternProperties", recordOf(schema)],
    ["$defs", recordOf(schema)],
    ["definitions", recordOf(schema)],
    ["items", schema],
    ["prefixItems", schema],
    ["additionalProperties", schema],
    ["anyOf", schema],
    ["oneOf", schema],
    ["allOf", schema],
    ["not", schema]
  ])
);
const imageSource = object(
  new Map([
    ["type", keep],
    ["media_type", keep]
  ])
);
const BASE_BLOCK_RULES: readonly (readonly [string, Rule])[] = [
  ["type", keep],
  ["id", identifier],
  ["tool_use_id", identifier],
  ["cache_control", cacheControl],
  ["source", imageSource]
];
const contentBlock: Rule = (value) => {
  const { type } = isPlainObject(value) ? value : {};
  const blockType = typeof type === "string" ? type : "";
  const rules = new Map<string, Rule>(BASE_BLOCK_RULES);
  if (blockType.endsWith("tool_use")) {
    rules.set("name", keep);
    rules.set("input", opaque);
  }
  if (blockType.endsWith("tool_result")) {
    rules.set("content", (content) =>
      Array.isArray(content)
        ? content.map(contentBlock)
        : isPlainObject(content)
          ? opaque(content)
          : hashed(content)
    );
  }
  return object(rules)(value);
};
const message = object(
  new Map<string, Rule>([
    ["role", keep],
    ["type", keep],
    [
      "content",
      (content) => (Array.isArray(content) ? content.map(contentBlock) : hashed(content))
    ],
    ["tool_call_id", identifier],
    ["call_id", identifier],
    ["id", identifier],
    [
      "tool_calls",
      arrayOf(
        object(
          new Map<string, Rule>([
            ["id", identifier],
            ["type", keep],
            ["function", object(new Map([["name", keep]]))]
          ])
        )
      )
    ]
  ])
);
const tool = object(
  new Map<string, Rule>([
    ["name", keep],
    ["type", keep],
    ["cache_control", cacheControl],
    ["input_schema", schema],
    [
      "function",
      object(
        new Map<string, Rule>([
          ["name", keep],
          ["parameters", schema]
        ])
      )
    ]
  ])
);
const systemBlock = object(
  new Map<string, Rule>([
    ["type", keep],
    ["cache_control", cacheControl]
  ])
);
const requestRoot = object(
  new Map<string, Rule>([
    ["model", keep],
    ["id", identifier],
    [
      "tool_choice",
      object(
        new Map<string, Rule>([
          ["type", keep],
          ["name", keep],
          ["function", object(new Map([["name", keep]]))]
        ])
      )
    ],
    ["thinking", object(new Map([["type", keep]]))],
    ["cache_control", cacheControl],
    ["system", arrayOf(systemBlock)],
    ["messages", arrayOf(message)],
    ["input", arrayOf(message)],
    ["tools", arrayOf(tool)],
    ["metadata", opaque],
    [
      "prompt",
      object(
        new Map<string, Rule>([
          ["id", identifier],
          ["variables", opaque]
        ])
      )
    ],
    ["stop_reason", keep],
    ["finish_reason", keep],
    ["service_tier", keep],
    ["object", keep],
    ["status", keep]
  ])
);
export function redactRequestBody(body: unknown): unknown {
  return requestRoot(body);
}
export function redactWireBody(
  wireBody: string,
  options?: {
    readonly raw?: boolean;
  }
): string {
  if (options?.raw) {
    return wireBody;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireBody);
  } catch {
    return UNPARSEABLE_PLACEHOLDER;
  }
  return JSON.stringify(redactRequestBody(parsed));
}
