import { describe, expect, it } from "vitest";
import {
  abortableSleep,
  bounded,
  createLifecycleLanes,
  LifecycleAbortedError,
  LifecycleTimeoutError,
} from "../../server/lanes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("lifecycle lanes", () => {
  it("serializes operations for the same name", async () => {
    const lanes = createLifecycleLanes();
    const gates = [deferred<void>(), deferred<void>()];
    const order: number[] = [];

    const first = lanes.run("paseo-a", async () => {
      order.push(1);
      await gates[0].promise;
      order.push(2);
    });
    const second = lanes.run("paseo-a", async () => {
      order.push(3);
      await gates[1].promise;
      order.push(4);
    });

    await Promise.resolve();
    expect(order).toEqual([1]);

    gates[0].resolve();
    await first;
    await Promise.resolve();
    expect(order).toEqual([1, 2, 3]);

    gates[1].resolve();
    await second;
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("runs different names concurrently", async () => {
    const lanes = createLifecycleLanes();
    const gate = deferred<void>();
    const started: string[] = [];

    const a = lanes.run("paseo-a", async () => {
      started.push("a");
      await gate.promise;
    });
    const b = lanes.run("paseo-b", async () => {
      started.push("b");
      await gate.promise;
    });

    await Promise.resolve();
    expect(started.sort()).toEqual(["a", "b"]);

    gate.resolve();
    await Promise.all([a, b]);
  });

  it("aborts the active operation and skips queued work", async () => {
    const lanes = createLifecycleLanes();
    const started = deferred<void>();
    const ranQueued: string[] = [];

    const active = lanes.run("paseo-a", async (token) => {
      started.resolve();
      await abortableSleep(5_000, token.signal);
    });

    const queued = lanes.run("paseo-a", async () => {
      ranQueued.push("queued");
    });

    await started.promise;
    lanes.abortAll();

    await expect(active).rejects.toBeInstanceOf(LifecycleAbortedError);
    await expect(queued).rejects.toBeInstanceOf(LifecycleAbortedError);
    expect(ranQueued).toEqual([]);
  });

  it("abortPrevious cancels the active operation before the new one runs", async () => {
    const lanes = createLifecycleLanes();
    const started = deferred<void>();
    const order: string[] = [];

    const active = lanes.run("paseo-a", async (token) => {
      order.push("first");
      started.resolve();
      await abortableSleep(5_000, token.signal);
      order.push("late");
    });

    await started.promise;
    const replacement = lanes.run(
      "paseo-a",
      async () => {
        order.push("second");
      },
      { abortPrevious: true },
    );

    await expect(active).rejects.toBeInstanceOf(LifecycleAbortedError);
    await replacement;
    expect(order).toEqual(["first", "second"]);
  });

  it("settles promptly after aborting all work", async () => {
    const lanes = createLifecycleLanes();
    const started = deferred<void>();

    const active = lanes.run("paseo-a", async (token) => {
      started.resolve();
      await abortableSleep(5_000, token.signal);
    });

    await started.promise;
    await expect(lanes.settle(100)).resolves.toBeUndefined();
    await expect(active).rejects.toBeInstanceOf(LifecycleAbortedError);
  });

  it("permanently rejects new work after settle closes the lanes", async () => {
    const lanes = createLifecycleLanes();
    const ran: string[] = [];

    await lanes.settle(100);

    expect(lanes.closed).toBe(true);
    await expect(
      lanes.run("paseo-a", async () => {
        ran.push("a");
      }),
    ).rejects.toBeInstanceOf(LifecycleAbortedError);
    expect(ran).toEqual([]);
  });

  it("stops an already-running multi-name operation from queueing later names", async () => {
    const lanes = createLifecycleLanes();
    const started = deferred<void>();
    const ran: string[] = [];

    const operation = (async () => {
      for (const name of ["paseo-a", "paseo-b"]) {
        await lanes.run(name, async (token) => {
          if (name === "paseo-a") {
            started.resolve();
            await abortableSleep(5_000, token.signal);
          }
          ran.push(name);
        });
      }
    })().catch(() => undefined);

    await started.promise;
    await lanes.settle(100);
    await operation;

    expect(ran).toEqual([]);
  });

  it("bounds and aborts waits on external calls", async () => {
    const never = new Promise<void>(() => {});

    await expect(bounded(never, { timeoutMs: 5 })).rejects.toBeInstanceOf(
      LifecycleTimeoutError,
    );

    const controller = new AbortController();
    const waiting = bounded(never, { timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(LifecycleAbortedError);
  });
});
