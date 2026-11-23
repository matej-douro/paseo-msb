import { z } from "zod";

/**
 * Narrows an unknown value to a property bag. Arrays also pass, so callers that
 * read a list still test `Array.isArray` on the result. `null` is the only
 * non-object outcome.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * One env entry from the SDK's array shape; the CLI names the field `key`.
 * `name` and `key` fall back to undefined instead of failing the entry, so a
 * malformed sibling can never hide the valid one.
 */
export const EnvEntrySchema = z.looseObject({
  name: z.string().optional().catch(undefined),
  key: z.string().optional().catch(undefined),
  value: z.string(),
});
