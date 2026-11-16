import { describe, expect, it } from "vitest";
import { MAX_MEMORY_MIB, RESOURCES_ENV_VAR } from "../../shared/constants";
import { safeError } from "../../shared/errors";
import { deleteVm } from "../../server/delete";
import type { LaneToken } from "../../server/lanes";
import { createMutationRegistry } from "../../server/mutations";
import { resizeVm, type ResizeContext } from "../../server/resize";
import type { SandboxModifyOptionsLike } from "../../server/sandbox";
import {
  fakeHostDirectory,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  type FakeSandboxOptions,
} from "./fake-runtime";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const ID = "sandbox_1";
const REQUEST_ID = "2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";

function token(): LaneToken {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    throwIfAborted() {
      if (controller.signal.aborted) throw new Error("aborted");
    },
  };
}

const CAP_CONFIG = () => ({
  resources: { cpus: 2, memoryMib: 4096, maxMemoryMib: MAX_MEMORY_MIB },
});

function v11Options(extra: Partial<FakeSandboxOptions> = {}): Partial<FakeSandboxOptions> {
  return {
    requestId: REQUEST_ID,
    requestedResources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
    resourcesSpecified: true,
    configExtras: CAP_CONFIG(),
    ...extra,
  };
}

function setup(
  options: Partial<FakeSandboxOptions> = {},
  overrides: Partial<ResizeContext> = {},
) {
  const calls: SandboxModifyOptionsLike[] = [];
  const handle = fakeSandbox({
    id: ID,
    name: NAME,
    status: "running",
    phase: "ready",
    ...options,
    modifyCalls: calls,
  });
  const context: ResizeContext = {
    hosts: new FakePaseoHosts({ directory: fakeHostDirectory([]) }),
    sandboxHost: new FakeSandboxCreator({ existing: handle }),
    mutations: createMutationRegistry(),
    timeoutMs: 100,
    pollMs: 1,
    resizeTimeoutMs: 100,
    mutationSettleMs: 10,
    ...overrides,
  };
  return { handle, calls, context };
}

function envValue(handle: ReturnType<typeof fakeSandbox>, name: string): string | undefined {
  const env = (handle.config() as { env?: unknown }).env;
  if (!Array.isArray(env)) return undefined;
  for (const entry of env) {
    const item = entry as { name?: string; key?: string; value?: unknown };
    if ((item.name ?? item.key) === name && typeof item.value === "string") return item.value;
  }
  return undefined;
}

