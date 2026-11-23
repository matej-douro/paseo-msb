import { z } from "zod";
import { CREDENTIAL_NAMES, MAX_ERROR_DETAIL_CHARS } from "../shared/constants";
import { asRecord, EnvEntrySchema } from "./decode";
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

/** One persisted network secret entry; only the redacted fields are read. */
const SecretEntrySchema = z.looseObject({
  envVar: z.string(),
  value: z.string().min(1),
});

/**
 * The native config has carried network secrets both as a flat array and wrapped
 * in a `{ secrets: [...] }` object. Accept either, so a creation-time credential
 * is never left out of the redaction set.
 */
const NetworkSecretsSchema = z
  .union([z.array(z.unknown()), z.looseObject({ secrets: z.array(z.unknown()) })])
  .transform((value) => (Array.isArray(value) ? value : value.secrets));

const NetworkSchema = z.looseObject({ secrets: z.unknown().optional() });

const RawCredentialConfigSchema = z.looseObject({
  env: z.unknown().optional(),
  network: z.unknown().optional(),
});

/** Persisted env entries from either the SDK array or the CLI record shape. */
function envEntries(env: unknown): { readonly name: string; readonly value: string }[] {
  if (Array.isArray(env)) {
    return env.flatMap((entry) => {
      const parsed = EnvEntrySchema.safeParse(entry);
      const name = parsed.success ? (parsed.data.name ?? parsed.data.key) : undefined;
      return parsed.success && name !== undefined && parsed.data.value.length > 0
        ? [{ name, value: parsed.data.value }]
        : [];
    });
  }

  const record = asRecord(env);
  if (!record) return [];
  return Object.entries(record).flatMap(([name, value]) =>
    typeof value === "string" && value.length > 0 ? [{ name, value }] : [],
  );
}

/** Persisted network secret entries in either shape the native config uses. */
function networkSecretEntries(network: unknown): { readonly envVar: string; readonly value: string }[] {
  const parsedNetwork = NetworkSchema.safeParse(network);
  if (!parsedNetwork.success) return [];

  const parsedSecrets = NetworkSecretsSchema.safeParse(parsedNetwork.data.secrets);
  if (!parsedSecrets.success) return [];

  return parsedSecrets.data.flatMap((entry) => {
    const parsed = SecretEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
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

  for (const entry of envEntries(parsed.data.env)) {
    if (known.has(entry.name)) values.add(entry.value);
  }
  for (const entry of networkSecretEntries(parsed.data.network)) {
    if (known.has(entry.envVar)) values.add(entry.value);
  }

  return [...values].sort((left, right) => right.length - left.length);
}

function describe(error: unknown): string {
  const explicit = (error as { detail?: unknown } | null)?.detail;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }

  if (error instanceof Error) {
    const message = error.message.length > 0 ? error.message : error.name;
    const head =
      message === error.name ? error.name : `${error.name}: ${message}`;
    const causes = causeChain(error);
    return causes.length > 0 ? `${head}: ${causes.join(" <- ")}` : head;
  }

  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "";

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function causeChain(error: Error, limit = 4): string[] {
  const messages: string[] = [];
  let current: unknown = error.cause;

  while (current instanceof Error && messages.length < limit) {
    const message = current.message || current.name;
    if (message.length > 0 && !messages.includes(message)) messages.push(message);
    current = current.cause;
  }

  return messages;
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
