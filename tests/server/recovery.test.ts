import { describe, expect, it } from "vitest";
import { PHASE_LABEL, REGISTRATION_PRODUCER_ID } from "../../shared/constants";
import { safeError } from "../../shared/errors";
import { createLifecycleLanes } from "../../server/lanes";
import { createPendingCreateStore } from "../../server/pending";
import { recoverManagedSandboxes, type RecoveryContext } from "../../server/recovery";
import {
  failingRuntime,
  fakeHostDirectory,
  fakeRegistration,
  fakeRuntime,
  fakeSandbox,
  FakePaseoHosts,
  FakeSandboxCreator,
  memorySecretsStore,
  PARENT_ID,
} from "./fake-runtime";

const NAME = "paseo-2f8f4c2e-8e52-4d0e-9db1-1a2b3c4d5e6f";
const PI_ARGV = [
  "npm",
  "install",
  "-g",
  "--ignore-scripts",
  "--prefix",
  "/home/paseo/.local",
  "@earendil-works/pi-coding-agent@1.1.0",
] as const;

function recoveryContext(
  runtime: RecoveryContext["runtime"],
  hosts: FakePaseoHosts,
  overrides: Partial<RecoveryContext> = {},
): RecoveryContext {
  return {
    hosts,
    runtime,
    sandboxHost: new FakeSandboxCreator(),
    env: {},
    pending: createPendingCreateStore(),
    secretsStore: memorySecretsStore(),
    lanes: createLifecycleLanes(),
    timeoutMs: 100,
    pollMs: 1,
    installTimeoutMs: 100,
    ...overrides,
  };
}

