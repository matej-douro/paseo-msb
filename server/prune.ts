import { cleanupAll, type CleanupContext } from "./cleanup";

/**
 * A name that just failed a sweep is not retried for this long, so a transient
 * runtime or parent failure cannot be hammered by the UI's list polling.
 */
const DEFAULT_RETRY_AFTER_MS = 30_000;

/**
 * Cadence of the lightweight background sweep. It only reads the parent
 * directory and performs one exact lookup per listed child, and it never holds
 * the process open.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Starts one recurring task and returns its cancellation. */
export type PrunerScheduler = (
  task: () => void,
  intervalMs: number,
) => () => void;

const defaultScheduler: PrunerScheduler = (task, intervalMs) => {
  const timer = setInterval(task, intervalMs);
  // The DOM typing exposes a number, while Node's timer also has `unref()`.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
};

export interface RegistrationPruner {
  /**
   * Starts the one cleanup schedule. Repeated calls with a fresh context are
   * ignored, and a stopped pruner never starts again.
   */
  start(context: CleanupContext): void;
  /**
   * Triggers a sweep for the current authoritative state. It never blocks or
   * fails the caller; at most one sweep runs at a time.
   */
  schedule(context: CleanupContext): void;
  /** True while a sweep is running; tests and callers may observe it. */
  readonly running: boolean;
  /** Stops the schedule. Plugin teardown calls this before settling lanes. */
  stop(): void;
}

export interface RegistrationPrunerOptions {
  readonly retryAfterMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly scheduler?: PrunerScheduler;
}

/**
 * Background host-row cleanup. Every sweep lists this plugin's registrations
 * from the parent and removes each one whose child name no longer resolves to
 * its generation id. No candidate list is durable and no lifecycle lane is
 * needed: the rule is idempotent, so a sweep can never race a Create or Repair
 * into removing a live row.
 */
export function createRegistrationPruner(
  options: RegistrationPrunerOptions = {},
): RegistrationPruner {
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const scheduleTimer = options.scheduler ?? defaultScheduler;

  const retryAfter = new Map<string, number>();
  let context: CleanupContext | null = null;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  async function runSweep(active: CleanupContext): Promise<void> {
    const startedAt = now();
    for (const [name, until] of retryAfter) {
      if (until <= startedAt) retryAfter.delete(name);
    }

    const { removed, failed } = await cleanupAll(active, {
      skipNames: new Set(retryAfter.keys()),
    });

    for (const name of removed) retryAfter.delete(name);
    const until = startedAt + retryAfterMs;
    for (const name of failed) retryAfter.set(name, until);
  }

  function sweep(): void {
    if (stopped || inFlight !== null || !context) return;

    const active = context;
    inFlight = runSweep(active)
      .catch(() => {
        // The next sweep retries after the cooldown; rows stay visible.
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return {
    get running() {
      return inFlight !== null;
    },

    start(next) {
      if (stopped) return;
      context = next;
      if (cancelTimer) return;
      cancelTimer = scheduleTimer(sweep, intervalMs);
    },

    schedule(next) {
      if (stopped) return;
      context = next;
      sweep();
    },

    stop() {
      stopped = true;
      context = null;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
