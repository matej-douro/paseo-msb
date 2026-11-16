import type { LifecycleLanes } from "./lanes";
import {
  collectStaleRegistrationNames,
  pruneRegistrationOnlyNames,
  type ReconcileContext,
} from "./reconciler";

/**
 * A name that just failed a sweep is not retried for this long, so a transient
 * runtime or parent failure cannot be hammered by the UI's list polling.
 */
const DEFAULT_RETRY_AFTER_MS = 30_000;

/**
 * Cadence of the lightweight background sweep. It only reads the parent
 * directory and runtime inventory, and it never holds the process open.
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
  start(context: ReconcileContext): void;
  /**
   * Triggers a sweep for the current authoritative state. It never blocks or
   * fails the caller; at most one sweep runs at a time.
   */
  schedule(context: ReconcileContext): void;
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
 * Background stale-registration cleanup. Every sweep derives its own candidates
 * from the parent directory and runtime inventory, then runs each name through
 * the conservative reconciler path, which proves the exact generation is gone
 * before removing anything. No candidate list is durable; a plugin restart
 * rebuilds it from those two authoritative sources.
 */
export function createRegistrationPruner(
  lanes: LifecycleLanes,
  options: RegistrationPrunerOptions = {},
): RegistrationPruner {
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const scheduleTimer = options.scheduler ?? defaultScheduler;

  const retryAfter = new Map<string, number>();
  let context: ReconcileContext | null = null;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  async function runSweep(active: ReconcileContext): Promise<void> {
    const names = await collectStaleRegistrationNames(active);
    if (!names || names.length === 0) return;

    const startedAt = now();
    for (const [name, until] of retryAfter) {
      if (until <= startedAt) retryAfter.delete(name);
    }

    const targets = [...new Set(names)]
      .filter((name) => !retryAfter.has(name))
      .sort();
    if (targets.length === 0) return;

    const until = startedAt + retryAfterMs;
    for (const name of targets) retryAfter.set(name, until);

    const removed = await pruneRegistrationOnlyNames(active, targets, lanes);
    for (const name of removed) retryAfter.delete(name);
  }

  function sweep(): void {
    if (stopped || lanes.closed || inFlight !== null || !context) return;

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
      if (stopped || lanes.closed) return;
      context = next;
      if (cancelTimer) return;
      cancelTimer = scheduleTimer(sweep, intervalMs);
    },

    schedule(next) {
      if (stopped || lanes.closed) return;
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