describe("resizeVm", () => {
  it("returns unchanged without calling modify when the target matches observed and requested", async () => {
    const { calls, context } = setup(v11Options());

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 4096 },
      token(),
    );

    expect(result).toEqual({
      name: NAME,
      id: ID,
      result: "unchanged",
      resources: { cpus: 2, memoryMib: 4096, diskMib: 10240 },
      requestedResources: null,
    });
    expect(calls).toEqual([]);
  });

  it("clears a stale desired value without changing resources", async () => {
    const { handle, calls, context } = setup(
      v11Options({
        requestedResources: { cpus: 2, memoryMib: 8192, diskMib: 10240 },
      }),
    );

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 4096 },
      token(),
    );

    expect(result.result).toBe("applied");
    expect(result.resources).toEqual({ cpus: 2, memoryMib: 4096, diskMib: 10240 });
    expect(result.requestedResources).toBeNull();
    expect(calls).toEqual([
      {
        env: {
          [RESOURCES_ENV_VAR]: JSON.stringify({ cpus: 2, memoryMib: 4096, diskMib: 10240 }),
        },
        policy: "next_start",
      },
    ]);
    expect(envValue(handle, RESOURCES_ENV_VAR)).toBe(
      JSON.stringify({ cpus: 2, memoryMib: 4096, diskMib: 10240 }),
    );
  });

  it("applies live RAM growth on a V1.1 sandbox and persists the desired value", async () => {
    const { handle, calls, context } = setup(v11Options());

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192 },
      token(),
    );

    expect(result.result).toBe("applied");
    expect(result.resources).toEqual({ cpus: 2, memoryMib: 8192, diskMib: 10240 });
    expect(result.requestedResources).toBeNull();
    expect(calls[0]).toEqual({
      memory: 8192,
      policy: "no_restart",
    });
    expect(calls[0]).not.toHaveProperty("maxMemory");
    expect(calls[1]).toEqual({
      env: {
        [RESOURCES_ENV_VAR]: JSON.stringify({ cpus: 2, memoryMib: 8192, diskMib: 10240 }),
      },
      policy: "next_start",
    });
    expect(envValue(handle, RESOURCES_ENV_VAR)).toBe(
      JSON.stringify({ cpus: 2, memoryMib: 8192, diskMib: 10240 }),
    );
  });

  it("preserves a non-default CPU count through a RAM resize", async () => {
    const { handle, context } = setup(
      v11Options({
        requestedResources: { cpus: 4, memoryMib: 4096, diskMib: 10240 },
        configExtras: {
          resources: { cpus: 4, memoryMib: 4096, maxMemoryMib: MAX_MEMORY_MIB },
        },
      }),
    );

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192 },
      token(),
    );

    expect(result.result).toBe("applied");
    expect(result.resources).toEqual({ cpus: 4, memoryMib: 8192, diskMib: 10240 });
    expect(result.requestedResources).toBeNull();
    expect(envValue(handle, RESOURCES_ENV_VAR)).toBe(
      JSON.stringify({ cpus: 4, memoryMib: 8192, diskMib: 10240 }),
    );
  });

  it("grows the root disk without a restart", async () => {
    const { calls, context } = setup(v11Options());

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, diskMib: 20480 },
      token(),
    );

    expect(result.result).toBe("applied");
    expect(result.resources).toEqual({ cpus: 2, memoryMib: 4096, diskMib: 20480 });
    expect(calls[0]).toEqual({ rootDiskSize: 20480, policy: "no_restart" });
  });

  it("reports converging when the refreshed config does not confirm the target", async () => {
    const { context } = setup(
      v11Options({
        requestedResources: { cpus: 2, memoryMib: 8192, diskMib: 10240 },
        modifyApplies: false,
      }),
    );

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192 },
      token(),
    );

    expect(result.result).toBe("converging");
    expect(result.resources).toEqual({ cpus: 2, memoryMib: 4096, diskMib: 10240 });
    expect(result.requestedResources).toEqual({
      cpus: 2,
      memoryMib: 8192,
      diskMib: 10240,
    });
  });

  it("requires a restart for legacy RAM growth beyond the observed cap", async () => {
    const { calls, context } = setup({ configExtras: { resources: { cpus: 2, memoryMib: 4096 } } });

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192 },
      token(),
    );

    expect(result.result).toBe("restart_required");
    expect(calls).toEqual([]);
  });

  it("includes maxMemory only on a legacy restart", async () => {
    const { calls, context } = setup({ configExtras: { resources: { cpus: 2, memoryMib: 4096 } } });

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192, restart: true },
      token(),
    );

    expect(result.result).toBe("applied");
    expect(result.resources).toEqual({ cpus: 2, memoryMib: 8192, diskMib: 10240 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      memory: 8192,
      maxMemory: MAX_MEMORY_MIB,
      policy: "restart",
    });
    // A markerless legacy sandbox has no resource variables to update.
    expect(calls[0].env).toBeUndefined();
  });

  it("rejects a disk shrink and a null disk baseline", async () => {
    const shrink = setup(v11Options());
    await expect(
      resizeVm(shrink.context, { name: NAME, id: ID, diskMib: 8192 }, token()),
    ).rejects.toThrow(safeError("invalid_request").message);
    expect(shrink.calls).toEqual([]);

    const unknownDisk = setup(v11Options({ configExtras: { image: {} } }));
    await expect(
      resizeVm(unknownDisk.context, { name: NAME, id: ID, diskMib: 20480 }, token()),
    ).rejects.toThrow(safeError("invalid_request").message);
  });

  it("rejects a memory target with a null baseline", async () => {
    const { context } = setup(v11Options({ configExtras: { resources: { cpus: 2 } } }));

    await expect(
      resizeVm(context, { name: NAME, id: ID, memoryMib: 8192 }, token()),
    ).rejects.toThrow(safeError("invalid_request").message);
  });

  it("rejects a restart for a non-running generation without modifying it", async () => {
    const stopped = setup(v11Options({ status: "stopped" }));
    await expect(
      resizeVm(
        stopped.context,
        { name: NAME, id: ID, memoryMib: 8192, restart: true },
        token(),
      ),
    ).rejects.toThrow(safeError("invalid_request").message);
    expect(stopped.calls).toEqual([]);

    const paused = setup(v11Options({ status: "paused" }));
    await expect(
      resizeVm(
        paused.context,
        { name: NAME, id: ID, diskMib: 20480, restart: true },
        token(),
      ),
    ).rejects.toThrow(safeError("invalid_request").message);
  });

  it("rejects an unknown child and a generation mismatch", async () => {
    const missing = setup(
      {},
      { sandboxHost: new FakeSandboxCreator({ existing: null }) },
    );
    await expect(
      resizeVm(missing.context, { name: NAME, id: ID, memoryMib: 8192 }, token()),
    ).rejects.toThrow(safeError("id_mismatch").message);

    const mismatch = setup(v11Options());
    await expect(
      resizeVm(mismatch.context, { name: NAME, id: "sandbox_other", memoryMib: 8192 }, token()),
    ).rejects.toThrow(safeError("id_mismatch").message);
    expect(mismatch.calls).toEqual([]);
  });

  it("refuses while a native mutation is unsettled", async () => {
    const { calls, context } = setup(v11Options());
    context.mutations.track(NAME, new Promise(() => {}));

    await expect(
      resizeVm(context, { name: NAME, id: ID, memoryMib: 8192 }, token()),
    ).rejects.toThrow(safeError("mutation_pending").message);
    expect(calls).toEqual([]);
  });

  it("maps a restart-required signal without applying a restart", async () => {
    const { context } = setup(
      v11Options({
        modifyApplies: false,
        modifyPlan: () => ({
          applied: false,
          conflicts: [],
          changes: [{ field: "memory", disposition: "requires restart" }],
          resizeStatus: [],
        }),
      }),
    );

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192 },
      token(),
    );

    expect(result.result).toBe("restart_required");
  });

  it("fails a restart when the runtime still requires a restart", async () => {
    const { context } = setup(
      v11Options({
        modifyApplies: false,
        modifyPlan: () => ({
          applied: false,
          conflicts: [],
          changes: [{ field: "memory", disposition: "requires restart" }],
          resizeStatus: [],
        }),
      }),
    );

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192, restart: true },
      token(),
    );

    expect(result.result).toBe("resize_failed");
  });

  it("prefers restart_required over converging for a mixed request", async () => {
    const { context } = setup(
      v11Options({
        modifyApplies: false,
        modifyPlan: () => ({
          applied: false,
          conflicts: [],
          changes: [{ field: "root_disk_size", disposition: "requires restart" }],
          resizeStatus: [{ resource: "memory", state: "converging" }],
        }),
      }),
    );

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192, diskMib: 20480 },
      token(),
    );

    expect(result.result).toBe("restart_required");
  });

  it("reports a settled apply failure without leaking SDK text", async () => {
    const { context } = setup(v11Options({ modifyError: new Error("raw sdk failure: secret") }));

    const result = await resizeVm(
      context,
      { name: NAME, id: ID, memoryMib: 8192 },
      token(),
    );

    expect(result.result).toBe("resize_failed");
    expect(JSON.stringify(result)).not.toContain("raw sdk failure");
  });

  it("blocks a concurrent Delete while its native modify is unsettled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { context } = setup(v11Options({ modifyGate: gate }));

    const resize = resizeVm(context, { name: NAME, id: ID, memoryMib: 8192 }, token());
    const deadline = Date.now() + 1_000;
    while (!context.mutations.pending(NAME)) {
      if (Date.now() > deadline) throw new Error("native modify did not start");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(
      deleteVm(
        { ...context, deleteTimeoutMs: 20, mutationSettleMs: 10 },
        { name: NAME, id: ID, confirmName: NAME },
        token(),
      ),
    ).rejects.toThrow(safeError("mutation_pending").message);
    expect((context.sandboxHost as FakeSandboxCreator).destroyed).toEqual([]);

    release();
    await resize;
  });

  it("rejects a sandbox owned by another parent", async () => {
    const unowned = setup(v11Options({ parentId: "srv_other" }));
    await expect(
      resizeVm(unowned.context, { name: NAME, id: ID, memoryMib: 8192 }, token()),
    ).rejects.toThrow(safeError("id_mismatch").message);
    expect(unowned.context.hosts).toBeInstanceOf(FakePaseoHosts);
    expect(unowned.calls).toEqual([]);
  });
});
