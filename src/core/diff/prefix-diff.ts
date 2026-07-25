import { type ByteOffset, byteOffset } from "../model/types.js";
export interface PrefixDiffResult {
  readonly identical: boolean;
  readonly previousIsPrefixOfCurrent: boolean;
  readonly divergenceByteOffset: ByteOffset;
}
export function diffPrefix(previousText: string, currentText: string): PrefixDiffResult {
  const a = new TextEncoder().encode(previousText);
  const b = new TextEncoder().encode(currentText);
  const minLength = Math.min(a.length, b.length);
  let i = 0;
  while (i < minLength && a[i] === b[i]) {
    i++;
  }
  return {
    identical: i === a.length && i === b.length,
    previousIsPrefixOfCurrent: i === a.length,
    divergenceByteOffset: byteOffset(i)
  };
}
