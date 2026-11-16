import { describe, expect, it } from "vitest";
import { CPUS_MAX } from "../../shared/constants";
import { safeError } from "../../shared/errors";
import {
  createMetricsCoalescer,
  createParentIdCache,
  readVmMetrics,
  type MetricsDeps,
} from "../../server/metrics";
import type { SandboxMetricsLike } from "../../server/sandbox";
import {
  fakeHostDirectory,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  PARENT_ID,
  type FakeSandboxOptions,
} from "./fake-runtime";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const ID = "sandbox_1";
const TIMESTAMP = "2026-11-15T00:00:00.000Z";

function sample(overrides: Partial<SandboxMetricsLike> = {}): SandboxMetricsLike {
  return {
    cpuPercent: 12.5,
    memoryBytes: 1_048_576,
    memoryLimitBytes: 4_294_967_296,
    memoryAvailableBytes: null,
    diskReadBytes: 10,
    diskWriteBytes: 20,
    netRxBytes: 30,
    netTxBytes: 40,
    upperUsedBytes: null,
    upperFreeBytes: null,
    uptimeMs: 1_000,
    timestamp: new Date(TIMESTAMP),
    ...overrides,
  };
}

function setup(
  options: Partial<FakeSandboxOptions> = {},
  overrides: Partial<MetricsDeps> = {},
) {
  const metricsCalls: number[] = [];
  const handle = fakeSandbox({
    id: ID,
    name: NAME,
    status: "running",
    ...options,
    metricsCalls,
  });
  const parents = createParentIdCache();
  parents.remember(PARENT_ID);

  const deps: MetricsDeps = {
    hosts: new FakePaseoHosts({ directory: fakeHostDirectory([]) }),
    sandboxHost: new FakeSandboxCreator({ existing: handle }),
    parents,
    coalescer: createMetricsCoalescer(),
    timeoutMs: 50,
    directoryTimeoutMs: 50,
    ...overrides,
  };

  return { handle, metricsCalls, parents, deps };
}

describe("readVmMetrics", () => {
  it("returns the numeric sample with an ISO timestamp", async () => {
    const { deps } = setup({ metrics: sample() });

    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "available",
      sample: {
        timestamp: TIMESTAMP,
        cpuPercent: 12.5,
        memoryBytes: 1_048_576,
        memoryLimitBytes: 4_294_967_296,
        memoryAvailableBytes: null,
        diskReadBytes: 10,
        diskWriteBytes: 20,
        netRxBytes: 30,
        netTxBytes: 40,
        upperUsedBytes: null,
        upperFreeBytes: null,
        uptimeMs: 1_000,
      },
    });
  });

  it("reports a missing sandbox as no_sandbox", async () => {
    const { deps } = setup(
      {},
      { sandboxHost: new FakeSandboxCreator({ existing: null }) },
    );

    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "no_sandbox",
    });
  });

  it("reports not_running without reading metrics for a stopped generation", async () => {
    const { deps, metricsCalls } = setup({ status: "stopped" });

    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "not_running",
    });
    expect(metricsCalls).toHaveLength(0);
  });

  it("reports disabled from the config without reading metrics", async () => {
    const { deps, metricsCalls } = setup({
      configExtras: { runtime: { disableMetricsSample: true } },
    });

    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    expect(metricsCalls).toHaveLength(0);
  });

  it("maps metricsDisabled and sandboxNotRunning SDK codes", async () => {
    const disabled = setup({
      metricsError: Object.assign(new Error("raw disabled text"), { code: "metricsDisabled" }),
    });
    await expect(readVmMetrics(disabled.deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "disabled",
    });

    const stopped = setup({
      metricsError: Object.assign(new Error("raw stopped text"), {
        code: "sandboxNotRunning",
      }),
    });
    await expect(readVmMetrics(stopped.deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "not_running",
    });
  });

  it("maps an unknown read failure to unavailable without leaking text", async () => {
    const { deps } = setup({
      metricsError: new Error("no verified live metrics slot: secret detail"),
    });

    const result = await readVmMetrics(deps, { name: NAME, id: ID });
    expect(result).toEqual({ status: "unavailable", reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("shares one native read across timeout and repeated calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, metricsCalls } = setup({ metricsGate: gate, metrics: sample() });

    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(metricsCalls).toHaveLength(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The entry cleared on settlement, so a later call starts a fresh read.
    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toMatchObject({
      status: "available",
    });
    expect(metricsCalls).toHaveLength(2);
  });

  it.each([
    ["NaN", { cpuPercent: Number.NaN }],
    ["infinity", { cpuPercent: Number.POSITIVE_INFINITY }],
    ["negative", { diskWriteBytes: -1 }],
    ["over-bound CPU", { cpuPercent: 100 * CPUS_MAX + 1 }],
    ["invalid timestamp", { timestamp: new Date("not-a-date") }],
  ])("rejects %s as unavailable", async (_label, patch) => {
    const { deps } = setup({ metrics: sample(patch) });

    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
  });

  it("rejects a foreign parent's sandbox as unavailable", async () => {
    const { deps } = setup({ parentId: "srv_other" });

    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
  });

  it("rejects a generation mismatch with id_mismatch", async () => {
    const { deps } = setup();

    await expect(
      readVmMetrics(deps, { name: NAME, id: "sandbox_other" }),
    ).rejects.toThrow(safeError("id_mismatch").message);
  });

  it("reads the parent directory once when the cache is empty", async () => {
    let directoryReads = 0;
    const parents = createParentIdCache();
    const { deps } = setup(
      {},
      {
        parents,
        hosts: {
          list: async () => {
            directoryReads += 1;
            return fakeHostDirectory([]);
          },
        },
      },
    );

    await readVmMetrics(deps, { name: NAME, id: ID });
    await readVmMetrics(deps, { name: NAME, id: ID });

    expect(directoryReads).toBe(1);
    expect(parents.get()).toBe(PARENT_ID);
  });

  it("does not read inventory, jobs, or logs", async () => {
    const { deps } = setup({
      metrics: sample(),
      listJobsError: new Error("job inventory must not be read"),
      execError: new Error("exec must not be read"),
    });

    await expect(readVmMetrics(deps, { name: NAME, id: ID })).resolves.toMatchObject({
      status: "available",
    });
  });
});
