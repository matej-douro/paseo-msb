import {
  CREDENTIAL_ALLOWED_HOSTS,
  type CredentialName,
} from "../shared/constants";

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

/**
 * Resolves the selected fixed credential names against the parent environment.
 * Names without a non-empty value are reported, never substituted with an
 * empty secret.
 */
export function resolveSelectedSecrets(
  names: readonly CredentialName[],
  env: Readonly<Record<string, string | undefined>>,
): SecretResolution {
  const selected = [...new Set(names)];
  const secrets: ResolvedSecret[] = [];
  const missing: CredentialName[] = [];

  for (const name of selected) {
    const value = env[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push(name);
      continue;
    }
    secrets.push({ envVar: name, value, allowedHosts: CREDENTIAL_ALLOWED_HOSTS[name] });
  }

  return missing.length > 0 ? { status: "missing", missing } : { status: "ok", secrets };
}
