declare const brand: unique symbol;
export type Brand<T, B extends string> = T & {
  readonly [brand]: B;
};
export type ByteOffset = Brand<number, "ByteOffset">;
export type TokenCount = Brand<number, "TokenCount">;
export type Usd = Brand<number, "Usd">;
export function byteOffset(value: number): ByteOffset {
  return value as ByteOffset;
}
export function tokenCount(value: number): TokenCount {
  return value as TokenCount;
}
export function usd(value: number): Usd {
  return value as Usd;
}
