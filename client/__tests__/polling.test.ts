import test from "node:test";
import assert from "node:assert/strict";
import { createPoller, type PollTimers } from "../hooks/polling";

class FakeTimers implements PollTimers {
  private nextId = 1;
  private callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  get pending(): number {
    return this.callbacks.size;
  }

  runNext(): void {
    const entry = this.callbacks.entries().next();
    if (entry.done) return;
    this.callbacks.delete(entry.value[0]);
    entry.value[1]();
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("polling runs only while started and stops on cleanup", async () => {
  const timers = new FakeTimers();
  let loads = 0;
  const results: unknown[] = [];
  const poller = createPoller(
    async () => {
      loads += 1;
      return loads;
    },
    (result) => results.push(result),
    { intervalMs: 2000, timers },
  );

  assert.equal(loads, 0);
  poller.start();
  assert.equal(loads, 1);
  await flush();
  assert.deepEqual(results, [{ ok: true, value: 1 }]);
  assert.equal(timers.pending, 1);

  timers.runNext();
  assert.equal(loads, 2);
  await flush();
  assert.equal(timers.pending, 1);

  poller.stop();
  assert.equal(timers.pending, 0);
  timers.runNext();
  assert.equal(loads, 2);
});

test("stop during a request drops its result and schedules nothing", async () => {
  const timers = new FakeTimers();
  let resolveLoad: ((value: string) => void) | null = null;
  const results: unknown[] = [];
  const poller = createPoller(
    () =>
      new Promise<string>((resolve) => {
        resolveLoad = resolve;
      }),
    (result) => results.push(result),
    { intervalMs: 2000, timers },
  );

  poller.start();
  poller.stop();
  assert.ok(resolveLoad);
  (resolveLoad as (value: string) => void)("late");
  await flush();

  assert.deepEqual(results, []);
  assert.equal(timers.pending, 0);
});

test("polling reports failures and keeps the loop alive", async () => {
  const timers = new FakeTimers();
  const results: unknown[] = [];
  const poller = createPoller(
    async () => {
      throw new Error("inventory unavailable");
    },
    (result) => results.push(result),
    { intervalMs: 2000, timers },
  );

  poller.start();
  await flush();
  assert.equal(results.length, 1);
  assert.equal((results[0] as { ok: boolean }).ok, false);
  assert.equal(timers.pending, 1);
});

test("refresh does not overlap an in-flight request", async () => {
  const timers = new FakeTimers();
  let loads = 0;
  let resolveLoad: ((value: number) => void) | null = null;
  const poller = createPoller(
    () => {
      loads += 1;
      return new Promise<number>((resolve) => {
        resolveLoad = resolve;
      });
    },
    () => undefined,
    { intervalMs: 2000, timers },
  );

  poller.start();
  const refresh = poller.refresh();
  assert.equal(loads, 1);
  assert.ok(resolveLoad);
  (resolveLoad as (value: number) => void)(1);
  await refresh;
  assert.equal(timers.pending, 1);
});
