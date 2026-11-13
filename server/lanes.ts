/**
 * One lifecycle lane per sandbox name. Create, recovery, Repair, and Delete all
 * enter the same lane, so at most one operation advances a name at a time.
 * Delete and plugin cleanup abort in-flight work; a cancelled queued operation
 * never starts.
 */
export class LifecycleAbortedError extends Error {
  constructor() {
    super("lifecycle operation aborted");
    this.name = "LifecycleAbortedError";
  }
}

export interface LaneToken {
  readonly signal: AbortSignal;
  throwIfAborted(): void;
}

export interface LifecycleLanes {
  run<T>(
    name: string,
    task: (token: LaneToken) => Promise<T>,
    options?: { readonly abortPrevious?: boolean },
  ): Promise<T>;
  abortAll(): void;
  settle(timeoutMs: number): Promise<void>;
}

interface LaneState {
  tail: Promise<void>;
  generation: number;
  cancelUpTo: number;
  current: AbortController | null;
  pending: Set<Promise<unknown>>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new LifecycleAbortedError());
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new LifecycleAbortedError());
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createLifecycleLanes(): LifecycleLanes {
  const lanes = new Map<string, LaneState>();

  function laneFor(name: string): LaneState {
    const existing = lanes.get(name);
    if (existing) return existing;

    const lane: LaneState = {
      tail: Promise.resolve(),
      generation: 0,
      cancelUpTo: 0,
      current: null,
      pending: new Set(),
    };
    lanes.set(name, lane);
    return lane;
  }

  function abortAll(): void {
    for (const lane of lanes.values()) {
      lane.cancelUpTo = lane.generation;
      lane.current?.abort();
    }
  }

  return {
    run(name, task, options = {}) {
      const lane = laneFor(name);

      if (options.abortPrevious) {
        lane.cancelUpTo = lane.generation;
        lane.current?.abort();
      }

      lane.generation += 1;
      const generation = lane.generation;
      const previous = lane.tail;

      const result = previous.then(async () => {
        if (generation <= lane.cancelUpTo) throw new LifecycleAbortedError();

        const controller = new AbortController();
        lane.current = controller;
        const token: LaneToken = {
          signal: controller.signal,
          throwIfAborted() {
            if (controller.signal.aborted) throw new LifecycleAbortedError();
          },
        };

        try {
          return await task(token);
        } finally {
          if (lane.current === controller) lane.current = null;
        }
      });

      lane.tail = result.then(
        () => undefined,
        () => undefined,
      );
      lane.pending.add(result);
      void result.finally(() => lane.pending.delete(result)).catch(() => undefined);
      return result;
    },

    abortAll,

    async settle(timeoutMs) {
      abortAll();
      const pending = [...lanes.values()].flatMap((lane) => [...lane.pending]);
      if (pending.length === 0) return;

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
