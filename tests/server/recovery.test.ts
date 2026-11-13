import { describe, expect, it } from "vitest";
import { ERROR_LABEL, PHASE_LABEL } from "../../shared/constants";
import { safeError } from "../../shared/errors";
import { recoverManagedSandboxes, type RecoveryContext } from "../../server/recovery";
import {
  failingRuntime,
  fakeRuntime,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  PARENT_ID,
} from "./fake-runtime";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";

function recoveryContext(
  runtime: RecoveryContext["runtime"],
  hosts: FakePaseoHosts,
  overrides: Partial<RecoveryContext> = {},
): RecoveryContext {
  return {
    hosts,
    runtime,
    sandboxHost: new FakeSandboxCreator(),
    timeoutMs: 100,
    pollMs: 1,
    installTimeoutMs: 100,
    ...overrides,
  };
}

describe("recoverManagedSandboxes", () => {
  it("registers a Pi-ready sandbox whose registration is missing", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      hostPort: 42_000,
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(recoveryContext(fakeRuntime([sandbox]), hosts));

    expect(hosts.added).toEqual([
      {
        connection: "127.0.0.1:42000",
        label: `${PARENT_ID}/${NAME}`,
        metadata: { source: "paseo-msb", vm: "sandbox_1", name: NAME },
        sourceKey: "sandbox_1",
      },
    ]);
    expect(hosts.disposed).toBe(1);
    expect(labels).toContainEqual({ [PHASE_LABEL]: "ready" });
  });

  it("waits for the existing detached job instead of starting a second install", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      job: "job_7",
      jobState: "running",
      jobStateAfterWait: "exited",
      jobExitCode: 0,
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator();
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(creator.createCount).toBe(0);
    expect(creator.resumeCount).toBe(1);
    expect(creator.execSpecs.map((spec) => spec.command)).toEqual(["sh"]);
    expect(hosts.added).toHaveLength(1);
    expect(labels[0]).toEqual({ [PHASE_LABEL]: "registering" });
  });

  it("continues an install whose job already exited cleanly", async () => {
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      job: "job_7",
      jobState: "exited",
      jobExitCode: 0,
    });
    const creator = new FakeSandboxCreator();
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(hosts.added).toHaveLength(1);
    expect(creator.execSpecs.map((spec) => spec.command)).toEqual(["sh"]);
  });

  it("fails an install with no persisted job instead of replaying it", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator();
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(creator.createCount).toBe(0);
    expect(creator.resumeCount).toBe(0);
    expect(hosts.added).toEqual([]);
    expect(labels).toContainEqual({
      [PHASE_LABEL]: "failed",
      [ERROR_LABEL]: "install_failed",
    });
  });

  it("fails an install whose job is missing from the runtime", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      job: "job_7",
      getJobError: new Error("job missing"),
      labelUpdates: labels,
    });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), new FakePaseoHosts()),
    );

    expect(labels).toContainEqual({
      [PHASE_LABEL]: "failed",
      [ERROR_LABEL]: "install_failed",
    });
  });

  it("fails an install whose job exited non-zero", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      job: "job_7",
      jobState: "exited",
      jobExitCode: 1,
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(recoveryContext(fakeRuntime([sandbox]), hosts));

    expect(hosts.added).toEqual([]);
    expect(labels).toContainEqual({
      [PHASE_LABEL]: "failed",
      [ERROR_LABEL]: "install_failed",
    });
  });

  it("fails an install whose sandbox cannot be reconnected", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      job: "job_7",
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator({ resumeError: new Error("stopped") });
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(hosts.added).toEqual([]);
    expect(labels).toContainEqual({
      [PHASE_LABEL]: "failed",
      [ERROR_LABEL]: "install_failed",
    });
  });

  it("fails an install whose PATH check does not resolve Pi", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      job: "job_7",
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator({ execOutput: "/usr/bin/pi\n1.1.0\n" });
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(hosts.added).toEqual([]);
    expect(labels).toContainEqual({
      [PHASE_LABEL]: "failed",
      [ERROR_LABEL]: "path_unverified",
    });
  });

  it("fails a registering sandbox whose registration cannot be added", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({ addError: new Error("hosts.add failed") });

    await recoverManagedSandboxes(recoveryContext(fakeRuntime([sandbox]), hosts));

    expect(labels).toContainEqual({
      [PHASE_LABEL]: "failed",
      [ERROR_LABEL]: "registration_failed",
    });
  });

  it("fails a registering sandbox when Pi is not ready", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({ providerStatus: "loading" });

    await recoverManagedSandboxes(recoveryContext(fakeRuntime([sandbox]), hosts));

    expect(labels).toContainEqual({
      [PHASE_LABEL]: "failed",
      [ERROR_LABEL]: "provider_unavailable",
    });
  });

  it("marks a sandbox stuck in creating as failed", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "creating",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(recoveryContext(fakeRuntime([sandbox]), hosts));

    expect(labels).toContainEqual({
      [PHASE_LABEL]: "failed",
      [ERROR_LABEL]: "create_failed",
    });
    expect(hosts.added).toEqual([]);
  });

  it("leaves ready and failed sandboxes untouched", async () => {
    const readyLabels: Record<string, string>[] = [];
    const failedLabels: Record<string, string>[] = [];
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(
        fakeRuntime([
          fakeSandbox({ id: "sandbox_1", name: "paseo-ready", phase: "ready", labelUpdates: readyLabels }),
          fakeSandbox({
            id: "sandbox_2",
            name: "paseo-failed",
            phase: "failed",
            error: "install_failed",
            labelUpdates: failedLabels,
          }),
        ]),
        hosts,
      ),
    );

    expect(readyLabels).toEqual([]);
    expect(failedLabels).toEqual([]);
    expect(hosts.added).toEqual([]);
  });

  it("does nothing when registrations are unavailable", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({
      listError: new Error("registrations unavailable: leaked detail"),
    });

    await recoverManagedSandboxes(recoveryContext(fakeRuntime([sandbox]), hosts));

    expect(labels).toEqual([]);
    expect(hosts.added).toEqual([]);
  });

  it("does nothing when inventory is unavailable", async () => {
    const hosts = new FakePaseoHosts();

    await expect(
      recoverManagedSandboxes(recoveryContext(failingRuntime(), hosts)),
    ).resolves.toBeUndefined();

    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("does not leak raw failure text into labels", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      job: "job_7",
      getJobError: new Error("raw secret token leaked"),
      labelUpdates: labels,
    });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), new FakePaseoHosts()),
    );

    expect(JSON.stringify(labels)).not.toContain("raw secret token leaked");
    expect(JSON.stringify(labels)).not.toContain(safeError("install_failed").message);
  });
});
