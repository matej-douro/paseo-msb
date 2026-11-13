import { MAX_JOB_PAGES, MAX_JOB_PAGE_SIZE } from "../shared/constants";
import { bounded, LifecycleAbortedError, LifecycleTimeoutError } from "./lanes";
import { piInstallArgv } from "./pi-install";
import type {
  SandboxHandleLike,
  SandboxJobInfoLike,
  SandboxJobLike,
  SandboxJobPageLike,
} from "./sandbox";

/** Job inventory could not be read completely; callers must not start work. */
export class JobInventoryError extends Error {
  constructor(message = "job inventory unavailable") {
    super(message);
    this.name = "JobInventoryError";
  }
}

const ACTIVE_STATES = new Set(["starting", "running"]);
const FAILED_STATES = new Set(["failed", "lost"]);

/** Default bound for one detached-job SDK call. */
export const DEFAULT_JOB_CALL_TIMEOUT_MS = 30_000;

export interface JobCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function callTimeoutMs(options: JobCallOptions | undefined): number {
  return options?.timeoutMs ?? DEFAULT_JOB_CALL_TIMEOUT_MS;
}

/**
 * Reads the complete detached job inventory. `listJobsWith` is a manual
 * pagination API: a single call returns only one page. A repeated cursor, an
 * unreasonable page count, a timeout, or an abort is an inspection failure,
 * never "no jobs".
 */
export async function listAllJobs(
  handle: SandboxHandleLike,
  pageSize = MAX_JOB_PAGE_SIZE,
  options?: JobCallOptions,
): Promise<readonly SandboxJobInfoLike[]> {
  const jobs: SandboxJobInfoLike[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
    let result: SandboxJobPageLike;
    try {
      result = await bounded(
        handle.listJobsWith((builder) => {
          const configured = builder.all(true).limit(pageSize);
          return cursor ? configured.cursor(cursor) : configured;
        }),
        { timeoutMs: callTimeoutMs(options), signal: options?.signal },
      );
    } catch (error) {
      if (error instanceof LifecycleAbortedError) throw error;
      throw new JobInventoryError();
    }

    jobs.push(...result.items);

    if (!result.nextCursor) return jobs;
    if (seen.has(result.nextCursor)) throw new JobInventoryError("pagination repeated a cursor");
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  throw new JobInventoryError("pagination exceeded the page budget");
}

/** Exact argv match; `JobInfo.command` includes the executable and arguments. */
export function isPiInstallJob(job: SandboxJobInfoLike): boolean {
  const argv = piInstallArgv();
  if (job.command.length !== argv.length) return false;
  return job.command.every((value, index) => value === argv[index]);
}

export interface InstallJobInventory {
  readonly active: readonly SandboxJobInfoLike[];
  readonly failed: readonly SandboxJobInfoLike[];
  readonly succeeded: readonly SandboxJobInfoLike[];
}

export function classifyInstallJobs(
  jobs: readonly SandboxJobInfoLike[],
): InstallJobInventory {
  const piJobs = jobs.filter(isPiInstallJob);
  const active: SandboxJobInfoLike[] = [];
  const failed: SandboxJobInfoLike[] = [];
  const succeeded: SandboxJobInfoLike[] = [];

  for (const job of piJobs) {
    if (ACTIVE_STATES.has(job.state)) {
      active.push(job);
    } else if (job.state === "exited" && job.exitCode === 0) {
      succeeded.push(job);
    } else {
      failed.push(job);
    }
  }

  return { active, failed, succeeded };
}

export type InstallJobOutcome =
  | { readonly status: "succeeded"; readonly id: string }
  | { readonly status: "failed"; readonly id: string; readonly exitCode: number | null }
  | { readonly status: "running"; readonly id: string }
  | { readonly status: "unknown"; readonly id: string };

/**
 * Bounds a wait for one active job. Every SDK call is inside the race, so a
 * hung `getJob`, `wait`, or `inspect` cannot block Delete or shutdown. A
 * timeout means the job is still running, not that the install failed; the
 * reconciler must not start another job.
 */
export async function waitForInstallJob(
  handle: SandboxHandleLike,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<InstallJobOutcome> {
  let job: SandboxJobLike;
  try {
    job = await bounded(handle.getJob(id), { timeoutMs, signal });
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    return { status: "unknown", id };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      onAbort = () => reject(new LifecycleAbortedError());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });

    const waited = await Promise.race([
      job.wait().then(() => "finished" as const).catch(() => "unknown" as const),
      timeout,
      aborted,
    ]);

    if (waited === "timeout") return { status: "running", id };
    if (waited === "unknown") return { status: "unknown", id };

    const inspected = await bounded(job.inspect(), {
      timeoutMs,
      signal,
      timeoutError: () => new LifecycleTimeoutError(),
    }).catch((error: unknown) => {
      if (error instanceof LifecycleAbortedError) throw error;
      return null;
    });
    return inspected ? classifyJob(inspected) : { status: "unknown", id };
  } catch (error) {
    if (error instanceof LifecycleAbortedError) throw error;
    return { status: "unknown", id };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function classifyJob(info: SandboxJobInfoLike): InstallJobOutcome {
  if (info.state === "exited" && info.exitCode === 0) {
    return { status: "succeeded", id: info.id };
  }
  if (FAILED_STATES.has(info.state) || info.timedOut || info.failure != null) {
    return { status: "failed", id: info.id, exitCode: info.exitCode };
  }
  if (info.state === "exited") {
    return { status: "failed", id: info.id, exitCode: info.exitCode };
  }
  if (ACTIVE_STATES.has(info.state)) return { status: "running", id: info.id };
  return { status: "unknown", id: info.id };
}

/** The newest pinned install job, used to show bounded job logs. */
export async function findLatestInstallJob(
  handle: SandboxHandleLike,
  options?: JobCallOptions,
): Promise<SandboxJobInfoLike | null> {
  const jobs = (await listAllJobs(handle, MAX_JOB_PAGE_SIZE, options)).filter(isPiInstallJob);
  if (jobs.length === 0) return null;

  const sorted = [...jobs].sort(
    (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
  );
  return sorted[sorted.length - 1] ?? null;
}
