/**
 * Shape of a redacted string leaf written by src/capture/redact.ts: `[R:<8 hex>:<N>]`,
 * where N is the original string's UTF-8 byte length. Lives in core so the serializer
 * can recognize placeholders without importing from capture.
 */
export const REDACTION_PLACEHOLDER_RE = /^\[R:[0-9a-f]{8}:\d+\]$/;
