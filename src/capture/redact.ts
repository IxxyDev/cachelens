const REDACTED_PLACEHOLDER = "[REDACTED]";
const UNPARSEABLE_PLACEHOLDER = '{"redacted":"unparseable-body"}';
const REDACTED_KEYS = new Set(["text", "input", "thinking", "data"]);
const STRING_PAYLOAD_KEYS = new Set(["system", "content"]);
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
  return JSON.stringify(redactValue(parsed, false));
}
function redactValue(value: unknown, isPayloadKey: boolean): unknown {
  if (isPayloadKey) {
    return REDACTED_PLACEHOLDER;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, false));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const isPayload =
        REDACTED_KEYS.has(key) || (STRING_PAYLOAD_KEYS.has(key) && typeof entry === "string");
      result[key] = redactValue(entry, isPayload);
    }
    return result;
  }
  return value;
}
