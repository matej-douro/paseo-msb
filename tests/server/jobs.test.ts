import { describe, expect, it } from "vitest";
import {
  classifyInstallJobs,
  isPiInstallJob,
  JobInventoryError,
  listAllJobs,
  waitForInstallJob,
} from "../../server/jobs";
import { LifecycleAbortedError } from "../../server/lanes";
import { piInstallArgv } from "../../server/pi-install";
import type {
  SandboxHandleLike,
  SandboxJobInfoLike,
} from "../../server/sandbox";
import { fakeSandbox } from "./fake-runtime";

function job(overrides: Partial<SandboxJobInfoLike> = {}): SandboxJobInfoLike {
  return {
    id: "job_1",
    command: piInstallArgv(),
    state: "exited",
    exitCode: 0,
    timedOut: false,
    failure: null,
    ...overrides,
  };
}

describe("job inventory", () => {
  it("follows every page and returns the complete inventory", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      jobs: [
        { id: "a", command: piInstallArgv(), state: "exited", exitCode: 0 },
        { id: "b", command: piInstallArgv(), state: "exited", exitCode: 1 },
        { id: "c", command: ["echo"], state: "running" },
      ],
    });

    const jobs = await listAllJobs(handle, 1);
    expect(jobs.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("fails closed when pagination repeats a cursor", async () => {
    const handle = {
      listJobsWith: async () => ({
        items: [job()],
        nextCursor: "same",
      }),
    } as unknown as SandboxHandleLike;

    await expect(listAllJobs(handle, 1)).rejects.toBeInstanceOf(JobInventoryError);
  });

  it("matches only the exact pinned install argv", () => {
    expect(isPiInstallJob(job())).toBe(true);
    expect(isPiInstallJob(job({ command: ["npm", "install"] }))).toBe(false);
    expect(
      isPiInstallJob(job({ command: [...piInstallArgv(), "--extra"] })),
    ).toBe(false);
  });

  it("classifies active, failed, and successful jobs without treating retries as conflict", () => {
    const inventory = classifyInstallJobs([
      job({ id: "old_fail", state: "exited", exitCode: 1 }),
      job({ id: "new_success", state: "exited", exitCode: 0 }),
      job({ id: "running", state: "running" }),
      job({ id: "other", command: ["echo"], state: "running" }),
    ]);

    expect(inventory.active.map((entry) => entry.id)).toEqual(["running"]);
    expect(inventory.failed.map((entry) => entry.id)).toEqual(["old_fail"]);
    expect(inventory.succeeded.map((entry) => entry.id)).toEqual(["new_success"]);
  });

  it("reports a still-running job instead of failing the install", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      jobs: [{ id: "job_1", command: piInstallArgv(), state: "running" }],
      jobStateAfterWait: "running",
    });

    await expect(waitForInstallJob(handle, "job_1", 10)).resolves.toEqual({
      status: "running",
      id: "job_1",
    });
  });

  it("aborts a bounded wait when the lifecycle lane is cancelled", async () => {
    const handle = {
      getJob: async () => ({
        inspect: async () => job({ state: "running" }),
        wait: () => new Promise<{ code: number }>(() => {}),
        logs: async () => [],
      }),
    } as unknown as SandboxHandleLike;

    const controller = new AbortController();
    const pending = waitForInstallJob(handle, "job_1", 60_000, controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(LifecycleAbortedError);
  });

  it("reports a confirmed non-zero exit as failed", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      jobs: [{ id: "job_1", command: piInstallArgv(), state: "exited", exitCode: 1 }],
    });

    await expect(waitForInstallJob(handle, "job_1", 100)).resolves.toEqual({
      status: "failed",
      id: "job_1",
      exitCode: 1,
    });
  });
});
