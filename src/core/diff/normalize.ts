export function normalizeSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeSortedKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = normalizeSortedKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
export function normalizedJsonEquals(a: string, b: string): boolean {
  try {
    const normalizedA = JSON.stringify(normalizeSortedKeys(JSON.parse(a)));
    const normalizedB = JSON.stringify(normalizeSortedKeys(JSON.parse(b)));
    return normalizedA === normalizedB;
  } catch {
    return false;
  }
}
