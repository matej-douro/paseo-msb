/**
 * Narrows an unknown value to a property bag. Arrays also pass, so callers that
 * read a list still test `Array.isArray` on the result. `null` is the only
 * non-object outcome.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
