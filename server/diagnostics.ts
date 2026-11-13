import { z } from "zod";
import { CREDENTIAL_NAMES, MAX_ERROR_DETAIL_CHARS } from "../shared/constants";
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

const RawCredentialConfigSchema = z.looseObject({
  env: z.unknown().optional(),
  network: z.unknown().optional(),
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Extracts credential values persisted in a managed VM's microsandbox config.
 * They stay inside the parent process and are used only for redaction, so
 * removing or replacing a store value never disables redaction for an existing
 * VM.
 */
export function persistedCredentialValues(rawConfig: unknown): string[] {
  const parsed = RawCredentialConfigSchema.safeParse(rawConfig);
  if (!parsed.success) return [];

  const known = new Set<string>(CREDENTIAL_NAMES);
  const values = new Set<string>();

  const env = parsed.data.env;
  if (Array.isArray(env)) {
    for (const entry of env) {
      const item = record(entry);
      if (!item) continue;
      if (typeof item.name !== "string" || !known.has(item.name)) continue;
      if (typeof item.value === "string" && item.value.length > 0) values.add(item.value);
    }
  } else {
    const recordEnv = record(env);
    if (recordEnv) {
      for (const [name, value] of Object.entries(recordEnv)) {
        if (!known.has(name) || typeof value !== "string" || value.length === 0) continue;
        values.add(value);
      }
    }
  }

  const secretEntries = record(record(parsed.data.network)?.secrets)?.secrets;
  if (Array.isArray(secretEntries)) {
    for (const entry of secretEntries) {
      const item = record(entry);
      if (!item) continue;
      if (typeof item.envVar !== "string" || !known.has(item.envVar)) continue;
      if (typeof item.value === "string" && item.value.length > 0) values.add(item.value);
    }
  }

  return [...values].sort((left, right) => right.length - left.length);
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
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > MAX_ERROR_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_ERROR_DETAIL_CHARS - 1)}…`
    : normalized;
}
