/**
 * Canonical serialization policy (applies to `buildCanonicalRequest`):
 *
 * 1. Tier order is fixed: tools -> system -> messages. Every other top-level field
 *    (model, params, top-level `cache_control`, ...) is excluded from the text.
 * 2. STRUCTURAL objects have their keys sorted lexicographically (`Array.prototype.sort`
 *    order), recursively: messages[i], system[i], content blocks, tools[i] and their
 *    nested config. The server parses and re-renders these, so key order there never
 *    reaches the prompt and must not look like a prefix change.
 * 3. OPAQUE payloads are serialized verbatim, preserving key order, because the server
 *    renders them as JSON text into the prompt — key-order drift there is a real cache
 *    miss (nondeterministic-serialization). Opaque subtrees: tools[i].input_schema,
 *    a `tool_use` block's `input`, and a `tool_result` block's `content` when it is a
 *    JSON object (string or block-array content stays structural).
 * 4. Arrays keep their original element order everywhere.
 * 5. Redaction placeholders (`[R:<hash>:<N>]`, see src/capture/redact.ts) are padded with
 *    ASCII "_" to exactly N bytes when N exceeds the placeholder's length, so byte-based
 *    logic (offsets, tier sizes, min-cacheable proxies) sees the original string size.
 *    The hash prefix is kept, so distinct texts still diverge. This is exact unless the
 *    original string needed JSON escapes (quotes, backslashes, control characters).
 * 6. `cache_control` markers are stripped from the block levels where the vendor
 *    accepts them (tools[i], system[i], messages[i].content[j], and blocks nested in a
 *    tool_result's content array). They mark where the cached prefix ends but are not
 *    part of the cached content, so moving a breakpoint must not look like a prefix
 *    change. Breakpoints are located separately by `locateBreakpoints`, against offsets
 *    in this marker-free text.
 */
