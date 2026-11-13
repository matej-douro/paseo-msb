import { MAX_ERROR_DETAIL_CHARS } from "../shared/constants";
import { redact } from "./logs";

/**
 * Formats a failure for the user. Raw SDK and guest text is bounded, stripped
 * of control characters, and redacted against every known credential value
 * before it can reach pending state, a label, an RPC, or a log.
 */
export function failureDetail(
  error: unknown,
  secrets: readonly string[] = [],
): string | null {
  const text = describe(error);
  if (!text) return null;

  const bounded = bound(redact(text, secrets));
  return bounded.length > 0 ? bounded : null;
}

function describe(error: unknown): string {
  const explicit = (error as { detail?: unknown } | null)?.detail;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }

  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error ? `: ${error.cause.message}` : "";
    const message = error.message.length > 0 ? error.message : error.name;
    return message === error.name
      ? `${error.name}${cause}`
      : `${error.name}: ${message}${cause}`;
  }

  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "";

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function bound(text: string): string {
  const normalized = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > MAX_ERROR_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_ERROR_DETAIL_CHARS - 1)}…`
    : normalized;
}
