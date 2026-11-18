import { describe, expect, it } from "vitest";
import {
  JobInventoryError,
  listAllJobs,
  waitForJob,
} from "../../server/jobs";
import { LifecycleAbortedError } from "../../server/lanes";
import { findLatestProvisionJob } from "../../server/provision";
import { PROVISIONING_STATE_DIR } from "../../shared/provisioning";
import type {
  SandboxHandleLike,
  SandboxJobInfoLike,
} from "../../server/sandbox";
import { fakeSandbox } from "./fake-runtime";

const INSTALL_ARGV = ["npm", "install", "-g", "some-package"];

function job(overrides: Partial<SandboxJobInfoLike> = {}): SandboxJobInfoLike {
  return {
    id: "job_1",
    command: INSTALL_ARGV,
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
        { id: "a", command: INSTALL_ARGV, state: "exited", exitCode: 0 },
        { id: "b", command: INSTALL_ARGV, state: "exited", exitCode: 1 },
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

  it("reports a still-running job instead of failing provisioning", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      jobs: [{ id: "job_1", command: INSTALL_ARGV, state: "running" }],
      jobStateAfterWait: "running",
    });

    await expect(waitForJob(handle, "job_1", 10)).resolves.toEqual({
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
    const pending = waitForJob(handle, "job_1", 60_000, controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(LifecycleAbortedError);
  });

  it("reports a confirmed non-zero exit as failed", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      jobs: [{ id: "job_1", command: INSTALL_ARGV, state: "exited", exitCode: 1 }],
    });

    await expect(waitForJob(handle, "job_1", 100)).resolves.toEqual({
      status: "failed",
      id: "job_1",
      exitCode: 1,
    });
  });
});

describe("provision job lookup", () => {
  it("finds a provision job launched under an older plan hash", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      jobs: [
        {
          id: "old",
          command: [
            "/bin/sh",
            `${PROVISIONING_STATE_DIR}/provision-0123456789abcdef.sh`,
            "0123456789abcdef",
          ],
          state: "exited",
          exitCode: 0,
        },
      ],
    });

    await expect(findLatestProvisionJob(handle)).resolves.toMatchObject({ id: "old" });
  });

  it("ignores jobs that are not provision scripts", async () => {
    const handle = fakeSandbox({
      id: "sandbox_1",
      name: "paseo-1",
      jobs: [
        { id: "pi", command: INSTALL_ARGV, state: "exited", exitCode: 0 },
        { id: "echo", command: ["echo"], state: "exited", exitCode: 0 },
      ],
    });

    await expect(findLatestProvisionJob(handle)).resolves.toBeNull();
  });
});
