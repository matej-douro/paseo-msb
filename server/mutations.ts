import { bounded, type BoundedOptions } from "./lanes";

/**
 * Short bound for a native mutation to settle after the wrapper stopped waiting.
 * A `bounded()` timeout or lifecycle abort is not settlement: the native call may
 * still be in flight, so the lane holds until this bound expires.
 */
export const MUTATION_SETTLE_MS = 5_000;

/**
 * Tracks raw native `modify()` promises per sandbox name. An entry clears only
 * when the native promise actually settles, never when the wrapper's timeout or
 * abort rejects.
 */
export interface MutationRegistry {
  /** Registers a raw native promise and returns it unchanged. */
  track<T>(name: string, operation: Promise<T>): Promise<T>;
  /** True while any registered native mutation is unsettled. */
  pending(name: string): boolean;
  /**
   * Waits for the currently registered promises. Returns false when the bound
   * expires with work still pending; the entries stay registered.
   */
  settle(name: string, timeoutMs: number): Promise<boolean>;
}

export function createMutationRegistry(): MutationRegistry {
  const pendingByName = new Map<string, Set<Promise<unknown>>>();

  function forget(name: string, operation: Promise<unknown>): void {
    const set = pendingByName.get(name);
    if (!set) return;
    set.delete(operation);
    if (set.size === 0) pendingByName.delete(name);
  }

  function hasPending(name: string): boolean {
    return (pendingByName.get(name)?.size ?? 0) > 0;
  }

  return {
    track(name, operation) {
      let set = pendingByName.get(name);
      if (!set) {
        set = new Set();
        pendingByName.set(name, set);
      }
      set.add(operation);
      void operation.then(
        () => forget(name, operation),
        () => forget(name, operation),
      );
      return operation;
    },

    pending(name) {
      return hasPending(name);
    },

    async settle(name, timeoutMs) {
      const operations = [...(pendingByName.get(name) ?? [])];
      if (operations.length === 0) return true;

      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        void Promise.allSettled(operations).then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
  };
}

/**
 * Runs one native mutation under the caller's bound, then holds the lane until
 * every registered native promise settles or the settlement bound expires. The
 * caller's timeout is not cancellation: an unsettled native call remains
 * registered for Delete and same-name allocation to observe.
 */
export async function runMutation<T>(
  registry: MutationRegistry,
  name: string,
  operation: () => Promise<T>,
  options: BoundedOptions,
  settleMs: number = MUTATION_SETTLE_MS,
): Promise<T> {
  try {
    return await bounded(operation(), options);
  } finally {
    await registry.settle(name, settleMs);
  }
}
