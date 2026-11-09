import { CREDENTIALS } from "../shared/constants";
import type { CredentialName } from "../shared/contracts";

export interface HeaderSecretBinding {
  readonly env: CredentialName;
  readonly value: string;
  readonly hosts: readonly string[];
}

export type SecretResolution =
  | { readonly status: "ok"; readonly material: SecretMaterial }
  | { readonly status: "missing"; readonly names: readonly CredentialName[] }
  | { readonly status: "invalid"; readonly names: readonly string[] };

const CREDENTIAL_BY_NAME = new Map(
  CREDENTIALS.map((entry) => [entry.env as CredentialName, entry]),
);

export class SecretMaterial {
  readonly #bindings: HeaderSecretBinding[];
  readonly #values: string[];

  constructor(bindings: readonly HeaderSecretBinding[]) {
    this.#bindings = [...bindings];
    this.#values = bindings.map((binding) => binding.value);
  }

  bindings(): readonly HeaderSecretBinding[] {
    return this.#bindings;
  }

  redact(text: string): string {
    let redacted = text;
    for (const value of this.#values) {
      redacted = redacted.split(value).join("[redacted]");
    }
    return redacted;
  }

  dispose(): void {
    this.#bindings.length = 0;
    this.#values.length = 0;
  }
}

export function resolveSecretMaterial(
  selected: readonly CredentialName[],
  env: NodeJS.ProcessEnv,
): SecretResolution {
  const unique = [...new Set(selected)];
  const invalid = unique.filter((name) => !CREDENTIAL_BY_NAME.has(name));
  if (invalid.length > 0) {
    return { status: "invalid", names: invalid };
  }

  const missing = unique.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.length === 0;
  });
  if (missing.length > 0) {
    return { status: "missing", names: missing };
  }

  const bindings = unique.map((name) => {
    const mapping = CREDENTIAL_BY_NAME.get(name);
    if (!mapping) throw new Error("credential mapping changed during resolution");
    return {
      env: name,
      value: env[name] as string,
      hosts: mapping.hosts,
    };
  });

  return { status: "ok", material: new SecretMaterial(bindings) };
}
