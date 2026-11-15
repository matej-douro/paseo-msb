import { describe, expect, it } from "vitest";
import { LifecycleAbortedError, LifecycleTimeoutError } from "../../server/lanes";
import { createMutationRegistry, runMutation } from "../../server/mutations";
import { markSandboxPhase } from "../../server/sandbox";
import { fakeSandbox } from "./fake-runtime";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mutation registry", () => {
  it("clears an entry only when the native promise settles", async () => {
    const registry = createMutationRegistry();
    const native = deferred();

    registry.track("vm", native.promise);
    expect(registry.pending("vm")).toBe(true);
    expect(await registry.settle("vm", 10)).toBe(false);
    expect(registry.pending("vm")).toBe(true);

    native.resolve();
    expect(await registry.settle("vm", 100)).toBe(true);
    expect(registry.pending("vm")).toBe(false);
  });

  it("clears a rejected native promise", async () => {
    const registry = createMutationRegistry();
    registry.track("vm", Promise.reject(new Error("native failure")));

    expect(await registry.settle("vm", 100)).toBe(true);
    expect(registry.pending("vm")).toBe(false);
  });

  it("tracks names independently", async () => {
    const registry = createMutationRegistry();
    const native = deferred();

    registry.track("vm-a", native.promise);
    expect(registry.pending("vm-a")).toBe(true);
    expect(registry.pending("vm-b")).toBe(false);
    expect(await registry.settle("vm-b", 10)).toBe(true);

    native.resolve();
    await registry.settle("vm-a", 100);
  });
});

describe("runMutation", () => {
  it("returns the operation result and clears the entry", async () => {
    const registry = createMutationRegistry();
    let settled = false;
    const operation = Promise.resolve("ok").finally(() => {
      settled = true;
    });

    await expect(
      runMutation(registry, "vm", () => operation, { timeoutMs: 100 }, 10),
    ).resolves.toBe("ok");
    expect(settled).toBe(true);
    expect(registry.pending("vm")).toBe(false);
  });

  it("does not treat a wrapper timeout as settlement", async () => {
    const registry = createMutationRegistry();
    const native = deferred();
    registry.track("vm", native.promise);

    await expect(
      runMutation(registry, "vm", () => native.promise, { timeoutMs: 10 }, 10),
    ).rejects.toBeInstanceOf(LifecycleTimeoutError);
    expect(registry.pending("vm")).toBe(true);

    native.resolve();
    expect(await registry.settle("vm", 100)).toBe(true);
    expect(registry.pending("vm")).toBe(false);
  });

  it("does not treat a lifecycle abort as settlement", async () => {
    const registry = createMutationRegistry();
    const native = deferred();
    const controller = new AbortController();
    registry.track("vm", native.promise);

    const run = runMutation(
      registry,
      "vm",
      () => native.promise,
      { timeoutMs: 1_000, signal: controller.signal },
      10,
    );
    controller.abort();

    await expect(run).rejects.toBeInstanceOf(LifecycleAbortedError);
    expect(registry.pending("vm")).toBe(true);

    native.resolve();
    await registry.settle("vm", 100);
    expect(registry.pending("vm")).toBe(false);
  });

  it("tracks a raw label modify until it settles", async () => {
    const registry = createMutationRegistry();
    const gate = deferred();
    const handle = fakeSandbox({ id: "sbx_1", name: "vm", modifyGate: gate.promise });

    const run = runMutation(
      registry,
      "vm",
      () =>
        markSandboxPhase(handle, "installing", {
          tracking: { mutations: registry, name: "vm" },
        }),
      { timeoutMs: 10 },
      10,
    );

    await expect(run).rejects.toBeInstanceOf(LifecycleTimeoutError);
    expect(registry.pending("vm")).toBe(true);

    gate.resolve();
    await registry.settle("vm", 100);
    expect(registry.pending("vm")).toBe(false);
  });

  it("clears a settled label write", async () => {
    const registry = createMutationRegistry();
    const handle = fakeSandbox({ id: "sbx_1", name: "vm" });

    await runMutation(
      registry,
      "vm",
      () =>
        markSandboxPhase(handle, "installing", {
          tracking: { mutations: registry, name: "vm" },
        }),
      { timeoutMs: 100 },
      10,
    );

    expect(registry.pending("vm")).toBe(false);
  });
});
