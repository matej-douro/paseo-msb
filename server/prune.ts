import type { LifecycleLanes } from "./lanes";
import { pruneRegistrationOnlyNames, type ReconcileContext } from "./reconciler";

/**
 * A name that just failed a sweep is not retried for this long, so a transient
 * runtime or parent failure cannot be hammered by the UI's list polling.
 */
const DEFAULT_RETRY_AFTER_MS = 30_000;

export interface RegistrationPruner {
  /**
   * Starts a sweep for the registration-only names of one list projection.
   * It never blocks or fails the read; at most one sweep runs at a time.
   */
  schedule(context: ReconcileContext, names: readonly string[]): void;
  /** True while a sweep is running; tests and callers may observe it. */
  readonly running: boolean;
}

export interface RegistrationPrunerOptions {
  readonly retryAfterMs?: number;
  readonly now?: () => number;
}

/**
 * Lazy stale-registration cleanup driven by `vm.list`. Every name is still
 * pruned through the conservative reconciler path, which proves the exact
 * generation is gone before removing anything.
 */
export function createRegistrationPruner(
  lanes: LifecycleLanes,
  options: RegistrationPrunerOptions = {},
): RegistrationPruner {
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const now = options.now ?? Date.now;
  const retryAfter = new Map<string, number>();
  let inFlight: Promise<void> | null = null;

  return {
    get running() {
      return inFlight !== null;
    },

    schedule(context, names) {
      if (lanes.closed || inFlight !== null) return;

      const startedAt = now();
      for (const [name, until] of retryAfter) {
        if (until <= startedAt) retryAfter.delete(name);
      }

      const targets = [...new Set(names)].filter((name) => !retryAfter.has(name));
      if (targets.length === 0) return;

      const until = startedAt + retryAfterMs;
      for (const name of targets) retryAfter.set(name, until);

      inFlight = pruneRegistrationOnlyNames(context, targets, lanes)
        .then((removed) => {
          for (const name of removed) retryAfter.delete(name);
        })
        .catch(() => {
          // The next list retries after the cooldown; the row stays visible.
        })
        .finally(() => {
          inFlight = null;
        });
    },
  };
}
