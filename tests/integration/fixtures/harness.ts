import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxHandle } from "microsandbox";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import {
  MANAGED_LABEL,
  PARENT_LABEL,
  PLUGIN_VERSION,
} from "../../../shared/constants";

export const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

export type MicrosandboxModule = typeof import("microsandbox");

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keeps the stored value out of failure messages and captured artifacts. */
export function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length > 0) output = output.split(secret).join("[redacted]");
  }
  return output;
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly secrets?: readonly string[];
}

/**
 * Polls until the probe returns a non-null value. Errors are retried because a
 * plugin reload and the routed child registration are both eventually
 * consistent.
 */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null>,
  options: WaitOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const intervalMs = options.intervalMs ?? 250;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    redact(
      `${label} was not observed before the deadline${detail}`,
      options.secrets ?? [],
    ),
  );
}

export async function connectDaemon(
  url: string,
  clientId: string,
  password?: string,
): Promise<DaemonClient> {
  const client = new DaemonClient({
    url,
    clientId,
    connectTimeoutMs: 15_000,
    ...(password ? { password } : {}),
  });
  await client.connect();
  return client;
}

export async function findPlugin(
  daemon: DaemonClient,
  pluginId: string,
): Promise<PluginListItem | null> {
  const plugins = await daemon.listPlugins();
  return plugins.find((plugin) => plugin.id === pluginId) ?? null;
}

export async function waitForPlugin(
  daemon: DaemonClient,
  pluginId: string,
): Promise<PluginListItem> {
  return waitFor(
    `plugin ${pluginId} to be running`,
    async () => {
      const plugin = await findPlugin(daemon, pluginId);
      return plugin?.status === "running" ? plugin : null;
    },
    { timeoutMs: 120_000, intervalMs: 500 },
  );
}

/**
 * Installs the current checkout when needed, then reloads so the release test
 * always exercises the source under test. Returns true only when this run
 * created the plugin installation.
 */
export async function ensureDirectoryPlugin(
  daemon: DaemonClient,
  pluginId: string,
  directory: string,
): Promise<{ readonly installedByTest: boolean; readonly plugin: PluginListItem }> {
  const existing = await findPlugin(daemon, pluginId);
  let installedByTest = false;

  if (!existing) {
    await daemon.installDirectoryPlugin(directory, pluginId);
    installedByTest = true;
  } else if (path.resolve(existing.path) !== path.resolve(directory)) {
    await daemon.installDirectoryPlugin(directory, pluginId);
    installedByTest = true;
  }

  await daemon.reloadPlugin(pluginId);
  return {
    installedByTest,
    plugin: await waitForPlugin(daemon, pluginId),
  };
}

export async function loadMicrosandbox(): Promise<MicrosandboxModule> {
  return import("microsandbox");
}

/** All labelled sandboxes for this parent, across cursor pages. */
export async function listManagedSandboxes(
  msb: MicrosandboxModule,
  parentId: string,
): Promise<SandboxHandle[]> {
  const handles: SandboxHandle[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = await msb.Sandbox.listWith((list) => {
      const filtered = list
        .labels({ [MANAGED_LABEL]: PLUGIN_VERSION, [PARENT_LABEL]: parentId })
        .limit(100);
      return cursor ? filtered.cursor(cursor) : filtered;
    });

    handles.push(...page.sandboxes);

    const next = page.nextCursor;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  return handles;
}

export interface SecretEntryConfig {
  readonly envVar?: string;
  readonly value?: string;
  readonly placeholder?: string | null;
  readonly allowedHosts?: readonly (string | { readonly exact?: string })[];
  readonly substitution?: {
    readonly headers?: boolean;
    readonly query?: boolean;
    readonly body?: boolean;
  };
}

/** Reads the persisted secret list from the SDK's camelCase sandbox config. */
export function secretEntries(config: unknown): SecretEntryConfig[] {
  const network = (config as { network?: { secrets?: unknown } } | null)?.network;
  const secrets = network?.secrets;

  if (Array.isArray(secrets)) return secrets as SecretEntryConfig[];
  const nested = (secrets as { secrets?: unknown } | null)?.secrets;
  return Array.isArray(nested) ? (nested as SecretEntryConfig[]) : [];
}

export function allowedHostNames(entry: SecretEntryConfig): string[] {
  return (entry.allowedHosts ?? [])
    .map((host) => (typeof host === "string" ? host : (host.exact ?? "")))
    .filter((host) => host.length > 0);
}

/**
 * Finds every property path whose string value contains the needle. The
 * release test uses this to prove the stored value appears only in the
 * microsandbox secret entry, never in env or another config field.
 */
export function findValuePaths(value: unknown, needle: string): string[] {
  const found: string[] = [];

  function visit(current: unknown, location: string): void {
    if (typeof current === "string") {
      if (current.includes(needle)) found.push(location);
      return;
    }
    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) {
        visit(item, `${location}[${index}]`);
      }
      return;
    }
    if (typeof current === "object" && current !== null) {
      for (const [key, entry] of Object.entries(current)) {
        visit(entry, `${location}.${key}`);
      }
    }
  }

  visit(value, "$");
  return found;
}

/** Reads guest environment variables as the non-root `paseo` user. */
export async function readGuestEnvironment(
  handle: SandboxHandle,
  names: readonly string[],
): Promise<string[]> {
  const sandbox = await handle.connect();
  const script = names
    .map((name) => `printf '%s\\n' "$${name}"`)
    .join("; ");
  const output = await sandbox.execWith("sh", (builder) =>
    builder.args(["-lc", script]).user("paseo"),
  );
  return output.stdout().split("\n").slice(0, names.length);
}

/** Runs one guest command as `paseo` and returns trimmed stdout. */
export async function runGuest(
  handle: SandboxHandle,
  script: string,
): Promise<string> {
  const sandbox = await handle.connect();
  const output = await sandbox.execWith("sh", (builder) =>
    builder.args(["-lc", script]).user("paseo"),
  );
  return output.stdout().trim();
}
