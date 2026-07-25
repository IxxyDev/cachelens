import type { ByteOffset } from "../model/types.js";
import { computeWastedUsd } from "../pricing/cost.js";
export { computeWastedUsd };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function excerptAroundByteOffset(text: string, offset: ByteOffset, context = 40): string {
  const bytes = encoder.encode(text);
  let start = Math.max(0, offset - context);
  let end = Math.min(bytes.length, offset + context);
  while (start > 0 && isContinuationByte(bytes[start])) start--;
  while (end < bytes.length && isContinuationByte(bytes[end])) end++;
  return decoder.decode(bytes.slice(start, end));
}
function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 192) === 128;
}
