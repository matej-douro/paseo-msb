import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  CREDENTIAL_NAMES,
  PLUGIN_ID,
  type CredentialName,
} from "../shared/constants";

/**
 * Plugin-managed credential values for the five fixed names. Values live only
 * in this file and the plugin process; no RPC returns them.
 */
export interface StoredSecrets {
  readonly status: "ok" | "unavailable";
  readonly values: ReadonlyMap<CredentialName, string>;
}

export interface SecretsStore {
  readonly filePath: string;
  read(): Promise<StoredSecrets>;
  set(name: CredentialName, value: string): Promise<void>;
  /** Returns false when the name had no stored value. */
  delete(name: CredentialName): Promise<boolean>;
}

/** A store failure with no file contents or values in the message. */
export class SecretsStoreUnavailableError extends Error {
  constructor() {
    super("secrets store unavailable");
    this.name = "SecretsStoreUnavailableError";
  }
}

const FileSchema = z.looseObject({
  version: z.number().optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
});

const CREDENTIAL_SET: ReadonlySet<string> = new Set(CREDENTIAL_NAMES);

/**
 * `PASEO_MSB_SECRETS_FILE` overrides the location. Otherwise the store sits in
 * the Paseo home under `plugin-data`, never in the plugin source directory.
 */
export function defaultSecretsFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env.PASEO_MSB_SECRETS_FILE?.trim();
  if (explicit) return explicit;

  const home = env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
  return path.join(home, "plugin-data", PLUGIN_ID, "secrets.json");
}

export function createSecretsStore(filePath = defaultSecretsFilePath()): SecretsStore {
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readValues(): Promise<Map<CredentialName, string>> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return new Map();
      throw new SecretsStoreUnavailableError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Refuse to clobber a corrupt file from the UI.
      throw new SecretsStoreUnavailableError();
    }

    const decoded = FileSchema.safeParse(parsed);
    if (!decoded.success) throw new SecretsStoreUnavailableError();

    const values = new Map<CredentialName, string>();
    for (const [name, value] of Object.entries(decoded.data.secrets ?? {})) {
      if (!CREDENTIAL_SET.has(name)) continue;
      if (typeof value !== "string" || value.trim().length === 0) continue;
      values.set(name as CredentialName, value);
    }
    return values;
  }

  async function writeValues(values: ReadonlyMap<CredentialName, string>): Promise<void> {
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = {
      version: 1,
      secrets: Object.fromEntries(values),
    };

    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      // Owner-only permissions are part of the contract, not best effort.
      await fs.chmod(directory, 0o700);
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        mode: 0o600,
      });
      await fs.rename(temporary, filePath);
      await fs.chmod(filePath, 0o600);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw new SecretsStoreUnavailableError();
    }
  }

  return {
    filePath,

    async read() {
      try {
        return { status: "ok", values: await readValues() };
      } catch {
        return { status: "unavailable", values: new Map() };
      }
    },

    async set(name, value) {
      await serialize(async () => {
        const values = await readValues();
        values.set(name, value);
        await writeValues(values);
      });
    },

    async delete(name) {
      return serialize(async () => {
        const values = await readValues();
        const removed = values.delete(name);
        if (removed) await writeValues(values);
        return removed;
      });
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
