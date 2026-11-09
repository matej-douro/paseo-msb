export interface PollTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultPollTimers: PollTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type PollResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export interface Poller {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

export function createPoller<T>(
  load: () => Promise<T>,
  onResult: (result: PollResult<T>) => void,
  options: { intervalMs: number; timers?: PollTimers },
): Poller {
  const timers = options.timers ?? defaultPollTimers;
  let active = false;
  let timer: unknown = null;
  let current: Promise<void> | null = null;

  function schedule(): void {
    if (!active || timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void run();
    }, options.intervalMs);
  }

  function run(): Promise<void> {
    if (!active) return Promise.resolve();
    if (current) return current;

    current = (async () => {
      try {
        const value = await load();
        if (active) onResult({ ok: true, value });
      } catch (error) {
        if (active) onResult({ ok: false, error });
      } finally {
        current = null;
        schedule();
      }
    })();

    return current;
  }

  return {
    start() {
      if (active) return;
      active = true;
      void run();
    },
    stop() {
      active = false;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
    refresh() {
      if (!active) return Promise.resolve();
      return run();
    },
  };
}
