import {
  CREDENTIAL_ALLOWED_HOSTS,
  CREDENTIAL_NAMES,
  type CredentialName,
} from "../shared/constants";
import type { SecretsListResult } from "../shared/contracts";
import { safeError } from "../shared/errors";
import type { SecretsStore } from "./secrets-store";

/**
 * One resolved credential. Values live only in this process and are passed
 * straight to the microsandbox secret builder; they are never persisted in the
 * pending map, an RPC DTO, a label, or a log.
 */
export interface ResolvedSecret {
  readonly envVar: CredentialName;
  readonly value: string;
  readonly allowedHosts: readonly string[];
}

export type SecretResolution =
  | { readonly status: "ok"; readonly secrets: readonly ResolvedSecret[] }
  | { readonly status: "missing"; readonly missing: readonly CredentialName[] };

function usable(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolves the selected fixed credential names. A value stored in the plugin
 * takes precedence over the parent environment; neither is exposed here.
 */
export function resolveSelectedSecrets(
  names: readonly CredentialName[],
  env: Readonly<Record<string, string | undefined>>,
  stored: ReadonlyMap<CredentialName, string> = new Map(),
): SecretResolution {
  const selected = [...new Set(names)];
  const secrets: ResolvedSecret[] = [];
  const missing: CredentialName[] = [];

  for (const name of selected) {
    const storedValue = stored.get(name);
    const envValue = env[name];
    const value = usable(storedValue) ? storedValue : usable(envValue) ? envValue : null;

    if (!value) {
      missing.push(name);
      continue;
    }
    secrets.push({ envVar: name, value, allowedHosts: CREDENTIAL_ALLOWED_HOSTS[name] });
  }

  return missing.length > 0 ? { status: "missing", missing } : { status: "ok", secrets };
}

export function storedCredentialNames(
  stored: ReadonlyMap<CredentialName, string>,
): CredentialName[] {
  return CREDENTIAL_NAMES.filter((name) => usable(stored.get(name)));
}

export function hasEnvironmentCredential(
  env: Readonly<Record<string, string | undefined>>,
  name: CredentialName,
): boolean {
  return usable(env[name]);
}

/** Management view: names and sources only. Never values or store paths. */
export async function listSecrets(
  store: SecretsStore,
  env: Readonly<Record<string, string | undefined>>,
): Promise<SecretsListResult> {
  const stored = await store.read();
  if (stored.status !== "ok") {
    throw new Error(safeError("secrets_unavailable").message);
  }

  return {
    secrets: CREDENTIAL_NAMES.map((name) => ({
      name,
      stored: stored.values.has(name),
      environment: hasEnvironmentCredential(env, name),
    })),
  };
}
