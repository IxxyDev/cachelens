import { byteOffset } from "../model/types.js";
import { type Segment, byteLengthUtf8 } from "./segment-map.js";
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
export function canonicalPrefixComparisonText(canonical: CanonicalRequest): string {
  return canonical.text.endsWith("]") ? canonical.text.slice(0, -1) : canonical.text;
}
export function buildCanonicalRequest(wireBody: string): CanonicalRequest {
  const parsed = parseWireBody(wireBody);
  const writer = new OffsetWriter();
  const segments: Segment[] = [];
  const toolsStart = writer.currentOffset;
  writer.push(JSON.stringify(parsed.tools ?? []));
  segments.push({
    start: byteOffset(toolsStart),
    end: byteOffset(writer.currentOffset),
    tier: "tools",
    structuralPath: "tools"
  });
  const systemStart = writer.currentOffset;
  writeSystem(parsed.system, writer, segments);
  segments.push({
    start: byteOffset(systemStart),
    end: byteOffset(writer.currentOffset),
    tier: "system",
    structuralPath: "system"
  });
  const messagesStart = writer.currentOffset;
  writeMessages(parsed.messages, writer, segments);
  segments.push({
    start: byteOffset(messagesStart),
    end: byteOffset(writer.currentOffset),
    tier: "messages",
    structuralPath: "messages"
  });
  return { text: writer.text, byteLength: writer.currentOffset, segments };
}
function writeMessages(messages: unknown, writer: OffsetWriter, segments: Segment[]): void {
  if (!Array.isArray(messages)) {
    writer.push(JSON.stringify(messages ?? []));
    return;
  }
  writer.push("[");
  messages.forEach((message, index) => {
    if (index > 0) writer.push(",");
    const messageStart = writer.currentOffset;
    writeMessage(message, writer, segments, index);
    segments.push({
      start: byteOffset(messageStart),
      end: byteOffset(writer.currentOffset),
      tier: "messages",
      structuralPath: `messages[${index}]`
    });
  });
  writer.push("]");
}
function writeMessage(
  message: unknown,
  writer: OffsetWriter,
  segments: Segment[],
  messageIndex: number
): void {
  if (message === null || typeof message !== "object") {
    writer.push(JSON.stringify(message));
    return;
  }
  const obj = message as Record<string, unknown>;
  const priorityKeys = ["role", "content"];
  const remainingKeys = Object.keys(obj)
    .filter((key) => !priorityKeys.includes(key))
    .sort();
  const orderedKeys = [...priorityKeys, ...remainingKeys].filter((key) => key in obj);
  writer.push("{");
  orderedKeys.forEach((key, i) => {
    if (i > 0) writer.push(",");
    writer.push(`${JSON.stringify(key)}:`);
    if (key === "content" && Array.isArray(obj[key])) {
      writeContentBlocks(obj[key] as unknown[], writer, segments, messageIndex);
    } else {
      writer.push(JSON.stringify(obj[key]));
    }
  });
  writer.push("}");
}
function writeContentBlocks(
  blocks: readonly unknown[],
  writer: OffsetWriter,
  segments: Segment[],
  messageIndex: number
): void {
  writer.push("[");
  blocks.forEach((block, index) => {
    if (index > 0) writer.push(",");
    const blockStart = writer.currentOffset;
    writer.push(JSON.stringify(block));
    segments.push({
      start: byteOffset(blockStart),
      end: byteOffset(writer.currentOffset),
      tier: "messages",
      structuralPath: `messages[${messageIndex}].content[${index}]`
    });
  });
  writer.push("]");
}
function writeSystem(system: unknown, writer: OffsetWriter, segments: Segment[]): void {
  if (!Array.isArray(system)) {
    writer.push(JSON.stringify(system ?? null));
    return;
  }
  writer.push("[");
  system.forEach((block, index) => {
    if (index > 0) writer.push(",");
    const blockStart = writer.currentOffset;
    writeSystemBlock(block, writer, segments, index);
    segments.push({
      start: byteOffset(blockStart),
      end: byteOffset(writer.currentOffset),
      tier: "system",
      structuralPath: `system[${index}]`
    });
  });
  writer.push("]");
}
function writeSystemBlock(
  block: unknown,
  writer: OffsetWriter,
  segments: Segment[],
  index: number
): void {
  if (block === null || typeof block !== "object") {
    writer.push(JSON.stringify(block));
    return;
  }
  const obj = block as Record<string, unknown>;
  const priorityKeys = ["type", "text", "cache_control"];
  const remainingKeys = Object.keys(obj)
    .filter((key) => !priorityKeys.includes(key))
    .sort();
  const orderedKeys = [...priorityKeys, ...remainingKeys].filter((key) => key in obj);
  writer.push("{");
  orderedKeys.forEach((key, i) => {
    if (i > 0) writer.push(",");
    writer.push(`${JSON.stringify(key)}:`);
    if (key === "text" && typeof obj[key] === "string") {
      const valueStart = writer.currentOffset;
      writer.push(JSON.stringify(obj[key]));
      segments.push({
        start: byteOffset(valueStart),
        end: byteOffset(writer.currentOffset),
        tier: "system",
        structuralPath: `system[${index}].text`
      });
    } else {
      writer.push(JSON.stringify(obj[key]));
    }
  });
  writer.push("}");
}