import { normalizeSortedKeys } from "../diff/normalize.js";
import { REDACTION_PLACEHOLDER_RE } from "../model/redaction.js";
import type { CacheTier } from "../model/tier.js";
import { byteOffset } from "../model/types.js";
import { byteLengthUtf8, type Segment } from "./segment-map.js";
export class CanonicalRequestParseError extends Error {
  constructor(cause: unknown) {
    super(
      `Failed to parse wire-body as JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "CanonicalRequestParseError";
  }
}
export interface CanonicalRequest {
  readonly text: string;
  readonly byteLength: number;
  readonly segments: readonly Segment[];
}
interface ParsedRequestBody {
  readonly tools?: unknown;
  readonly system?: unknown;
  readonly messages?: unknown;
}
class OffsetWriter {
  private parts: string[] = [];
  private offset = 0;
  push(text: string): void {
    this.parts.push(text);
    this.offset += byteLengthUtf8(text);
  }
  get currentOffset(): number {
    return this.offset;
  }
  get text(): string {
    return this.parts.join("");
  }
}
function parseWireBody(wireBody: string): ParsedRequestBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireBody);
  } catch (error) {
    throw new CanonicalRequestParseError(error);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new CanonicalRequestParseError(new Error("wire-body is not a JSON object"));
  }
  return parsed as ParsedRequestBody;
}
function expandRedactionPlaceholder(value: string): string {
  if (!REDACTION_PLACEHOLDER_RE.test(value)) return value;
  const originalBytes = Number(value.slice(value.lastIndexOf(":") + 1, -1));
  return originalBytes > value.length ? value.padEnd(originalBytes, "_") : value;
}
/** JSON.stringify that keeps key order and expands redaction placeholders to their original size. */
function stringifyLeaves(value: unknown): string {
  return JSON.stringify(value, (_key, leaf: unknown) =>
    typeof leaf === "string" ? expandRedactionPlaceholder(leaf) : leaf
  );
}
function canonicalJson(value: unknown): string {
  return stringifyLeaves(normalizeSortedKeys(value));
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function withoutCacheControl(block: unknown): unknown {
  if (!isPlainObject(block) || !("cache_control" in block)) return block;
  const { cache_control: _marker, ...rest } = block;
  return rest;
}
export function canonicalPrefixComparisonText(canonical: CanonicalRequest): string {
  return canonical.text.endsWith("]") ? canonical.text.slice(0, -1) : canonical.text;
}
export function buildCanonicalRequest(wireBody: string): CanonicalRequest {
  const parsed = parseWireBody(wireBody);
  const writer = new OffsetWriter();
  const segments: Segment[] = [];
  const toolsStart = writer.currentOffset;
  writeBlockArray(parsed.tools ?? [], "tools", writer, segments, writeTool);
  segments.push({
    start: byteOffset(toolsStart),
    end: byteOffset(writer.currentOffset),
    tier: "tools",
    structuralPath: "tools"
  });
  const systemStart = writer.currentOffset;
  writeBlockArray(parsed.system ?? null, "system", writer, segments, writeSystemBlock);
  segments.push({
    start: byteOffset(systemStart),
    end: byteOffset(writer.currentOffset),
    tier: "system",
    structuralPath: "system"
  });
  const messagesStart = writer.currentOffset;
  writeBlockArray(parsed.messages ?? [], "messages", writer, segments, writeMessage);
  segments.push({
    start: byteOffset(messagesStart),
    end: byteOffset(writer.currentOffset),
    tier: "messages",
    structuralPath: "messages"
  });
  return { text: writer.text, byteLength: writer.currentOffset, segments };
}
type BlockWriter = (
  block: unknown,
  writer: OffsetWriter,
  segments: Segment[],
  tier: CacheTier,
  structuralPath: string
) => void;
/** Writes `value` as an array with one `${path}[i]` segment per element; non-arrays pass through. */
function writeBlockArray(
  value: unknown,
  path: string,
  writer: OffsetWriter,
  segments: Segment[],
  writeBlock: BlockWriter,
  tier: CacheTier = path as CacheTier
): void {
  if (!Array.isArray(value)) {
    writer.push(canonicalJson(value));
    return;
  }
  writer.push("[");
  value.forEach((block, index) => {
    if (index > 0) writer.push(",");
    const blockStart = writer.currentOffset;
    const structuralPath = `${path}[${index}]`;
    writeBlock(block, writer, segments, tier, structuralPath);
    segments.push({
      start: byteOffset(blockStart),
      end: byteOffset(writer.currentOffset),
      tier,
      structuralPath
    });
  });
  writer.push("]");
}
/**
 * Rebuilds a structural block with sorted keys and no `cache_control`; values for which
 * `isOpaque` returns true are kept as-is (original key order), the rest are key-sorted.
 */
function structuralBlock(
  block: unknown,
  isOpaque: (key: string, value: unknown, blockType: unknown) => boolean,
  canonicalValue: (key: string, value: unknown) => unknown = (_key, value) =>
    normalizeSortedKeys(value)
): unknown {
  const stripped = withoutCacheControl(block);
  if (!isPlainObject(stripped)) return normalizeSortedKeys(stripped);
  const { type: blockType } = stripped;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(stripped).sort()) {
    const value = stripped[key];
    result[key] = isOpaque(key, value, blockType) ? value : canonicalValue(key, value);
  }
  return result;
}
function canonicalTool(tool: unknown): unknown {
  return structuralBlock(tool, (key) => key === "input_schema");
}
function canonicalContentBlock(block: unknown): unknown {
  return structuralBlock(
    block,
    (key, value, blockType) =>
      (blockType === "tool_use" && key === "input") ||
      (blockType === "tool_result" && key === "content" && isPlainObject(value)),
    (key, value) =>
      key === "content" && Array.isArray(value)
        ? value.map(canonicalContentBlock)
        : normalizeSortedKeys(value)
  );
}
function writeTool(tool: unknown, writer: OffsetWriter): void {
  writer.push(stringifyLeaves(canonicalTool(tool)));
}
function writeContentBlock(block: unknown, writer: OffsetWriter): void {
  writer.push(stringifyLeaves(canonicalContentBlock(block)));
}
/** Writes an object with sorted keys, letting `writeValue` claim specific keys. */
function writeSortedObject(
  obj: Record<string, unknown>,
  writer: OffsetWriter,
  writeValue: (key: string, value: unknown) => boolean
): void {
  writer.push("{");
  Object.keys(obj)
    .sort()
    .forEach((key, i) => {
      if (i > 0) writer.push(",");
      writer.push(`${JSON.stringify(key)}:`);
      if (!writeValue(key, obj[key])) writer.push(canonicalJson(obj[key]));
    });
  writer.push("}");
}
function writeMessage(
  message: unknown,
  writer: OffsetWriter,
  segments: Segment[],
  tier: CacheTier,
  structuralPath: string
): void {
  if (!isPlainObject(message)) {
    writer.push(canonicalJson(message));
    return;
  }
  writeSortedObject(message, writer, (key, value) => {
    if (key !== "content" || !Array.isArray(value)) return false;
    writeBlockArray(value, `${structuralPath}.content`, writer, segments, writeContentBlock, tier);
    return true;
  });
}
function writeSystemBlock(
  block: unknown,
  writer: OffsetWriter,
  segments: Segment[],
  tier: CacheTier,
  structuralPath: string
): void {
  const stripped = withoutCacheControl(block);
  if (!isPlainObject(stripped)) {
    writer.push(canonicalJson(stripped));
    return;
  }
  writeSortedObject(stripped, writer, (key, value) => {
    if (key !== "text" || typeof value !== "string") return false;
    const valueStart = writer.currentOffset;
    writer.push(stringifyLeaves(value));
    segments.push({
      start: byteOffset(valueStart),
      end: byteOffset(writer.currentOffset),
      tier,
      structuralPath: `${structuralPath}.text`
    });
    return true;
  });
}