function ownedRegistration() {
  return fakeRegistration({
    registrationId: "reg_owned",
    label: `${PARENT_ID}/${NAME}`,
    source: { id: REGISTRATION_PRODUCER_ID, key: "sandbox_1" },
    metadata: { source: "paseo-msb", name: NAME },
  });
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
    const creator = new FakeSandboxCreator({ existing: sandbox });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(hosts.added).toEqual([
      {
        connection: "127.0.0.1:42000",
        label: `${PARENT_ID}/${NAME}`,
        metadata: { source: "paseo-msb", name: NAME },
        sourceKey: "sandbox_1",
      },
    ]);
    expect(hosts.disposed).toBe(1);
    expect(sandbox.config()).toMatchObject({ labels: { [PHASE_LABEL]: "ready" } });
  });

  it("waits for an existing detached install instead of starting another", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: "from-jobs",
      jobs: [{ id: "job_7", command: PI_ARGV, state: "running" }],
      jobStateAfterWait: "exited",
      jobWaitCode: 0,
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(creator.createCount).toBe(0);
    expect(creator.execSpecs).toEqual([]);
    expect(hosts.added).toHaveLength(1);
    expect(sandbox.config()).toMatchObject({ labels: { [PHASE_LABEL]: "ready" } });
  });

  it("starts an install when complete inventory has no matching job", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: "from-jobs",
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(creator.createCount).toBe(0);
    expect(creator.execSpecs).toHaveLength(1);
    expect(creator.execSpecs[0].command).toBe("npm");
    expect(hosts.added).toHaveLength(1);
    expect(sandbox.config()).toMatchObject({ labels: { [PHASE_LABEL]: "ready" } });
  });

  it("does not start an install when job inventory is unavailable", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: false,
      listJobsError: new Error("job inventory failed"),
      labelUpdates: labels,
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });
    const hosts = new FakePaseoHosts();

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(creator.execSpecs).toEqual([]);
    expect(hosts.added).toEqual([]);
    expect(sandbox.config()).toMatchObject({
      labels: { [PHASE_LABEL]: "installing", "paseo-msb-error": "job_inventory_unavailable" },
    });
  });

  it("records install_failed for a confirmed non-zero install", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: false,
      jobs: [{ id: "job_7", command: PI_ARGV, state: "exited", exitCode: 1 }],
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();
    const creator = new FakeSandboxCreator({ existing: sandbox });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(hosts.added).toEqual([]);
    expect(creator.execSpecs).toEqual([]);
    expect(sandbox.config()).toMatchObject({
      labels: { [PHASE_LABEL]: "installing", "paseo-msb-error": "install_failed" },
    });
  });

  it("records runtime_unavailable when the sandbox cannot be reconnected", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: false,
      connectError: new Error("stopped"),
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();
    const creator = new FakeSandboxCreator({ existing: sandbox });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(hosts.added).toEqual([]);
    expect(sandbox.config()).toMatchObject({
      labels: { [PHASE_LABEL]: "installing", "paseo-msb-error": "runtime_unavailable" },
    });
  });

  it("records path_unverified when Pi is not at the pinned path", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: true,
      execOutput: "/usr/bin/pi\n1.1.0\n",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();
    const creator = new FakeSandboxCreator({ existing: sandbox });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(hosts.added).toEqual([]);
    expect(sandbox.config()).toMatchObject({
      labels: { [PHASE_LABEL]: "installing", "paseo-msb-error": "path_unverified" },
    });
  });

  it("records registration_failed when the registration cannot be added", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({ addError: new Error("hosts.add failed") });
    const creator = new FakeSandboxCreator({ existing: sandbox });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(sandbox.config()).toMatchObject({
      labels: { [PHASE_LABEL]: "registering", "paseo-msb-error": "registration_failed" },
    });
  });

  it("records provider_unavailable when Pi is not ready", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "registering",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({ providerStatus: "loading" });
    const creator = new FakeSandboxCreator({ existing: sandbox });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(sandbox.config()).toMatchObject({
      labels: { [PHASE_LABEL]: "registering", "paseo-msb-error": "provider_unavailable" },
    });
  });

  it("recovers a sandbox left in creating instead of marking it failed", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "creating",
      piInstalled: "from-jobs",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts();
    const creator = new FakeSandboxCreator({ existing: sandbox });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(creator.execSpecs).toHaveLength(1);
    expect(hosts.added).toHaveLength(1);
    expect(sandbox.config()).toMatchObject({ labels: { [PHASE_LABEL]: "ready" } });
  });

  it("leaves a healthy ready sandbox untouched", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "ready",
      labelUpdates: labels,
    });
    const hosts = new FakePaseoHosts({
      directory: fakeHostDirectory([ownedRegistration()]),
    });
    const creator = new FakeSandboxCreator({ existing: sandbox });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), hosts, { sandboxHost: creator }),
    );

    expect(labels).toEqual([]);
    expect(hosts.added).toEqual([]);
  });

  it("throws when registrations are unavailable so the caller can retry", async () => {
    const sandbox = fakeSandbox({ id: "sandbox_1", name: NAME, phase: "ready" });
    const hosts = new FakePaseoHosts({
      listError: new Error("registrations unavailable: leaked detail"),
    });

    await expect(
      recoverManagedSandboxes(
        recoveryContext(fakeRuntime([sandbox]), hosts, {
          sandboxHost: new FakeSandboxCreator({ existing: sandbox }),
        }),
      ),
    ).rejects.toThrow();
  });

  it("throws when inventory is unavailable so the caller can retry", async () => {
    const hosts = new FakePaseoHosts();

    await expect(
      recoverManagedSandboxes(recoveryContext(failingRuntime(), hosts)),
    ).rejects.toThrow();

    expect(hosts.added).toEqual([]);
    expect(hosts.removed).toEqual([]);
  });

  it("does not leak raw failure text into labels", async () => {
    const labels: Record<string, string>[] = [];
    const sandbox = fakeSandbox({
      id: "sandbox_1",
      name: NAME,
      phase: "installing",
      piInstalled: false,
      listJobsError: new Error("raw secret token leaked"),
      labelUpdates: labels,
    });

    await recoverManagedSandboxes(
      recoveryContext(fakeRuntime([sandbox]), new FakePaseoHosts(), {
        sandboxHost: new FakeSandboxCreator({ existing: sandbox }),
      }),
    );

    expect(JSON.stringify(labels)).not.toContain("raw secret token leaked");
    expect(JSON.stringify(labels)).not.toContain(safeError("install_failed").message);
  });
});
