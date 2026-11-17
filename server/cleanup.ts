import { LifecycleAbortedError, bounded } from "./lanes";
import { pluginRegistrations, SetupFailure } from "./registration";
import type { SandboxHost } from "./sandbox";
import { isManagedRegistration, type HostDirectoryLike, type HostRegistrationLike } from "./status";

/** Bound for one cleanup lookup or parent removal; tests shorten it. */
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;

export interface CleanupContext {
  readonly hosts: {
    list(): Promise<HostDirectoryLike>;
    remove(registrationId: string): Promise<void>;
  };
  readonly sandboxHost: Pick<SandboxHost, "find">;
  /** Bound for one cleanup lookup or parent removal; tests shorten it. */
  readonly sdkCallTimeoutMs?: number;
  readonly timeoutMs?: number;
}

export interface NameCleanup {
  /** Owned registrations the parent listed for this child name. */
  readonly found: number;
  /** Registrations removed in this pass. */
  readonly removed: number;
  /** Registrations that could not be removed and will be retried. */
  readonly failed: number;
}

export interface CleanupOptions {
  readonly signal?: AbortSignal;
  /**
   * A generation the caller already destroyed or proved absent. Its row is
   * removed even when the runtime still reports the dying handle, which is the
   * normal destroy-then-unregister window. A different live generation always
   * keeps its own row.
   */
  readonly confirmedGoneId?: string | null;
  /** Names a caller is deliberately not retrying yet. */
  readonly skipNames?: ReadonlySet<string>;
}

function cleanupTimeout(context: CleanupContext): number {
  return context.sdkCallTimeoutMs ?? context.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
}

/** A parent-side removal that reports the row is already gone is a success. */
function isUnknownRegistration(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "host_unknown"
  );
}

/**
 * The one cleanup rule for this plugin's parent registrations: a row survives
 * only while an exact lookup of its child name returns that row's generation id.
 *
 * Every caller (Delete, Repair/recovery, the background sweep) uses this rule,
 * so there is no second ownership or staleness model to keep in sync. A lookup
 * failure removes nothing unless the caller already proved one generation gone.
 */
export async function cleanupName(
  context: CleanupContext,
  name: string,
  registrations: readonly HostRegistrationLike[],
  options: CleanupOptions = {},
): Promise<NameCleanup> {
  const confirmedGoneId = options.confirmedGoneId ?? null;
  // The child name is the identity, but an exact generation the caller already
  // confirmed is removable even when its metadata is missing or drifted.
  const rows = registrations.filter(
    (registration) =>
      isManagedRegistration(registration) &&
      (registration.metadata.name === name ||
        (confirmedGoneId !== null && registration.source?.key === confirmedGoneId)),
  );
  if (rows.length === 0) return { found: 0, removed: 0, failed: 0 };

  let liveId: string | null = null;
  let lookupFailed = false;

  try {
    const handle = await bounded(context.sandboxHost.find(name), {
      timeoutMs: cleanupTimeout(context),
      signal: options.signal,
    });
    liveId = handle?.id ?? null;
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    lookupFailed = true;
  }

  const removable = rows.filter((registration) => {
    const key = registration.source?.key ?? null;
    if (lookupFailed) return confirmedGoneId !== null && key === confirmedGoneId;
    // A live row for the same generation is kept, unless the caller proved that
    // generation gone. Any other row is stale: an older generation, or a row
    // whose sandbox no longer exists.
    return !(key !== null && key === liveId && key !== confirmedGoneId);
  });

  // A failed lookup leaves its rows in place and is reported for a later retry.
  let failed = lookupFailed ? rows.length - removable.length : 0;
  let removed = 0;
  for (const registration of removable) {
    try {
      await bounded(context.hosts.remove(registration.registrationId), {
        timeoutMs: cleanupTimeout(context),
        signal: options.signal,
      });
      removed += 1;
    } catch (error) {
      if (error instanceof LifecycleAbortedError) throw error;
      if (isUnknownRegistration(error)) {
        removed += 1;
        continue;
      }
      failed += 1;
    }
  }

  return { found: rows.length, removed, failed };
}

/**
 * Cleans every name the parent lists for this plugin. One directory read and one
 * exact runtime lookup per name; failures are left for the caller's retry.
 */
export async function cleanupAll(
  context: CleanupContext,
  options: CleanupOptions = {},
): Promise<{ readonly removed: readonly string[]; readonly failed: readonly string[] }> {
  let registrations: readonly HostRegistrationLike[];
  try {
    const directory = await bounded(context.hosts.list(), {
      timeoutMs: cleanupTimeout(context),
      signal: options.signal,
    });
    registrations = directory.hosts;
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    throw new SetupFailure("registrations_unavailable");
  }

  const names = new Set<string>();
  for (const registration of pluginRegistrations(registrations)) {
    const name = registration.metadata.name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }

  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of [...names].sort()) {
    if (options.skipNames?.has(name)) continue;
    const outcome = await cleanupName(context, name, registrations, options);
    if (outcome.removed > 0) removed.push(name);
    if (outcome.failed > 0) failed.push(name);
  }
  return { removed, failed };
}
