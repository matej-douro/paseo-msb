import {
  MetricsSampleSchema,
  type MetricsUnavailableReason,
  type VmMetricsInput,
  type VmMetricsResult,
} from "../shared/contracts";
import { safeError } from "../shared/errors";
import { asRecord } from "./decode";
import { bounded, LifecycleAbortedError, LifecycleTimeoutError } from "./lanes";
import {
  ownershipOf,
  type SandboxHandleLike,
  type SandboxHost,
  type SandboxMetricsLike,
} from "./sandbox";
import type { HostDirectoryLike } from "./status";

const DEFAULT_METRICS_TIMEOUT_MS = 5_000;
const DEFAULT_DIRECTORY_TIMEOUT_MS = 10_000;

/**
 * Small cache of the parent server id, refreshed by `vm.list`/`vm.detail`. A
 * metrics read falls back to one bounded directory read when the cache is empty.
 */
export interface ParentIdCache {
  remember(parentId: string): void;
  get(): string | null;
}

export function createParentIdCache(): ParentIdCache {
  let parentId: string | null = null;
  return {
    remember(value) {
      if (value.length > 0) parentId = value;
    },
    get() {
      return parentId;
    },
  };
}

/**
 * Coalesces raw `metrics()` promises per `(name, id)`. The entry clears only
 * when the native read settles, so an RPC timeout (or a second client) joins
 * the same call instead of starting another.
 */
export interface MetricsCoalescer {
  read(
    name: string,
    id: string,
    start: () => Promise<SandboxMetricsLike>,
  ): Promise<SandboxMetricsLike>;
}

export function createMetricsCoalescer(): MetricsCoalescer {
  const entries = new Map<string, Promise<SandboxMetricsLike>>();

  function forget(key: string, operation: Promise<SandboxMetricsLike>): void {
    if (entries.get(key) === operation) entries.delete(key);
  }

  return {
    read(name, id, start) {
      const key = `${name}\0${id}`;
      const existing = entries.get(key);
      if (existing) return existing;

      const operation = start();
      entries.set(key, operation);
      void operation.then(
        () => forget(key, operation),
        () => forget(key, operation),
      );
      return operation;
    },
  };
}

export interface MetricsDeps {
  readonly hosts: { list(): Promise<HostDirectoryLike> };
  readonly sandboxHost: SandboxHost;
  readonly parents: ParentIdCache;
  readonly coalescer: MetricsCoalescer;
  /** Bound for one exact lookup or native metrics read; tests shorten it. */
  readonly timeoutMs?: number;
  /** Bound for the empty-cache directory read; tests shorten it. */
  readonly directoryTimeoutMs?: number;
}

/**
 * `vm.metrics` reads one exact generation. It never reads inventory, jobs, or
 * logs and never surfaces raw SDK text.
 */
export async function readVmMetrics(
  deps: MetricsDeps,
  input: VmMetricsInput,
): Promise<VmMetricsResult> {
  const parentId = await resolveParentId(deps);
  if (!parentId) return unavailable("unavailable");

  let handle: SandboxHandleLike | null;
  try {
    handle = await bounded(deps.sandboxHost.find(input.name), {
      timeoutMs: timeoutMs(deps),
    });
  } catch {
    return unavailable("unavailable");
  }
  if (!handle) return unavailable("no_sandbox");
  if (handle.id !== input.id) throw new Error(safeError("id_mismatch").message);

  const ownership = ownershipOf(handle, parentId);
  if (ownership !== "owned") return unavailable("unavailable");

  if (handle.status !== "running") return unavailable("not_running");
  if (metricsDisabled(handle)) return unavailable("disabled");

  let operation: Promise<SandboxMetricsLike>;
  try {
    operation = deps.coalescer.read(input.name, input.id, () => handle.metrics());
  } catch (error) {
    return failure(error);
  }

  try {
    return sampleResult(await bounded(operation, { timeoutMs: timeoutMs(deps) }));
  } catch (error) {
    return failure(error);
  }
}

async function resolveParentId(deps: MetricsDeps): Promise<string | null> {
  const cached = deps.parents.get();
  if (cached) return cached;

  try {
    const directory = await bounded(deps.hosts.list(), {
      timeoutMs: deps.directoryTimeoutMs ?? DEFAULT_DIRECTORY_TIMEOUT_MS,
    });
    const parentId = directory.self.serverId;
    if (!parentId) return null;
    deps.parents.remember(parentId);
    return parentId;
  } catch {
    return null;
  }
}

function unavailable(reason: MetricsUnavailableReason): VmMetricsResult {
  return { status: "unavailable", reason };
}

/** Maps only fixed SDK codes. Raw messages never cross this boundary. */
function failure(error: unknown): VmMetricsResult {
  if (error instanceof LifecycleTimeoutError || error instanceof LifecycleAbortedError) {
    return unavailable("unavailable");
  }

  const code =
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;

  if (code === "metricsDisabled") return unavailable("disabled");
  if (code === "sandboxNotRunning") return unavailable("not_running");
  return unavailable("unavailable");
}

function sampleResult(sample: SandboxMetricsLike): VmMetricsResult {
  const timestamp =
    sample.timestamp instanceof Date && !Number.isNaN(sample.timestamp.getTime())
      ? sample.timestamp.toISOString()
      : null;
  if (timestamp === null) return unavailable("unavailable");

  const parsed = MetricsSampleSchema.safeParse({
    timestamp,
    cpuPercent: sample.cpuPercent,
    memoryBytes: sample.memoryBytes,
    memoryLimitBytes: sample.memoryLimitBytes,
    memoryAvailableBytes: sample.memoryAvailableBytes,
    diskReadBytes: sample.diskReadBytes,
    diskWriteBytes: sample.diskWriteBytes,
    netRxBytes: sample.netRxBytes,
    netTxBytes: sample.netTxBytes,
    upperUsedBytes: sample.upperUsedBytes,
    upperFreeBytes: sample.upperFreeBytes,
    uptimeMs: sample.uptimeMs,
  });

  return parsed.success ? { status: "available", sample: parsed.data } : unavailable("unavailable");
}

function metricsDisabled(handle: SandboxHandleLike): boolean {
  try {
    const config = asRecord(handle.config());
    const runtime = asRecord(config?.runtime);
    return (
      runtime?.disableMetricsSample === true || runtime?.disable_metrics_sample === true
    );
  } catch {
    return false;
  }
}

function timeoutMs(deps: MetricsDeps): number {
  return deps.timeoutMs ?? DEFAULT_METRICS_TIMEOUT_MS;
}
