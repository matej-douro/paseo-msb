/**
 * One lifecycle lane per sandbox name. Create, recovery, Repair, and Delete all
 * enter the same lane, so at most one operation advances a name at a time.
 * Delete and plugin cleanup abort in-flight work; a cancelled queued operation
 * never starts, and `settle()` permanently closes every lane so no later call
 * can begin a side effect during or after plugin teardown.
 */
export class LifecycleAbortedError extends Error {
  constructor() {
    super("lifecycle operation aborted");
    this.name = "LifecycleAbortedError";
  }
}

/** A bounded SDK/parent wait expired; callers decide whether it is retryable. */
export class LifecycleTimeoutError extends Error {
  constructor() {
    super("lifecycle operation timed out");
    this.name = "LifecycleTimeoutError";
  }
}

export interface LaneToken {
  readonly signal: AbortSignal;
  throwIfAborted(): void;
}

export interface LifecycleLanes {
  readonly closed: boolean;
  run<T>(
    name: string,
    task: (token: LaneToken) => Promise<T>,
    options?: { readonly abortPrevious?: boolean },
  ): Promise<T>;
  abortAll(): void;
  /** Aborts and permanently rejects every future `run()`. */
  close(): void;
  settle(timeoutMs: number): Promise<void>;
}

interface LaneState {
  tail: Promise<void>;
  generation: number;
  cancelUpTo: number;
  current: AbortController | null;
  pending: Set<Promise<unknown>>;
}

export interface BoundedOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly timeoutError?: () => Error;
}

/**
 * Races any promise (SDK call, job wait, parent directory read) against a
 * timeout and an abort signal. The underlying operation may continue, but the
 * caller stops issuing further side effects as soon as this rejects.
 */
export function bounded<T>(operation: Promise<T>, options: BoundedOptions): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new LifecycleAbortedError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      apply();
    };

    const onAbort = (): void => finish(() => reject(new LifecycleAbortedError()));

    timer = setTimeout(
      () => finish(() => reject(options.timeoutError?.() ?? new LifecycleTimeoutError())),
      options.timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });

    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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
  let closed = false;

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

  function close(): void {
    closed = true;
    abortAll();
  }

  return {
    get closed() {
      return closed;
    },

    run(name, task, options = {}) {
      // Closure is permanent: an already-running multi-name operation cannot
      // queue work for a later name after plugin cleanup began.
      if (closed) return Promise.reject(new LifecycleAbortedError());

      const lane = laneFor(name);

      if (options.abortPrevious) {
        lane.cancelUpTo = lane.generation;
        lane.current?.abort();
      }

      lane.generation += 1;
      const generation = lane.generation;
      const previous = lane.tail;

      const result = previous.then(async () => {
        if (closed || generation <= lane.cancelUpTo) throw new LifecycleAbortedError();

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
    close,

    async settle(timeoutMs) {
      close();
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
